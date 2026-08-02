import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

import { checkRateLimit } from '../utils/rateLimiter';
import { resolveEntity } from '../utils/registryClient';
import { AUDIT_LOG_COLLECTION, buildAuditLogDocument } from '../utils/auditLog';

// ── Zod schema ────────────────────────────────────────────────────────────────

export const ApproveEmployerSchema = z.object({
  employerId: z.string().min(1, 'employerId is required'),
  decision: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().max(500).optional(),
  creditLimit: z.number().positive().max(500000).optional(),
  notes: z.string().max(1000).optional(),
});

export type ApproveEmployerInput = z.infer<typeof ApproveEmployerSchema>;

// ── Firestore types ───────────────────────────────────────────────────────────

export interface EmployerDocument {
  employerId: string;
  companyName: string;
  rfc: string;
  legalRepName: string;
  adminContactEmail: string;
  adminContactPhone: string;
  industry: string;
  employeeCount: number;
  estimatedMonthlyPayroll: number;
  payrollSystem: string;
  payFrequency: 'weekly' | 'biweekly' | 'monthly';
  address: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
  };
  status: 'pending_review' | 'approved' | 'rejected' | 'suspended';
  employerCode?: string;
  creditLimit?: number;
  currentOutstandingBalance: number;
  onboardingStep: number;
  integrationMethod?: 'api' | 'sftp' | 'manual';
  apiKeyHash?: string;
  approvedAt?: Timestamp;
  approvedBy?: string;
  rejectedAt?: Timestamp;
  rejectedBy?: string;
  rejectionReason?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// The audit document shape lives in utils/auditLog.ts (AuditLogEntry /
// buildAuditLogDocument). A local copy here is what let this module drift onto a
// second, unreadable collection in the first place — do not re-add one.

export interface ApproveEmployerResult {
  success: boolean;
  employerId: string;
  status: string;
  employerCode?: string;
  message: string;
}

// ── Redis / BullMQ singletons (lazy-initialised per function instance) ────────

let _redis: IORedis | null = null;

export function getRedisClient(): IORedis {
  if (!_redis) {
    _redis = new IORedis(process.env['REDIS_URL'] ?? '', {
      maxRetriesPerRequest: 3,
      tls: process.env['REDIS_URL']?.startsWith('rediss://')
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }
  return _redis;
}

export function getNotificationQueue(): Queue {
  const redisUrl = process.env['REDIS_URL'] ?? '';
  return new Queue('vida-notifications', {
    connection: {
      url: redisUrl,
      ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    },
  });
}

// ── Industry code lookup ──────────────────────────────────────────────────────

export const INDUSTRY_CODES: Record<string, string> = {
  manufacturing: 'MFG',
  logistics: 'LOG',
  retail: 'RET',
  technology: 'TEC',
  healthcare: 'HLT',
  construction: 'CON',
  food_beverage: 'FOD',
  automotive: 'AUT',
};

export function getIndustryCode(industry: string): string {
  return INDUSTRY_CODES[industry.toLowerCase()] ?? 'GEN';
}

// ── Employer code generation ──────────────────────────────────────────────────

/**
 * Generates a unique 8-character employer code.
 * Format: MX + 3-char industry code + 3-char alphanumeric random suffix.
 * e.g. "MXMFG3X7"
 */
export async function generateEmployerCode(
  db: FirebaseFirestore.Firestore,
  industry: string
): Promise<string> {
  const industryCode = getIndustryCode(industry);

  const makeCode = (): string => {
    const suffix = nanoid(3).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    return `MX${industryCode}${suffix}`;
  };

  let employerCode = makeCode();

  const existing = await db
    .collection('employers')
    .where('employerCode', '==', employerCode)
    .limit(1)
    .get();

  if (!existing.empty) {
    // Collision: generate a second attempt (probability ~1/46656, acceptable)
    employerCode = makeCode();
  }

  return employerCode;
}

// ── Core handler (exported for unit testing) ──────────────────────────────────

export async function approveEmployerHandler(
  request: {
    auth?: { uid: string; token: Record<string, unknown> };
    data: unknown;
  }
): Promise<ApproveEmployerResult> {
  const db = getFirestore();

  // ── 1. Auth check ──────────────────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  const adminUid = request.auth.uid;

  // Role check: accept JWT claim or Firestore document role
  const tokenRole = request.auth.token['role'] as string | undefined;
  const isLegacyAdmin = request.auth.token['admin'] === true;
  const hasJwtAdminRole =
    (tokenRole && ['admin', 'super_admin'].includes(tokenRole)) ||
    (isLegacyAdmin && !tokenRole);

  if (!hasJwtAdminRole) {
    // Fall back to Firestore role check for enhanced security
    const adminDoc = await db.collection('users').doc(adminUid).get();
    if (!adminDoc.exists || !['admin', 'super_admin'].includes(adminDoc.data()?.role ?? '')) {
      throw new HttpsError('permission-denied', 'Admin role required to approve employers.');
    }
  }

  // Rate limit: 20/min/uid (mutation)
  try {
    const allowed = await checkRateLimit(`rl:approveEmployer:${adminUid}`, 20, 60);
    if (!allowed) {
      throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
    }
  } catch (e: unknown) {
    if (e instanceof HttpsError) throw e;
    logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
  }

  // Fetch admin email for audit log (best-effort from token or Firestore)
  const adminEmail =
    (request.auth.token['email'] as string | undefined) ??
    (await db.collection('users').doc(adminUid).get()).data()?.email ??
    'unknown';

  // ── 2. Input validation ────────────────────────────────────────────────────
  const validation = ApproveEmployerSchema.safeParse(request.data);
  if (!validation.success) {
    throw new HttpsError('invalid-argument', validation.error.issues[0].message);
  }
  const { employerId, decision, rejectionReason, creditLimit, notes } = validation.data;

  if (decision === 'rejected' && !rejectionReason) {
    throw new HttpsError(
      'invalid-argument',
      'rejectionReason is required when rejecting an employer'
    );
  }

  // ── 3. Fetch employer ──────────────────────────────────────────────────────
  const employerRef = db.collection('employers').doc(employerId);
  const employerDoc = await employerRef.get();

  if (!employerDoc.exists) {
    throw new HttpsError('not-found', `Employer ${employerId} not found`);
  }
  const employer = employerDoc.data() as EmployerDocument;

  if (employer.status !== 'pending_review') {
    throw new HttpsError(
      'failed-precondition',
      `Employer is already in status: ${employer.status}. Can only approve/reject pending_review employers.`
    );
  }

  // ── 4. Generate employer code (approval only) ──────────────────────────────
  let employerCode: string | undefined;
  if (decision === 'approved') {
    employerCode = await generateEmployerCode(db, employer.industry);
  }

  // ── 5. Atomic Firestore update + audit log ─────────────────────────────────
  const now = Timestamp.now();

  const previousState: Partial<EmployerDocument> = {
    status: employer.status,
    updatedAt: employer.updatedAt,
  };

  const newFields: Partial<EmployerDocument> =
    decision === 'approved'
      ? {
          status: 'approved',
          employerCode,
          creditLimit: creditLimit ?? 500000,
          currentOutstandingBalance: 0,
          onboardingStep: 1,
          approvedAt: now,
          approvedBy: adminUid,
          updatedAt: now,
        }
      : {
          status: 'rejected',
          rejectedAt: now,
          rejectedBy: adminUid,
          rejectionReason,
          updatedAt: now,
        };

  const logRef = db.collection(AUDIT_LOG_COLLECTION).doc();
  const logEntry = buildAuditLogDocument(
    {
      action: `employer.${decision}`,
      actorUid: adminUid,
      actorRole: (request.auth.token['role'] as string | undefined) ?? 'admin',
      actorEmail: adminEmail,
      targetId: employerId,
      before: previousState as Record<string, unknown>,
      after: newFields as Record<string, unknown>,
      meta: { entityType: 'employer', notes: notes ?? null, creditLimit: creditLimit ?? null },
    },
    now
  );

  await db.runTransaction(async (txn) => {
    txn.update(employerRef, newFields as FirebaseFirestore.UpdateData<EmployerDocument>);
    txn.set(logRef, logEntry);
  });

  // ── 5a. Grant the employer_admin claim (approval only) ─────────────────────
  // This is the approval gate for the claim. onEmployerDocCreated deliberately
  // does not grant it on self-signup, so an employer becomes an employer_admin
  // here and nowhere else on the normal path.
  if (decision === 'approved') {
    try {
      await getAuth().setCustomUserClaims(employerId, { role: 'employer_admin' });
      logger.info('Granted employer_admin claim on approval', {
        employerId,
        approvedBy: adminUid,
        service: 'functions',
      });
    } catch (e: unknown) {
      // The employer is approved in Firestore either way; setEmployerClaims is
      // the admin-only retry path. Surfaced loudly because the employer cannot
      // use their dashboard until the claim lands.
      logger.error('Failed to grant employer_admin claim after approval', {
        employerId,
        error: (e as Error).message,
        service: 'functions',
      });
    }
  }

  // ── 5b. Shadow-write to the identity registry (Phase A, non-blocking) ──────
  // Only on approval: the entity rule is "signs, pays, gets paid, or is
  // sold" -- a rejected employer never does any of those. Best-effort only:
  // this is additive registry-building, not the source of truth yet, so a
  // failure here must never affect the approval itself.
  if (decision === 'approved') {
    try {
      await resolveEntity({
        system: 'firebase',
        externalId: employerId,
        kind: 'employer',
        displayName: employer.companyName,
        refs: employer.rfc ? [{ system: 'rfc', externalId: employer.rfc }] : undefined,
      });
    } catch (e: unknown) {
      logger.warn('Registry shadow-write failed', { error: (e as Error).message, employerId, service: 'functions' });
    }
  }

  // ── 6. Trigger notification to employer ────────────────────────────────────
  try {
    const queue = getNotificationQueue();
    const jobType = decision === 'approved' ? 'employer_approved' : 'employer_rejected';
    await queue.add(jobType, {
      type: jobType,
      employerId,
      employerCode,
      adminContactEmail: employer.adminContactEmail,
      companyName: employer.companyName,
      rejectionReason: decision === 'rejected' ? rejectionReason : undefined,
      timestamp: now.toMillis(),
    });
  } catch (e: unknown) {
    // Non-critical — notification failure must not block approval
    logger.warn('Notification queue unavailable', { error: (e as Error).message, service: 'functions' });
  }

  // ── 7. If approved: generate and store employer API key ────────────────────
  if (decision === 'approved') {
    try {
      const rawApiKey = `vida_emp_${nanoid(32)}`;
      const crypto = await import('crypto');
      const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');

      await employerRef.update({ apiKeyHash } as FirebaseFirestore.UpdateData<EmployerDocument>);

      // Store raw key in Redis temporarily (1 hour) for secure employer retrieval
      const redis = getRedisClient();
      await redis.setex(`employer:apikey:${employerId}`, 3600, rawApiKey);
    } catch (e: unknown) {
      // Non-critical — API key generation failure does not block approval
      logger.warn('API key generation failed', { error: (e as Error).message, service: 'functions' });
    }
  }

  return {
    success: true,
    employerId,
    status: decision,
    employerCode,
    message:
      decision === 'approved'
        ? `Employer approved. Code: ${employerCode}. Notification sent to ${employer.adminContactEmail}`
        : `Employer rejected. Notification sent to ${employer.adminContactEmail}`,
  };
}

// ── Exported Cloud Function ───────────────────────────────────────────────────

export const approveEmployer = onCall(
  {
    region: 'us-central1',
    enforceAppCheck: true,
    maxInstances: 5,
    memory: '256MiB',
    timeoutSeconds: 30,
  },
  approveEmployerHandler
);
