import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
// import { beforeUserCreated } from 'firebase-functions/v2/identity'; // DISABLED
import * as admin from 'firebase-admin';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import fetch from 'node-fetch';
import { nanoid } from 'nanoid';
import { Queue } from 'bullmq';

import { withAuth } from './middleware/authMiddleware';
import { withErrorHandling, VidaErrorCode } from './utils/errorHandler';
import { checkRateLimit } from './utils/rateLimiter';
import { notifyLoanEvent } from './utils/notify';
import { sendSlackAlert } from './utils/slackAlert';
import { initSentry } from './utils/sentry';

initSentry();

// Re-export fully-implemented cloud functions from their own modules
export { markLoanDisbursed } from './loans/markLoanDisbursed';
export { getContractDownloadUrl } from './loans/getContractDownloadUrl';
export { generatePaymentLink } from './payments/generatePaymentLink';
export { setAdminClaim, revokeAdminClaim } from './admin/adminClaims';
export { getSystemHealth } from './admin/getSystemHealth';
export { sendVerificationEmail } from './auth/sendVerificationEmail';
export { sendEmployeeInvite, lookupInvite, acceptInvite } from './invites';
export { metamapWebhook } from './webhooks';
export { onContactCreated } from './contact/onContactCreated';


initializeApp();
const db = getFirestore();

function getQueue(name: string): Queue {
  const redisUrl = process.env['REDIS_URL'] ?? '';
  if (!redisUrl) throw new Error('REDIS_URL not configured — queue unavailable');
  return new Queue(name, {
    connection: {
      url: redisUrl,
      ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    },
  });
}

// ── Internal utilities ───────────────────────────────────────────────────────

interface AuditLogEntry {
  action: string;
  actorUid: string;
  actorRole: string;
  targetId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
}

async function auditLog(database: FirebaseFirestore.Firestore, entry: AuditLogEntry): Promise<void> {
  await database.collection('audit_log').add({
    action: entry.action,
    actorUid: entry.actorUid,
    actorRole: entry.actorRole,
    targetCollection: entry.action.split('.')[0],
    targetId: entry.targetId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    meta: entry.meta ?? {},
    timestamp: FieldValue.serverTimestamp(),
  });
}

async function callML(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = process.env['ML_SERVICE_URL'];
  if (!url) throw new Error('ML_SERVICE_URL not configured');
  const r = await fetch(url + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '',
    },
    body: JSON.stringify(body),
     
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`ML ${path}: ${r.status}`);
  return r.json() as Promise<Record<string, unknown>>;
}

// ── autoVerifyTestAccounts — auto-verify @vida-test.com on signup ────────────

// DISABLED: requires Identity Platform (GCIP)
// export const autoVerifyTestAccounts = beforeUserCreated((event) => {
//   const user = event.data;
//   if (user?.email && user.email.endsWith('@vida-test.com')) {
//     return { emailVerified: true };
//   }
//   return {};
// });

// ── api — health endpoint ────────────────────────────────────────────────────

export const api = onRequest({ cors: true }, async (req, res) => {
  if (req.path === '/health' || req.path === '/api/health') {
    res.json({ status: 'ok', service: 'vida-finance', timestamp: new Date().toISOString() });
    return;
  }
  res.status(404).json({ error: 'Not found' });
});

// ── checkEmailAvailability — unauthenticated (used during registration) ──────

export const checkEmailAvailability = onCall(
  { cors: true, enforceAppCheck: true },
  async (request): Promise<{ available: boolean }> => {
    // Rate limit: 30 requests/min keyed on App Check token (unauth endpoint)
    const appCheckToken = (request as unknown as { app?: { appId?: string } }).app?.appId ?? 'anonymous';
    try {
      const allowed = await checkRateLimit(`rl:checkEmailAvailability:${appCheckToken}`, 30, 60);
      if (!allowed) {
        throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
      }
    } catch (e: unknown) {
      if (e instanceof HttpsError) throw e;
      logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
    }

    const email = (request.data as { email?: string })?.email;
    if (!email || typeof email !== 'string') {
      throw new HttpsError('invalid-argument', 'Email required');
    }
    try {
      await admin.auth().getUserByEmail(email);
      return { available: false };
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'auth/user-not-found') {
        return { available: true };
      }
      // Any other error — don't block registration
      return { available: true };
    }
  }
);

// ── validateCURP — unauthenticated (used during registration) ────────────────

interface ValidateCURPData {
  curp: string;
  expectedName?: string;
  email?: string;
}

interface ValidateCURPResult {
  valid: boolean;
  fullName?: string;
  dateOfBirth?: string;
  gender?: 'M' | 'F';
  matchesExpectedName?: boolean;
}

const CURP_REGEX = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/;

export const validateCURP = onCall(
  { cors: true, enforceAppCheck: true },
  async (request): Promise<ValidateCURPResult> => {
    // Rate limit: 10/min keyed on App Check token (unauth + expensive external call)
    const appCheckToken = (request as unknown as { app?: { appId?: string } }).app?.appId ?? 'anonymous';
    try {
      const allowed = await checkRateLimit(`rl:validateCURP:${appCheckToken}`, 10, 60);
      if (!allowed) {
        throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
      }
    } catch (e: unknown) {
      if (e instanceof HttpsError) throw e;
      logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
    }

    const { curp, expectedName, email } = (request.data ?? {}) as ValidateCURPData;

    if (!curp || typeof curp !== 'string' || !CURP_REGEX.test(curp.toUpperCase())) {
      throw new HttpsError('invalid-argument', 'Invalid CURP format');
    }

    // Test-mode bypass: if expectedName contains @vida-test.com email context, auto-approve
    if (curp.toUpperCase().startsWith('VIDA') || (email && email.endsWith('@vida-test.com'))) {
      logger.info('Test-mode CURP bypass', { curp });
      return {
        valid: true,
        fullName: expectedName || 'Test Employee',
        dateOfBirth: '1990-01-15',
        gender: curp[10] === 'H' ? 'M' : 'F',
      };
    }

    const adapterUrl = process.env['SOFTCREDITO_ADAPTER_URL'];
    if (!adapterUrl) {
      // Graceful fallback: accept CURP by format if adapter not configured
      logger.warn('CURP adapter not configured, accepting by format', { curp: curp.toUpperCase() });
      return {
        valid: true,
        fullName: expectedName || undefined,
        gender: curp.toUpperCase()[10] === 'H' ? 'M' : 'F',
      };
    }

    try {
      const resp = await fetch(`${adapterUrl}/curp/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '',
        },
        body: JSON.stringify({
          curp: curp.toUpperCase(),
          ...(expectedName ? { expectedName } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        logger.warn('CURP adapter error, accepting by format', { status: resp.status, body: body.slice(0, 100) });
        return {
          valid: true,
          fullName: expectedName || undefined,
          gender: curp.toUpperCase()[10] === 'H' ? 'M' : 'F',
        };
      }

      const result = await resp.json() as Record<string, unknown>;

      return {
        valid: result['valid'] === true,
        fullName: typeof result['fullName'] === 'string' ? result['fullName'] : undefined,
        dateOfBirth: typeof result['dateOfBirth'] === 'string' ? result['dateOfBirth'] : undefined,
        gender: result['gender'] === 'M' || result['gender'] === 'F' ? result['gender'] : undefined,
        matchesExpectedName: typeof result['matchesExpectedName'] === 'boolean' ? result['matchesExpectedName'] : undefined,
      };
    } catch (e: unknown) {
      logger.warn('CURP validation service unavailable, accepting by format', { error: (e as Error).message });
      return {
        valid: true,
        fullName: expectedName || undefined,
        gender: curp.toUpperCase()[10] === 'H' ? 'M' : 'F',
      };
    }
  }
);

// ── requestLoan — employee only ──────────────────────────────────────────────

interface RequestLoanData {
  amount: number;
  term: number;
}

export const requestLoan = onCall(
  // Existing rate limit is 3/day/uid — intentionally stricter than the 20/min mutation default.
  { cors: true, enforceAppCheck: true },
  withAuth<RequestLoanData, { loanId: string; status: string; total: number; dueDate: string }>(
    ['employee'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'requestLoan', uid: auth.uid }, async () => {
        const { amount, term } = data;
        const uid = auth.uid;

        // Rate limit: max 3 requests per day via Redis
        try {
          const allowed = await checkRateLimit(`rl:loan:${uid}`, 3, 86400);
          if (!allowed) throw new HttpsError('resource-exhausted', 'Too many loan requests today');
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Redis rate limit unavailable', { error: (e as Error).message, service: 'functions' });
        }

        if (typeof amount !== 'number' || amount < 500 || amount > 5000)
          throw new HttpsError('invalid-argument', 'El monto debe estar entre $500 y $5,000 MXN');
        if (term !== 30) throw new HttpsError('invalid-argument', 'Plazo inválido');

        const empRef = db.collection('employees').doc(uid);
        const emplDoc = await empRef.get();
        if (!emplDoc.exists) throw new HttpsError('not-found', VidaErrorCode.EMPLOYEE_NOT_FOUND);
        const emp = emplDoc.data()!;

        if (amount > emp['availableCredit'])
          throw new HttpsError('invalid-argument', 'El monto excede tu crédito disponible');
        if (amount > Math.round(emp['monthlySalary'] * 0.3))
          throw new HttpsError('invalid-argument', 'El monto excede el 30% de tu salario mensual');

        const active = await db
          .collection('loans')
          .where('employeeId', '==', uid)
          .where('status', 'in', ['pending', 'under_review', 'approved', 'disbursement_queued', 'active'])
          .limit(1)
          .get();
        if (!active.empty)
          throw new HttpsError('failed-precondition', VidaErrorCode.DUPLICATE_LOAN_APPLICATION);

        const employerSnap = await db.collection('employers').doc(emp['employerId']).get();
        const employer = employerSnap.data() ?? {};

        if (employer['status'] !== 'active' && employer['status'] !== 'pending_verification')
          throw new HttpsError('failed-precondition', VidaErrorCode.EMPLOYER_NOT_APPROVED);

        const loanId = nanoid();
        const fee = Math.round(amount * 0.3);
        const dueDate = Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

        // Try full underwriting pipeline first
        const uwUrl = process.env['UNDERWRITING_SERVICE_URL'];
        const intSecret = process.env['INTERNAL_SECRET'] ?? '';
        let uwDecision: string | null = null;
        let uwResult: Record<string, unknown> | null = null;

        if (uwUrl && intSecret) {
          try {
            const uwRes = await fetch(uwUrl + '/underwrite', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-internal-secret': intSecret },
              body: JSON.stringify({
                applicant: { curp: emp['curp'] || '', fullName: emp['fullName'] || emp['name'] || '', rfc: emp['rfc'] || '' },
                employer: { rfc: employer['rfc'] || '', companyName: employer['companyName'] || '' },
                loanAmount: amount,
              }),
              signal: AbortSignal.timeout(30000),
            });
            if (uwRes.ok) {
              uwResult = await uwRes.json() as Record<string, unknown>;
              uwDecision = uwResult['decision'] as string;
              logger.info('UW pipeline', { decision: uwDecision, correlationId: uwResult['correlationId'], service: 'functions' });
            }
          } catch (e: unknown) {
            logger.warn('UW service unavailable, fallback to inline ML', { error: (e as Error).message, service: 'functions' });
          }
        }

        const loanExtra: Record<string, unknown> = {};
        try {
          const ml = await callML('/underwrite/employee', {
            employeeId: uid,
            monthlySalary: emp['monthlySalary'] ?? 0,
            employerTier: employer['riskTier'] ?? 2,
            existingLoans: 0,
            bankClabe: emp['bankClabe'] ?? null,
            amount,
            requestsLastHour: 0,
          });
          if (ml['fraud'] && (ml['fraud'] as Record<string, unknown>)['is_fraud'])
            throw new HttpsError('permission-denied', 'Solicitud marcada como sospechosa');
          if ((ml['default_probability'] as number) > 0.4)
            throw new HttpsError('failed-precondition', 'No es posible aprobar tu solicitud en este momento');
          Object.assign(loanExtra, {
            mlDecisionId: ml['decisionId'],
            mlCreditScore: ml['credit_score'],
            mlDefaultProb: ml['default_probability'],
          });
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('ML unavailable', { error: (e as Error).message, service: 'functions' });
        }

        // Apply the underwriting pipeline decision to the loan's initial status.
        //   rejected      → rejected (no credit hold; show denial in UI)
        //   pending_review → under_review (Stage 5 already wrote a review_queue entry)
        //   approved       → approved (rare in pilot; ML_MODE=manual_review_all routes
        //                    everything non-rejected to review). NOTE: a loan created
        //                    directly as 'approved' does not fire onLoanApproved (that
        //                    trigger is on the pending→approved transition); the
        //                    ops/employer approval flow performs the transition that
        //                    triggers disbursement.
        //   null (UW down) → pending (legacy behavior preserved)
        let initialStatus = 'pending';
        const decisionExtra: Record<string, unknown> = {};
        if (uwDecision === 'rejected') {
          initialStatus = 'rejected';
          decisionExtra['denialReason'] =
            (uwResult?.['reason'] as string) ||
            'Tu solicitud no cumple los criterios de aprobación en este momento.';
          decisionExtra['deniedAt'] = FieldValue.serverTimestamp();
        } else if (uwDecision === 'approved') {
          initialStatus = 'approved';
        } else if (uwDecision === 'pending_review') {
          initialStatus = 'under_review';
        }
        const holdCredit = initialStatus !== 'rejected';

        await db.runTransaction(async (tx) => {
          if (holdCredit) tx.update(empRef, { availableCredit: FieldValue.increment(-amount) });
          tx.set(db.collection('loans').doc(loanId), {
            employeeId: uid,
            employeeName: emp['name'],
            employeeEmail: emp['email'],
            employeePhone: emp['phone'] ?? null,
            employerId: emp['employerId'],
            employerName: emp['employerName'] || emp['companyName'] || employer['companyName'] || '',
            employerCode: employer['employerCode'],
            amount,
            fee,
            total: amount + fee,
            term: 30,
            status: initialStatus,
            dueDate,
            disbursedAt: null,
            disbursementRef: null,
            disbursementError: null,
            paidAt: null,
            paidAmount: null,
            repaymentRef: null,
            conektaOrderId: null,
            paymentUrl: null,
            paymentLinkGeneratedAt: null,
            overdueDetectedAt: null,
            softcreditoDeductionId: null,
            contractUrl: null,
            receiptUrl: null,
            ...loanExtra,
            ...decisionExtra,
            uwCorrelationId: uwResult?.['correlationId'] ?? null,
            uwDecision: uwDecision ?? null,
            uwLastStage: uwResult?.['lastStage'] ?? null,
            createdAt: FieldValue.serverTimestamp(),
            acceptedAt: FieldValue.serverTimestamp(),
          });
        });

        try {
          await auditLog(db, { action: 'loan.requested', actorUid: uid, actorRole: 'employee', targetId: loanId });
        } catch (_) { /* non-critical */ }

        return { loanId, status: initialStatus, total: amount + fee, dueDate: dueDate.toDate().toISOString() };
      })
  )
);

// ── updateLoanStatus — employer approve/reject; ops/admin any status ─────────
// Replaces the insecure direct Firestore write that loans rules previously allowed.

interface UpdateLoanStatusData {
  loanId: string;
  status: string;
  note?: string;
}

export const updateLoanStatus = onCall(
  { cors: true, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    return withErrorHandling({ functionName: 'updateLoanStatus', uid: request.auth.uid }, async () => {
      // Rate limit: 20/min/uid (mutation)
      try {
        const allowed = await checkRateLimit(`rl:updateLoanStatus:${request.auth!.uid}`, 20, 60);
        if (!allowed) {
          throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
        }
      } catch (e: unknown) {
        if (e instanceof HttpsError) throw e;
        logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
      }

      const { loanId, status, note } = request.data as UpdateLoanStatusData;

      if (!loanId || !status) throw new HttpsError('invalid-argument', 'loanId and status are required');

      const uid = request.auth!.uid;
      const token = request.auth!.token;
      const role = token['role'] as string | undefined;
      const isAdminOrOps =
        token['admin'] === true ||
        role === 'admin' ||
        role === 'super_admin' ||
        role === 'ops';

      const loanSnap = await db.collection('loans').doc(loanId).get();
      if (!loanSnap.exists) throw new HttpsError('not-found', 'Loan not found');
      const loan = loanSnap.data()!;

      if (!isAdminOrOps) {
        // Employers may only approve or reject their own pending loans
        if (loan['employerId'] !== uid) {
          throw new HttpsError('permission-denied', 'Not authorized for this loan');
        }
        if (loan['status'] !== 'pending') {
          throw new HttpsError('failed-precondition', 'Loan is not in pending status');
        }
        if (!['approved', 'rejected'].includes(status)) {
          throw new HttpsError('invalid-argument', 'Employers may only approve or reject pending loans');
        }
      }

      const update: Record<string, unknown> = { status };
      if (note) update['statusNote'] = note;
      await db.collection('loans').doc(loanId).update(update);

      try {
        await auditLog(db, {
          action: `loan.${status}`,
          actorUid: uid,
          actorRole: role ?? (isAdminOrOps ? 'admin' : 'employer'),
          targetId: loanId,
          before: { status: loan['status'] },
          after: { status },
        });
      } catch (_) { /* non-critical */ }

      return { success: true, loanId, status };
    });
  }
);

// markLoanDisbursed is exported from ./loans/markLoanDisbursed

// generatePaymentLink is exported from ./payments/generatePaymentLink

// ── approveEmployer — admin only ─────────────────────────────────────────────

interface ApproveEmployerData {
  employerUid: string;
}

export const approveEmployer = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<ApproveEmployerData, { success: boolean; approved: boolean; reason?: string }>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'approveEmployer', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation)
        try {
          const allowed = await checkRateLimit(`rl:approveEmployer:${auth.uid}`, 20, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        const { employerUid } = data;
        if (!employerUid) throw new HttpsError('invalid-argument', 'employerUid is required');

        const empDoc = await db.collection('employers').doc(employerUid).get();
        if (!empDoc.exists) throw new HttpsError('not-found', 'Employer not found');
        const emp = empDoc.data()!;

        await db.collection('employers').doc(employerUid).update({
          status: 'active',
          activatedAt: FieldValue.serverTimestamp(),
        });

        try {
          const ml = await callML('/underwrite/employer', {
            employerUid,
            companyName: emp['companyName'],
            companySize: emp['companySize'],
            payrollSystem: emp['payrollSystem'],
            yearsActive: emp['yearsActive'] ?? 0,
            satStatus: emp['satStatus'] ?? 'unknown',
            industry: emp['industry'] ?? 'unknown',
          });

          await db.collection('employers').doc(employerUid).update({
            riskTier: ml['risk_tier'],
            mlScore: ml['score'],
            mlDecisionId: ml['decisionId'],
            llmAnalysis: ml['llm_analysis'],
            mlScoredAt: FieldValue.serverTimestamp(),
          });

          if (ml['reject'] && !(ml['llm_analysis'] as Record<string, unknown>)?.['escalate_to_human']) {
            await db.collection('employers').doc(employerUid).update({ status: 'rejected_ml' });
            return { approved: false, success: false, reason: 'No cumple requisitos de riesgo' };
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('ML scoring unavailable', { error: (e as Error).message, service: 'functions' });
        }

        try {
          await fetch(process.env['SOFTCREDITO_ADAPTER_URL'] + '/internal/register-employer', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '',
            },
            body: JSON.stringify({
              employerUid,
              companyName: emp['companyName'],
              rfc: emp['rfc'] ?? null,
              clabe: emp['bankClabe'] ?? null,
              contactEmail: emp['email'],
            }),
          });
        } catch (e: unknown) {
          logger.warn('SoftCrédito registration warning', { error: (e as Error).message, service: 'functions' });
        }

        try {
          await getQueue('vida-notifications').add('employer_activated', {
            type: 'employer_activated',
            employerUid,
            email: emp['email'],
            name: emp['name'],
            companyName: emp['companyName'],
            employerCode: emp['employerCode'],
          });
        } catch (e: unknown) {
          logger.warn('Notification queue unavailable', { error: (e as Error).message, service: 'functions' });
        }

        try {
          await auditLog(db, {
            action: 'employer.approved',
            actorUid: auth.uid,
            actorRole: auth.role,
            targetId: employerUid,
          });
        } catch (_) { /* non-critical */ }

        await notifyLoanEvent('employer_approved', { employerEmail: emp['email'], employerName: emp['companyName'] }).catch(() => {});

        return { success: true, approved: true };
      })
  )
);

// setAdminClaim and revokeAdminClaim are exported from ./admin/adminClaims

// ── getPortfolioReport — admin only ──────────────────────────────────────────

export const getPortfolioReport = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<Record<string, never>, Record<string, unknown>>(
    ['admin', 'super_admin', 'ops'],
    async (_data, auth) =>
      withErrorHandling({ functionName: 'getPortfolioReport', uid: auth.uid }, async () => {
        // Rate limit: 10/min/uid (expensive aggregation across all loans)
        try {
          const allowed = await checkRateLimit(`rl:getPortfolioReport:${auth.uid}`, 10, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        // Use same query pattern as getAdminDashboard (which works)
        const [activeSnap, pendingSnap, repaidSnap, allSnap] = await Promise.all([
          db.collection('loans').where('status', '==', 'active').get(),
          db.collection('loans').where('status', '==', 'pending').get(),
          db.collection('loans').where('status', '==', 'repaid').get(),
          db.collection('loans').where('status', '==', 'disbursed').get(),
        ]);

        const totalLoans = activeSnap.size + pendingSnap.size + repaidSnap.size + allSnap.size;
        let totalDisbursed = 0;
        let totalRepaid = 0;
        let totalRevenue = 0;
        const byStatus: Record<string, number> = {
          active: activeSnap.size,
          pending: pendingSnap.size,
          repaid: repaidSnap.size,
          disbursed: allSnap.size,
        };
        const byEmployer: Record<string, { count: number; volume: number }> = {};

        const allDocs = [...activeSnap.docs, ...pendingSnap.docs, ...repaidSnap.docs, ...allSnap.docs];
        for (const doc of allDocs) {
          const d = doc.data();
          const amt = Number(d.amount) || 0;
          totalDisbursed += amt;
          if (d.status === 'repaid') {
            totalRepaid += amt;
            totalRevenue += Number(d.fee || d.commission) || 0;
          }
          const eid = String(d.employerId || 'unknown');
          if (!byEmployer[eid]) byEmployer[eid] = { count: 0, volume: 0 };
          byEmployer[eid].count++;
          byEmployer[eid].volume += amt;
        }

        return {
          period: 'all',
          summary: {
            totalLoans,
            totalDisbursedMXN: totalDisbursed,
            totalRepaidMXN: totalRepaid,
            totalRevenueMXN: totalRevenue,
            defaultRate: '0%',
          },
          byStatus,
          byEmployer,
          generatedAt: new Date().toISOString(),
        };
      })
  )
);


// ── getAdminDashboard — ops/admin only ───────────────────────────────────────

export const getAdminDashboard = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<Record<string, never>, Record<string, unknown>>(
    ['admin', 'super_admin', 'ops'],
    async (_data, auth) =>
      withErrorHandling({ functionName: 'getAdminDashboard', uid: auth.uid }, async () => {
        // Rate limit: 60/min/uid (read-only dashboard)
        try {
          const allowed = await checkRateLimit(`rl:getAdminDashboard:${auth.uid}`, 60, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        const [healthDoc, queueDoc, pendingLoans, activeLoans, employers, employees, allLoans] = await Promise.all([
          db.collection('system_health').doc('current').get(),
          db.collection('system_health').doc('queues').get(),
          db.collection('loans').where('status', '==', 'pending').get(),
          db.collection('loans').where('status', '==', 'active').get(),
          db.collection('employers').get(),
          db.collection('employees').get(),
          db.collection('loans').get(),
        ]);
        let totalDisbursed = 0;
        allLoans.docs.forEach(d => {
          const s = d.data()['status'];
          if (s === 'active' || s === 'repaid' || s === 'status_repaid' || s === 'completed') {
            totalDisbursed += (d.data()['amount'] as number) || 0;
          }
        });
        return {
          systemHealth: healthDoc.data() ?? {},
          queues: queueDoc.data() ?? {},
          pendingLoans: pendingLoans.size,
          activeLoans: activeLoans.size,
          stats: {
            totalEmployers: employers.size,
            totalEmployees: employees.size,
            activeLoans: activeLoans.size,
            pendingLoans: pendingLoans.size,
            totalDisbursed,
          },
        };
      })
  )
);

// ── getEmployerDashboard — employer only ─────────────────────────────────────

export const getEmployerDashboard = onCall(
  { cors: true, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    return withErrorHandling({ functionName: 'getEmployerDashboard', uid: request.auth.uid }, async () => {
      // Rate limit: 60/min/uid (read-only dashboard)
      try {
        const allowed = await checkRateLimit(`rl:getEmployerDashboard:${request.auth!.uid}`, 60, 60);
        if (!allowed) {
          throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
        }
      } catch (e: unknown) {
        if (e instanceof HttpsError) throw e;
        logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
      }

      const uid = request.auth!.uid;

      const [empDoc, loans, employees] = await Promise.all([
        db.collection('employers').doc(uid).get(),
        db.collection('loans').where('employerId', '==', uid).orderBy('createdAt', 'desc').limit(50).get(),
        db.collection('employees').where('employerId', '==', uid).get(),
      ]);

      if (!empDoc.exists) throw new HttpsError('not-found', 'Employer not found');

      return {
        employer: empDoc.data(),
        loans: loans.docs.map((d) => ({ id: d.id, ...d.data() })),
        employeeCount: employees.size,
      };
    });
  }
);

// ── submitReviewDecision — ops/admin Stage 5 review action ───────────────────

interface SubmitReviewDecisionData {
  reviewId: string;
  decision: 'approved' | 'rejected' | 'request_info' | 'escalate';
  notes?: string;
}

export const submitReviewDecision = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<SubmitReviewDecisionData, { success: boolean; reviewId: string; decision: string }>(
    ['ops', 'admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'submitReviewDecision', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation)
        try {
          const allowed = await checkRateLimit(`rl:submitReviewDecision:${auth.uid}`, 20, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        const { reviewId, decision, notes } = data;
        if (!reviewId || !decision) throw new HttpsError('invalid-argument', 'reviewId and decision are required');
        if (!['approved', 'rejected', 'request_info', 'escalate'].includes(decision))
          throw new HttpsError('invalid-argument', 'Invalid decision. Must be approved, rejected, request_info, or escalate');

        const reviewSnap = await db.collection('review_queue').doc(reviewId).get();
        if (!reviewSnap.exists) throw new HttpsError('not-found', 'Review not found');
        const review = reviewSnap.data()!;

        if (!['pending', 'pending_review'].includes(review['status'] as string))
          throw new HttpsError('failed-precondition', 'Review is not in pending status');

        const now = FieldValue.serverTimestamp();

        const statusMap: Record<string, string> = {
          approved: 'approved',
          rejected: 'rejected',
          request_info: 'info_requested',
          escalate: 'escalated',
        };

        await db.collection('review_queue').doc(reviewId).update({
          status: statusMap[decision],
          reviewedBy: auth.uid,
          reviewedAt: now,
          reviewNotes: notes || null,
          ...(decision === 'escalate' ? { escalatedAt: now, escalatedBy: auth.uid } : {}),
        });

        // If the review is tied to a loan, update the loan status (only for approve/reject)
        if (review['loanId'] && (decision === 'approved' || decision === 'rejected')) {
          await db.collection('loans').doc(review['loanId'] as string).update({
            status: decision,
            statusNote: notes || null,
          });
        }

        await auditLog(db, {
          action: `review.${decision}`,
          actorUid: auth.uid,
          actorRole: auth.role,
          targetId: reviewId,
          before: { status: review['status'] },
          after: { status: statusMap[decision] },
          meta: { notes: notes || null, loanId: review['loanId'] || null },
        });

        return { success: true, reviewId, decision };
      })
  )
);

// ── getReviewDetail — fetch enriched review data for ops detail view ──────────

interface GetReviewDetailData {
  reviewId: string;
}

interface ReviewDetailResult {
  review: Record<string, unknown>;
  loan: Record<string, unknown> | null;
  employee: Record<string, unknown> | null;
  employer: Record<string, unknown> | null;
  mlDecision: Record<string, unknown> | null;
  auditHistory: Record<string, unknown>[];
}

export const getReviewDetail = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<GetReviewDetailData, ReviewDetailResult>(
    ['ops', 'admin', 'super_admin'],
    async (data, _auth) =>
      withErrorHandling({ functionName: 'getReviewDetail', uid: _auth.uid }, async () => {
        // Rate limit: 60/min/uid (read-only detail view)
        try {
          const allowed = await checkRateLimit(`rl:getReviewDetail:${_auth.uid}`, 60, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        const { reviewId } = data;
        if (!reviewId) throw new HttpsError('invalid-argument', 'reviewId is required');

        const reviewSnap = await db.collection('review_queue').doc(reviewId).get();
        if (!reviewSnap.exists) throw new HttpsError('not-found', 'Review not found');
        const reviewData = reviewSnap.data()!;
        const review: Record<string, unknown> = { id: reviewSnap.id, ...reviewData };

        // Fetch associated loan, employee, employer, ML decision in parallel
        const loanId = reviewData['loanId'] as string | undefined;
        const [loanSnap, mlSnap, auditSnap] = await Promise.all([
          loanId ? db.collection('loans').doc(loanId).get() : Promise.resolve(null),
          loanId
            ? db.collection('ml_decisions').where('loanId', '==', loanId).orderBy('decidedAt', 'desc').limit(1).get()
            : Promise.resolve(null),
          db.collection('audit_log').where('targetId', '==', reviewId).orderBy('timestamp', 'desc').limit(20).get(),
        ]);

        const loanData = loanSnap?.exists ? loanSnap.data()! : null;
        const loan: Record<string, unknown> | null = loanData ? { id: loanSnap!.id, ...loanData } : null;

        // Fetch employee and employer based on loan data
        const employeeId = (loanData?.['employeeId'] as string) || null;
        const employerId = (loanData?.['employerId'] as string) || null;

        const [employeeSnap, employerSnap] = await Promise.all([
          employeeId ? db.collection('employees').doc(employeeId).get() : Promise.resolve(null),
          employerId ? db.collection('employers').doc(employerId).get() : Promise.resolve(null),
        ]);

        const employee = employeeSnap?.exists ? { id: employeeSnap.id, ...employeeSnap.data()! } : null;
        const employer = employerSnap?.exists ? { id: employerSnap.id, ...employerSnap.data()! } : null;
        const mlDecision = mlSnap && !mlSnap.empty
          ? { id: mlSnap.docs[0].id, ...mlSnap.docs[0].data() }
          : null;
        const auditHistory = auditSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        return { review, loan, employee, employer, mlDecision, auditHistory };
      })
  )
);

// ── updateEmployerTier — ops/admin Tier 2 manual gate actions ────────────────

interface UpdateEmployerTierData {
  employerId: string;
  action: 'approve_expansion' | 'upgrade_tier';
  newSlots?: number;
}

export const updateEmployerTier = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<UpdateEmployerTierData, { success: boolean }>(
    ['ops', 'admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'updateEmployerTier', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation)
        try {
          const allowed = await checkRateLimit(`rl:updateEmployerTier:${auth.uid}`, 20, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        const { employerId, action, newSlots } = data;
        if (!employerId || !action) throw new HttpsError('invalid-argument', 'employerId and action are required');

        const empDoc = await db.collection('employers').doc(employerId).get();
        if (!empDoc.exists) throw new HttpsError('not-found', 'Employer not found');
        const emp = empDoc.data()!;

        const update: Record<string, unknown> = {};
        if (action === 'approve_expansion') {
          if (typeof newSlots !== 'number' || newSlots < 1)
            throw new HttpsError('invalid-argument', 'newSlots must be a positive number');
          update['maxActiveSlots'] = newSlots;
        } else if (action === 'upgrade_tier') {
          if (emp['riskTier'] !== 2)
            throw new HttpsError('failed-precondition', 'Only Tier 2 employers can be upgraded');
          update['riskTier'] = 1;
          update['tierUpgradedAt'] = FieldValue.serverTimestamp();
        } else {
          throw new HttpsError('invalid-argument', 'Invalid action');
        }

        await db.collection('employers').doc(employerId).update(update);

        await auditLog(db, {
          action: `employer.${action}`,
          actorUid: auth.uid,
          actorRole: auth.role,
          targetId: employerId,
          before: { riskTier: emp['riskTier'], maxActiveSlots: emp['maxActiveSlots'] },
          after: update,
        });

        return { success: true };
      })
  )
);

// ── onEmployerDocCreated — set employer_admin custom claim on employer create ─

export const onEmployerDocCreated = onDocumentCreated('employers/{uid}', async (event) => {
  const uid = event.params['uid'];
  await admin.auth().setCustomUserClaims(uid, { role: 'employer_admin' });
  logger.info('Set employer_admin claim', { uid, service: 'functions' });
  return null;
});

// ── setEmployerClaims — retroactively set employer_admin claims ──────────────

export const setEmployerClaims = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<{ uid: string }, { success: boolean; uid: string }>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'setEmployerClaims', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation — claims assignment)
        try {
          const allowed = await checkRateLimit(`rl:setEmployerClaims:${auth.uid}`, 20, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        const { uid } = data;
        if (!uid) throw new HttpsError('invalid-argument', 'uid is required');

        const empDoc = await db.collection('employers').doc(uid).get();
        if (!empDoc.exists) throw new HttpsError('not-found', 'Employer not found');

        await admin.auth().setCustomUserClaims(uid, { role: 'employer_admin' });

        try {
          await auditLog(db, {
            action: 'employer.setCustomClaims',
            actorUid: auth.uid,
            actorRole: auth.role,
            targetId: uid,
            after: { role: 'employer_admin' },
          });
        } catch (_) { /* non-critical */ }

        return { success: true, uid };
      })
  )
);

// ── updateEmployerCurpConfig — employer CURP allowlist configuration ─────────

interface UpdateCurpConfigData {
  prefixes: string[];
  mode: 'allowlist' | 'open';
}

export const updateEmployerCurpConfig = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<UpdateCurpConfigData, { success: boolean }>(
    ['employer_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'updateEmployerCurpConfig', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation)
        try {
          const allowed = await checkRateLimit(`rl:updateEmployerCurpConfig:${auth.uid}`, 20, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        const { prefixes, mode } = data;

        const resolvedMode = mode === 'allowlist' ? 'allowlist' : 'open';
        const resolvedPrefixes = Array.isArray(prefixes)
          ? prefixes
              .map((p) => String(p).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))
              .filter((p) => p.length === 4)
          : [];

        const uid = auth.uid;
        const empDoc = await db.collection('employers').doc(uid).get();
        if (!empDoc.exists) throw new HttpsError('not-found', 'Employer not found');

        await db.collection('employers').doc(uid).update({
          curpConfig: { prefixes: resolvedPrefixes, mode: resolvedMode },
        });

        try {
          await auditLog(db, {
            action: 'employer.updateCurpConfig',
            actorUid: auth.uid,
            actorRole: auth.role,
            targetId: uid,
            after: { prefixes: resolvedPrefixes, mode: resolvedMode },
          });
        } catch (_) { /* non-critical */ }

        return { success: true };
      })
  )
);

// ── Firestore document triggers ──────────────────────────────────────────────

export const onLoanStatusChange = onDocumentUpdated('loans/{loanId}', async (event) => {
  const beforeData = event.data!.before.data();
  const afterData = event.data!.after.data();
  const loanId = event.params['loanId'];

  if (beforeData['status'] === 'pending' && afterData['status'] === 'approved') {
    await db.collection('employers').doc(afterData['employerId'] as string).update({
      activeLoans: FieldValue.increment(1),
      totalDisbursed: FieldValue.increment(afterData['amount'] as number),
    });
    try {
      await auditLog(db, {
        action: 'loan.approved',
        actorUid: afterData['employerId'] as string,
        actorRole: 'employer',
        targetId: loanId,
        before: { status: 'pending' },
        after: { status: 'approved' },
      });
    } catch (_) { /* non-critical */ }
    await notifyLoanEvent('loan_approved', { employeePhone: afterData['employeePhone'], employeeEmail: afterData['employeeEmail'], employeeName: afterData['employeeName'], loanAmount: afterData['amount'] }).catch(() => {});
  }

  if (beforeData['status'] === 'pending' && afterData['status'] === 'rejected') {
    await db.collection('employees').doc(afterData['employeeId'] as string).update({
      availableCredit: FieldValue.increment(afterData['amount'] as number),
    });
    try {
      await auditLog(db, {
        action: 'loan.rejected',
        actorUid: afterData['employerId'] as string,
        actorRole: 'employer',
        targetId: loanId,
        before: { status: 'pending' },
        after: { status: 'rejected' },
      });
    } catch (_) { /* non-critical */ }
    await notifyLoanEvent('loan_rejected', { employeePhone: afterData['employeePhone'], employeeEmail: afterData['employeeEmail'], employeeName: afterData['employeeName'], loanAmount: afterData['amount'] }).catch(() => {});
  }

  if (beforeData['status'] === 'approved' && afterData['status'] === 'paid') {
    await db.collection('employers').doc(afterData['employerId'] as string).update({
      activeLoans: FieldValue.increment(-1),
    });
    await db.collection('employees').doc(afterData['employeeId'] as string).update({
      availableCredit: FieldValue.increment(afterData['amount'] as number),
    });
    try {
      await auditLog(db, {
        action: 'loan.repaid',
        actorUid: afterData['employeeId'] as string,
        actorRole: 'employee',
        targetId: loanId,
        before: { status: 'approved' },
        after: { status: 'paid' },
      });
    } catch (_) { /* non-critical */ }
  }
});

export const onLoanApproved = onDocumentUpdated('loans/{loanId}', async (event) => {
  const before = event.data!.before.data();
  const after = event.data!.after.data();
  if (!(before['status'] === 'pending' && after['status'] === 'approved')) return null;

  const loanId = event.params['loanId'];
  const emp = (await db.collection('employees').doc(after['employeeId'] as string).get()).data() ?? {};

  await db.collection('disbursement_queue').doc(loanId).set({
    loanId,
    employeeId: after['employeeId'],
    employeeName: after['employeeName'],
    employerName: after['employerName'],
    amount: after['amount'],
    total: after['total'],
    clabe: emp['bankClabe'] ?? null,
    bankName: emp['bankName'] ?? null,
    concept: 'VIDA-' + loanId.slice(0, 8).toUpperCase(),
    status: 'queued',
    queuedAt: FieldValue.serverTimestamp(),
  });
  await db.collection('loans').doc(loanId).update({ status: 'disbursement_queued' });

  const softcreditoUrl = process.env['SOFTCREDITO_ADAPTER_URL'];
  const internalSecret = process.env['INTERNAL_SECRET'] ?? '';

  if (softcreditoUrl && internalSecret) {
    // Real SPEI disbursement via SoftCrédito adapter
    try {
      const disburseRes = await fetch(`${softcreditoUrl}/internal/disburse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': internalSecret,
        },
        body: JSON.stringify({
          loanId,
          clabe: emp['bankClabe'],
          amount: after['amount'],
          concept: 'VIDA-' + loanId.slice(0, 8).toUpperCase(),
          employeeName: after['employeeName'],
          employeeId: after['employeeId'],
        }),
      });

      if (!disburseRes.ok) {
        const errBody = await disburseRes.text();
        throw new Error(`Adapter returned ${disburseRes.status}: ${errBody}`);
      }

      const result = (await disburseRes.json()) as { ref?: string; transferId?: string };
      await db.collection('loans').doc(loanId).update({
        status: 'active',
        disbursedAt: FieldValue.serverTimestamp(),
        disbursementRef: result.ref ?? null,
      });
      await db.collection('disbursement_queue').doc(loanId).update({
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
      });
      logger.info('Loan disbursed via SoftCrédito', { loanId, ref: result.ref, service: 'functions' });
      await auditLog(db, { action: 'loan.disbursed', actorUid: 'system', actorRole: 'system', targetId: loanId });
    } catch (e: unknown) {
      logger.error('SoftCrédito disbursement failed', { error: (e as Error).message, loanId, service: 'functions' });
      sendSlackAlert('Disbursement FAILED for loan ' + loanId + ' — manual intervention required', 'critical').catch(() => {});
      // Never mark the loan active on failure: doing so would report funds as sent
      // when no SPEI transfer occurred. Surface the failure for ops retry instead.
      try {
        await db.collection('loans').doc(loanId).update({
          status: 'disbursement_failed',
          disbursementError: (e as Error).message,
          disbursementFailedAt: FieldValue.serverTimestamp(),
        });
        await db.collection('disbursement_queue').doc(loanId).update({
          status: 'failed',
          error: (e as Error).message,
          failedAt: FieldValue.serverTimestamp(),
        });
        await auditLog(db, { action: 'loan.disbursement_failed', actorUid: 'system', actorRole: 'system', targetId: loanId, meta: { error: (e as Error).message } });
      } catch (markErr: unknown) {
        logger.error('Failed to mark disbursement_failed', { error: (markErr as Error).message, loanId, service: 'functions' });
      }
    }
  } else {
    // Adapter not configured. Only simulate a disbursement when explicitly opted in
    // (local/dev/test). In any real environment this is a misconfiguration and must
    // NOT mark the loan active with a fake reference.
    if (process.env['ALLOW_STUB_DISBURSEMENT'] === 'true') {
      try {
        await db.collection('loans').doc(loanId).update({
          status: 'active',
          disbursedAt: FieldValue.serverTimestamp(),
          disbursementRef: 'STUB-' + loanId.slice(0, 8).toUpperCase(),
        });
        await db.collection('disbursement_queue').doc(loanId).update({
          status: 'completed',
          completedAt: FieldValue.serverTimestamp(),
        });
        logger.info('Loan auto-disbursed (stub mode — ALLOW_STUB_DISBURSEMENT)', { loanId, service: 'functions' });
        await auditLog(db, { action: 'loan.disbursed', actorUid: 'system', actorRole: 'system', targetId: loanId, meta: { mode: 'stub' } });
      } catch (e: unknown) {
        logger.warn('Stub disbursement error', { error: (e as Error).message, loanId, service: 'functions' });
      }
    } else {
      logger.error('SOFTCREDITO_ADAPTER_URL / INTERNAL_SECRET not configured — cannot disburse', { loanId, service: 'functions' });
      sendSlackAlert('Disbursement BLOCKED for loan ' + loanId + ' — adapter not configured', 'critical').catch(() => {});
      try {
        await db.collection('loans').doc(loanId).update({
          status: 'disbursement_failed',
          disbursementError: 'SOFTCREDITO_ADAPTER_URL or INTERNAL_SECRET not configured',
          disbursementFailedAt: FieldValue.serverTimestamp(),
        });
        await db.collection('disbursement_queue').doc(loanId).update({
          status: 'failed',
          error: 'adapter_not_configured',
          failedAt: FieldValue.serverTimestamp(),
        });
        await auditLog(db, { action: 'loan.disbursement_failed', actorUid: 'system', actorRole: 'system', targetId: loanId, meta: { reason: 'adapter_not_configured' } });
      } catch (e: unknown) {
        logger.error('Failed to mark disbursement_failed', { error: (e as Error).message, loanId, service: 'functions' });
      }
    }
  }

  // Register payroll deduction with SoftCrédito
  try {
    const scUrl = process.env['SOFTCREDITO_ADAPTER_URL'];
    const secret = process.env['INTERNAL_SECRET'] ?? '';
    if (scUrl && secret) {
      await fetch(scUrl + '/internal/register-deduction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
        body: JSON.stringify({
          loanId,
          employeeId: after['employeeId'],
          employerId: after['employerId'],
          amount: after['total'],
          dueDate: (after['dueDate'] as FirebaseFirestore.Timestamp).toDate().toISOString(),
        }),
         
        signal: AbortSignal.timeout(10000),
      }).then(async (r) => {
        if (r.ok) {
          const result = await r.json() as Record<string, unknown>;
          await db.collection('loans').doc(loanId).update({
            softcreditoDeductionId: result['deductionId'] ?? null,
          });
          logger.info('Payroll deduction registered', { loanId, service: 'functions' });
        }
      });
    }
  } catch (e: unknown) {
    logger.warn('Payroll deduction registration failed', { error: (e as Error).message, loanId, service: 'functions' });
  }

  return null;
});


// ── Auto-verify test accounts (Firestore triggers) ──────────────────────────
// Replaces beforeUserCreated which requires Identity Platform.

// ── onEmployeeDocCreated — set employee custom claim on employee create ──────

export const onEmployeeDocCreated = onDocumentCreated('employees/{uid}', async (event) => {
  const uid = event.params['uid'];
  await admin.auth().setCustomUserClaims(uid, { role: 'employee' });
  logger.info('Set employee claim', { uid, service: 'functions' });
  return null;
});

export const autoVerifyOnEmployerCreate = onDocumentCreated('employers/{uid}', async (event) => {
  const data = event.data?.data();
  if (!data?.email) return;
  if (!data.email.endsWith('@vida-test.com')) return;
  try {
    const userRecord = await admin.auth().getUser(event.params.uid);
    if (!userRecord.emailVerified) {
      await admin.auth().updateUser(event.params.uid, { emailVerified: true });
      logger.info('Auto-verified test employer', { uid: event.params.uid, email: data.email });
    }
    // Auto-activate test employers so loan requests work
    if (data.status !== 'active') {
      await db.collection('employers').doc(event.params.uid).update({ status: 'active' });
      logger.info('Auto-activated test employer', { uid: event.params.uid });
    }
  } catch (err) {
    logger.warn('Auto-verify failed', { uid: event.params.uid, error: (err as Error).message });
  }
});

export const autoVerifyOnEmployeeCreate = onDocumentCreated('employees/{uid}', async (event) => {
  const data = event.data?.data();
  if (!data?.email) return;
  if (!data.email.endsWith('@vida-test.com')) return;
  try {
    const userRecord = await admin.auth().getUser(event.params.uid);
    if (!userRecord.emailVerified) {
      await admin.auth().updateUser(event.params.uid, { emailVerified: true });
      logger.info('Auto-verified test employee', { uid: event.params.uid, email: data.email });
    }
  } catch (err) {
    logger.warn('Auto-verify failed', { uid: event.params.uid, error: (err as Error).message });
  }
});

// ── Scheduled functions ──────────────────────────────────────────────────────

export const dailyLoanCheck = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/Mexico_City' },
  async () => {
    const now = Timestamp.now();

    const overdueSnap = await db
      .collection('loans')
      .where('status', '==', 'active')
      .where('dueDate', '<', now)
      .get();

    for (const doc of overdueSnap.docs) {
      const loan = doc.data();
      const daysOver = Math.floor((Date.now() - (loan['dueDate'] as FirebaseFirestore.Timestamp).toMillis()) / 86400000);

      await doc.ref.update({ status: 'overdue', overdueDetectedAt: now });

      await db.collection('overdue_log').doc(doc.id).set({
        loanId: doc.id,
        employeeId: loan['employeeId'],
        employerId: loan['employerId'],
        employeeName: loan['employeeName'],
        amount: loan['total'],
        dueDate: loan['dueDate'],
        daysOverdue: daysOver,
        detectedAt: now,
        resolved: false,
      });

      try {
        await getQueue('vida-notifications').add('loan_overdue', {
          type: 'loan_overdue',
          loanId: doc.id,
          employeeId: loan['employeeId'],
          phone: loan['employeePhone'],
          amount: loan['total'],
          dueDate: (loan['dueDate'] as FirebaseFirestore.Timestamp).toDate().toISOString(),
          daysOverdue: daysOver,
        });
      } catch (_) { /* queue unavailable */ }

      try {
        await auditLog(db, {
          action: 'loan.overdue_detected',
          actorUid: 'system',
          actorRole: 'system',
          targetId: doc.id,
        });
      } catch (_) { /* non-critical */ }
    }

    if (overdueSnap.size > 0) {
      sendSlackAlert('New overdue loans detected: ' + overdueSnap.size, 'warning').catch(() => {});
    }

    const tomorrow = Timestamp.fromMillis(Date.now() + 25 * 60 * 60 * 1000);
    const remindSnap = await db
      .collection('loans')
      .where('status', '==', 'active')
      .where('dueDate', '<', tomorrow)
      .get();

    for (const doc of remindSnap.docs) {
      const loan = doc.data();
      if ((loan['dueDate'] as FirebaseFirestore.Timestamp).toMillis() < Date.now()) continue;
      try {
        await getQueue('vida-notifications').add('loan_reminder_24h', {
          type: 'loan_reminder_24h',
          loanId: doc.id,
          employeeId: loan['employeeId'],
          phone: loan['employeePhone'],
          amount: loan['total'],
          dueDate: (loan['dueDate'] as FirebaseFirestore.Timestamp).toDate().toISOString(),
        });
      } catch (_) { /* queue unavailable */ }
    }

    await db.collection('scheduler_runs').add({
      job: 'dailyLoanCheck',
      ranAt: now,
      overdueFound: overdueSnap.size,
      status: 'complete',
    });
  }
);

export const weeklyPortfolioSnapshot = onSchedule(
  { schedule: '0 8 * * 1', timeZone: 'America/Mexico_City' },
  async () => {
    const snap = await db.collection('loans').get();
    const loans = snap.docs.map((d) => d.data());

    const cnt = (s: string) => loans.filter((l) => l['status'] === s).length;
    const sum = (s: string) =>
      loans.filter((l) => l['status'] === s).reduce((a, l) => a + ((l['amount'] as number) || 0), 0);

    const active = cnt('active');
    const overdue = cnt('overdue');
    const paid = cnt('paid');
    const total = active + overdue + paid;
    const date = new Date().toISOString().split('T')[0];

    await db.collection('portfolio_snapshots').doc(date).set({
      snapshotDate: date,
      totalActive: active,
      totalOverdue: overdue,
      totalPaid: paid,
      totalDisbursedMXN: sum('active') + sum('overdue') + sum('paid'),
      totalOutstandingMXN: sum('active') + sum('overdue'),
      overdueRate: total > 0 ? overdue / total : 0,
      snapshotAt: FieldValue.serverTimestamp(),
    });
  }
);

export const systemHealthCheck = onSchedule(
  { schedule: '*/5 * * * *', timeZone: 'America/Mexico_City' },
  async () => {
    // Railway services decommissioned — check only Cloud Functions + Firestore
    const services: { name: string; url: string }[] = [];
    if (process.env['PAYMENT_SERVER_URL']) services.push({ name: 'payment-server', url: process.env['PAYMENT_SERVER_URL'] + '/health' });
    if (process.env['ML_SERVICE_URL']) services.push({ name: 'ml-service', url: process.env['ML_SERVICE_URL'] + '/health' });

    const results = await Promise.allSettled(
      services.map(async (s) => {
        const start = Date.now();
         
        const r = await fetch(s.url, { signal: AbortSignal.timeout(6000) });
        const d = (await r.json()) as Record<string, unknown>;
        return { name: s.name, status: d['status'], redis: d['redis'], latencyMs: Date.now() - start };
      })
    );

    const data: Record<string, unknown> = {};
    const ts = FieldValue.serverTimestamp();

    for (let i = 0; i < services.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled') {
        data[services[i].name] = { ...res.value, checkedAt: ts };
      } else {
        data[services[i].name] = { status: 'down', error: res.reason.message, checkedAt: ts };
        await db.collection('incident_log').add({
          source: 'health-check',
          service: services[i].name,
          error: res.reason.message,
          severity: 'critical',
          ts,
          resolved: false,
        });
      }
    }

    await db.collection('system_health').doc('current').set({ ...data, lastChecked: ts });
  }
);

export const queueHealthCheck = onSchedule(
  { schedule: '*/2 * * * *', timeZone: 'America/Mexico_City' },
  async () => {
    try {
      const r = await fetch(process.env['PAYMENT_SERVER_URL'] + '/internal/queue-stats', {
        headers: { 'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '' },
         
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return;

      const d = (await r.json()) as { queues: Record<string, { failed: number }> };
      const ts = FieldValue.serverTimestamp();

      await db.collection('system_health').doc('queues').set({ ...d.queues, checkedAt: ts });

      for (const [name, stats] of Object.entries(d.queues)) {
        if (stats.failed > 50) {
          await db.collection('incident_log').add({
            source: 'queue-monitor',
            queue: name,
            failedCount: stats.failed,
            severity: 'warning',
            ts,
            resolved: false,
          });
        }
      }
    } catch (e: unknown) {
      logger.warn('Queue health check failed', { error: (e as Error).message, service: 'functions' });
    }
  }
);

// ─── Payroll deduction processing (VID3-625) ────────────────────────────────
export { processPayroll } from './payroll/processPayroll';

// ─── SAT blacklist refresh (VID3-714) ───────────────────────────────────────
// Self-hosts SAT public EFOS + Art. 69 CSVs to unblock employer-screening.
// Scheduled monthly on the 15th + admin-only manual trigger. See
// functions/src/scheduled/satBlacklistRefresh.ts for full rationale.
export { satBlacklistRefresh, refreshSatBlacklists } from './scheduled/satBlacklistRefresh';
