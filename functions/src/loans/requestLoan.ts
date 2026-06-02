// DEPRECATED / NOT DEPLOYED. The canonical, deployed `requestLoan` lives inline in
// functions/src/index.ts (it is the only one re-exported). This BullMQ-based variant
// is kept for its test suite and as the reference for a future queue-based migration,
// but it is not wired into index.ts exports. Do not assume this runs in production.
import { randomUUID } from 'crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { z } from 'zod';
import fetch from 'node-fetch';
import { checkRateLimit } from '../utils/rateLimiter';

// ─── Input Schema ─────────────────────────────────────────────────────────────

export const FLAT_FEE_RATE = 0.08;

export const ALLOWED_TERM_DAYS = [15, 30, 45, 60] as const;

export const RequestLoanSchema = z.object({
  amount: z
    .number()
    .positive('Amount must be positive')
    .max(5000, 'Maximum loan amount is MXN $5,000')
    .multipleOf(100, 'Amount must be in increments of MXN $100'),
  employerCode: z
    .string()
    .min(6, 'Invalid employer code')
    .max(12, 'Invalid employer code')
    .regex(/^[A-Z0-9]+$/, 'Invalid employer code format'),
  bankAccountClabe: z
    .string()
    .length(18, 'CLABE must be exactly 18 digits')
    .regex(/^\d{18}$/, 'CLABE must contain only digits'),
  termsAccepted: z.literal(true, {
    error: 'You must accept the terms and conditions',
  }),
  termDays: z
    .number()
    .refine((v): v is 15 | 30 | 45 | 60 => (ALLOWED_TERM_DAYS as readonly number[]).includes(v), {
      message: 'Term must be 15, 30, 45, or 60 days',
    })
    .optional()
    .default(30),
  loanPurpose: z
    .enum([
      'emergency',
      'medical',
      'education',
      'home_repair',
      'transportation',
      'debt_consolidation',
      'other',
    ])
    .optional(),
});

export type RequestLoanInput = z.infer<typeof RequestLoanSchema>;

// ─── Domain Types ─────────────────────────────────────────────────────────────

export type LoanStatus =
  | 'pending'
  | 'under_review'
  | 'approved'
  | 'disbursed'
  | 'repaid'
  | 'overdue'
  | 'in_collections'
  | 'written_off'
  | 'rejected'
  | 'cancelled';

export interface StatusChange {
  from: LoanStatus;
  to: LoanStatus;
  at: Timestamp;
  by: string;
  reason?: string;
}

export const TERMS_VERSION = 'v1.0';

export const ACTIVE_LOAN_STATUSES: LoanStatus[] = [
  'pending',
  'under_review',
  'approved',
  'disbursed',
];

// ─── CLABE Checksum Validation ────────────────────────────────────────────────
// Mexican CLABE: 18 digits, check digit computed with weights [3,7,1] repeating
// over the first 17 digits. check = (10 - (sum % 10)) % 10 must equal digit 18.

export function validateClabeChecksum(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += parseInt(clabe[i], 10) * weights[i % 3];
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(clabe[17], 10);
}

// ─── Redis Singleton ──────────────────────────────────────────────────────────

let _redis: IORedis | null = null;

export function getRedisClient(): IORedis {
  if (!_redis) {
    const redisUrl = process.env['REDIS_URL'] ?? '';
    _redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 3,
      tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    });
  }
  return _redis;
}

export function _resetRedisForTesting(): void {
  _redis = null;
}

// ─── Underwriting Queue ───────────────────────────────────────────────────────

export function getUnderwritingQueue(): Queue {
  const redisUrl = process.env['REDIS_URL'] ?? '';
  return new Queue('vida-underwriting', {
    connection: {
      url: redisUrl,
      ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    },
  });
}

// ─── Credit Bureau (SoftCrédito) ─────────────────────────────────────────────

export interface BureauResult {
  bureauScore: number | null;
  bureauDefaults: number | null;
  bureauDaysPastDue: number | null;
}

export async function fetchBureauScore(params: {
  curp: string;
  fullName: string;
  dateOfBirth: string;
  rfc: string;
}): Promise<BureauResult> {
  const baseUrl = process.env['SOFTCREDITO_ADAPTER_URL'];
  if (!baseUrl) {
    throw new Error('SOFTCREDITO_ADAPTER_URL not configured');
  }
  const res = await fetch(`${baseUrl}/bureau/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    timeout: 10_000,
  });
  if (!res.ok) {
    throw new Error(`Bureau query failed with status ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    bureauScore: (data['bureau_score'] as number) ?? null,
    bureauDefaults: (data['active_defaults'] as number) ?? null,
    bureauDaysPastDue: (data['days_past_due'] as number) ?? null,
  };
}

// ─── Core Handler (exported for testing) ─────────────────────────────────────

export async function handleRequestLoan(request: {
  auth?: { uid: string; token: Record<string, unknown> };
  data: unknown;
}): Promise<{ loanId: string; status: string; message: string }> {
  const db = getFirestore();

  // 1. Authentication check
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  const uid = request.auth.uid;

  // 2. Input validation via Zod
  const validationResult = RequestLoanSchema.safeParse(request.data);
  if (!validationResult.success) {
    const firstError = validationResult.error.issues[0];
    throw new HttpsError('invalid-argument', firstError.message, {
      field: firstError.path.join('.'),
      errors: validationResult.error.issues,
    });
  }
  const input: RequestLoanInput = validationResult.data;

  // 3. Rate limiting — 3 requests/day/user via Redis
  try {
    const allowed = await checkRateLimit(`rl:loan:${uid}`, 3, 86400);
    if (!allowed) {
      throw new HttpsError('resource-exhausted', 'Too many loan requests today');
    }
  } catch (e: unknown) {
    if (e instanceof HttpsError) throw e;
    logger.warn('Redis rate limit unavailable', { error: (e as Error).message, service: 'functions' });
  }

  // 4. Reject if borrower already has an active loan
  const activeLoanQuery = await db
    .collection('loans')
    .where('userId', '==', uid)
    .where('status', 'in', ACTIVE_LOAN_STATUSES)
    .limit(1)
    .get();

  if (!activeLoanQuery.empty) {
    const activeLoan = activeLoanQuery.docs[0].data();
    throw new HttpsError(
      'failed-precondition',
      'You have an active loan. Please repay it before requesting a new one.',
      { activeLoanId: activeLoan['loanId'] as string, status: activeLoan['status'] as string }
    );
  }

  // 5. Validate employer code against approved employers
  const employerQuery = await db
    .collection('employers')
    .where('employerCode', '==', input.employerCode)
    .where('status', '==', 'approved')
    .limit(1)
    .get();

  if (employerQuery.empty) {
    throw new HttpsError(
      'not-found',
      'Invalid employer code. Please verify with your HR department.'
    );
  }
  const employer = employerQuery.docs[0].data();

  // 6. Validate borrower profile and KYC status
  const borrowerDoc = await db.collection('users').doc(uid).get();
  if (!borrowerDoc.exists) {
    throw new HttpsError('not-found', 'User profile not found. Complete onboarding first.');
  }
  const borrower = borrowerDoc.data()!;

  if (borrower['kycStatus'] !== 'verified') {
    throw new HttpsError(
      'failed-precondition',
      'Identity verification required before requesting a loan.',
      { kycStatus: borrower['kycStatus'] as string }
    );
  }

  if (borrower['employerId'] !== employer['employerId']) {
    throw new HttpsError(
      'permission-denied',
      'Employer code does not match your registered employer.'
    );
  }

  // 7. Salary cap enforcement — max 30% of monthly salary, hard cap MXN $5,000
  const monthlySalary = borrower['monthlySalary'] as number;
  const maxAllowedAmount = Math.floor((monthlySalary * 0.3) / 100) * 100;
  const cappedMax = Math.min(maxAllowedAmount, 5000);

  if (input.amount > cappedMax) {
    throw new HttpsError(
      'invalid-argument',
      `Maximum loan amount is MXN $${cappedMax} (30% of your monthly salary of MXN $${monthlySalary}).`,
      { maxAmount: cappedMax, requestedAmount: input.amount }
    );
  }

  // 8. CLABE bank account checksum validation
  if (!validateClabeChecksum(input.bankAccountClabe)) {
    throw new HttpsError(
      'invalid-argument',
      'Invalid CLABE account number. Please verify with your bank.',
      { field: 'bankAccountClabe' }
    );
  }

  // 9. Credit bureau check via SoftCrédito (non-blocking — failure logged, not thrown)
  let bureauResult: BureauResult = { bureauScore: null, bureauDefaults: null, bureauDaysPastDue: null };
  try {
    bureauResult = await fetchBureauScore({
      curp: borrower['curp'] as string,
      fullName: borrower['fullName'] as string,
      dateOfBirth: borrower['dateOfBirth'] as string,
      rfc: borrower['rfc'] as string,
    });
  } catch (e: unknown) {
    logger.warn('Credit bureau check unavailable — continuing without bureau data', {
      error: (e as Error).message,
      userId: uid,
      service: 'functions',
    });
  }

  // 10. Write loan document to Firestore
  const loanRef = db.collection('loans').doc();
  const loanId = loanRef.id;
  const correlationId = randomUUID();
  const now = Timestamp.now();
  const feeAmount = Math.round(input.amount * FLAT_FEE_RATE);

  const statusHistory: StatusChange[] = [
    {
      from: 'pending',
      to: 'pending',
      at: now,
      by: 'system',
      reason: 'Loan application submitted',
    },
  ];

  await loanRef.set({
    loanId,
    correlationId,
    userId: uid,
    employerId: employer['employerId'] as string,
    employerCode: input.employerCode,
    principalAmount: input.amount,
    feeAmount,
    totalRepaymentAmount: input.amount + feeAmount,
    disbursementAmount: input.amount,
    termDays: input.termDays,
    currency: 'MXN',
    status: 'pending' as LoanStatus,
    statusHistory,
    borrowerSnapshot: {
      fullName: borrower['fullName'] as string,
      curpHash: borrower['curpHash'] as string,
      monthlySalary: borrower['monthlySalary'] as number,
      payFrequency: borrower['payFrequency'] as string,
      employmentTenureMonths: borrower['employmentTenureMonths'] as number,
      employerName: employer['name'] as string,
      employerIndustry: employer['industry'] as string,
    },
    bureauScore: bureauResult.bureauScore,
    bureauDefaults: bureauResult.bureauDefaults,
    bureauDaysPastDue: bureauResult.bureauDaysPastDue,
    bankAccountClabe: input.bankAccountClabe,
    loanPurpose: input.loanPurpose ?? null,
    termsVersion: TERMS_VERSION,
    termsAcceptedAt: now,
    requestedAt: now,
    updatedAt: now,
  });

  // 11. Dispatch to underwriting queue (non-blocking — failure logged, not thrown)
  try {
    const queue = getUnderwritingQueue();
    await queue.add('underwrite_loan', {
      loanId,
      correlationId,
      userId: uid,
      principalAmount: input.amount,
      employerId: employer['employerId'] as string,
      monthlySalary: borrower['monthlySalary'] as number,
      payFrequency: borrower['payFrequency'] as string,
      employmentTenureMonths: borrower['employmentTenureMonths'] as number,
      bankAccountClabe: input.bankAccountClabe,
      requestedAt: now.toDate().toISOString(),
    });
  } catch (e: unknown) {
    logger.warn('Underwriting queue unavailable', { error: (e as Error).message, correlationId, loanId, service: 'functions' });
  }

  return {
    loanId,
    status: 'pending',
    message: 'Loan application submitted successfully. You will be notified once reviewed.',
  };
}

// ─── Cloud Function Export ────────────────────────────────────────────────────

export const requestLoan = onCall(
  {
    region: 'us-central1',
    enforceAppCheck: true,
    maxInstances: 10,
    memory: '256MiB',
    timeoutSeconds: 30,
  },
  handleRequestLoan
);
