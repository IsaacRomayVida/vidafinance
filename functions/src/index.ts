import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import fetch from 'node-fetch';
import { nanoid } from 'nanoid';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

import { withAuth, AuthContext } from './middleware/authMiddleware';
import { withErrorHandling, VidaErrorCode } from './utils/errorHandler';

initializeApp();
const db = getFirestore();

// ── Redis / BullMQ singletons ────────────────────────────────────────────────

let _redis: IORedis | null = null;
function getRedis(): IORedis {
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

function getQueue(name: string): Queue {
  // Pass connection URL directly to avoid IORedis version mismatch with bullmq's bundled ioredis.
  const redisUrl = process.env['REDIS_URL'] ?? '';
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signal: (AbortSignal as any).timeout(8000),
  });
  if (!r.ok) throw new Error(`ML ${path}: ${r.status}`);
  return r.json() as Promise<Record<string, unknown>>;
}

// ── api — health endpoint ────────────────────────────────────────────────────

export const api = onRequest({ cors: true }, async (req, res) => {
  if (req.path === '/api/health') {
    res.json({ status: 'ok', service: 'vida-finance', timestamp: new Date().toISOString() });
    return;
  }
  res.status(404).json({ error: 'Not found' });
});

// ── requestLoan — employee only ──────────────────────────────────────────────

interface RequestLoanData {
  amount: number;
  term: number;
}

export const requestLoan = onCall(
  { cors: true, enforceAppCheck: false },
  withAuth<RequestLoanData, { loanId: string; status: string; total: number; dueDate: string }>(
    ['employee'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'requestLoan', uid: auth.uid }, async () => {
        const { amount, term } = data;
        const uid = auth.uid;

        // Rate limit: max 3 requests per hour via Redis
        try {
          const r = getRedis();
          const key = 'rate:loans:' + uid;
          const cnt = await r.incr(key);
          if (cnt === 1) await r.expire(key, 3600);
          if (cnt > 3) throw new HttpsError('resource-exhausted', 'Máximo 3 solicitudes por hora');
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          console.warn('Redis rate limit unavailable:', (e as Error).message);
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
          .where('status', 'in', ['pending', 'approved', 'active'])
          .limit(1)
          .get();
        if (!active.empty)
          throw new HttpsError('failed-precondition', VidaErrorCode.DUPLICATE_LOAN_APPLICATION);

        const employerSnap = await db.collection('employers').doc(emp['employerId']).get();
        const employer = employerSnap.data() ?? {};

        if (employer['status'] !== 'active')
          throw new HttpsError('failed-precondition', VidaErrorCode.EMPLOYER_NOT_APPROVED);

        const loanId = nanoid();
        const fee = Math.round(amount * 0.3);
        const dueDate = Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

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
          console.warn('ML unavailable:', (e as Error).message);
        }

        await db.runTransaction(async (tx) => {
          tx.update(empRef, { availableCredit: FieldValue.increment(-amount) });
          tx.set(db.collection('loans').doc(loanId), {
            employeeId: uid,
            employeeName: emp['name'],
            employeeEmail: emp['email'],
            employeePhone: emp['phone'] ?? null,
            employerId: emp['employerId'],
            employerName: emp['employerName'],
            employerCode: employer['employerCode'],
            amount,
            fee,
            total: amount + fee,
            term: 30,
            status: 'pending',
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
            createdAt: FieldValue.serverTimestamp(),
            acceptedAt: FieldValue.serverTimestamp(),
          });
        });

        try {
          await auditLog(db, { action: 'loan.requested', actorUid: uid, actorRole: 'employee', targetId: loanId });
        } catch (_) { /* non-critical */ }

        return { loanId, status: 'pending', total: amount + fee, dueDate: dueDate.toDate().toISOString() };
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
  { cors: true, enforceAppCheck: false },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    return withErrorHandling({ functionName: 'updateLoanStatus', uid: request.auth.uid }, async () => {
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

// ── markLoanDisbursed — ops/admin only ───────────────────────────────────────

interface MarkLoanDisbursedData {
  loanId: string;
  disbursementRef: string;
}

export const markLoanDisbursed = onCall(
  { cors: true, enforceAppCheck: false },
  withAuth<MarkLoanDisbursedData, { success: boolean }>(
    ['admin', 'super_admin', 'ops'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'markLoanDisbursed', uid: auth.uid, loanId: data.loanId }, async () => {
        const { loanId, disbursementRef } = data;
        if (!loanId || !disbursementRef)
          throw new HttpsError('invalid-argument', 'loanId and disbursementRef are required');

        const loanSnap = await db.collection('loans').doc(loanId).get();
        if (!loanSnap.exists) throw new HttpsError('not-found', 'Loan not found');
        const loan = loanSnap.data()!;

        await db.collection('loans').doc(loanId).update({
          status: 'active',
          disbursedAt: FieldValue.serverTimestamp(),
          disbursementRef,
        });
        await db.collection('disbursement_queue').doc(loanId).update({
          status: 'completed',
          completedAt: FieldValue.serverTimestamp(),
        });

        try {
          await getQueue('vida-notifications').add('loan_disbursed', {
            type: 'loan_disbursed',
            loanId,
            employeeId: loan['employeeId'],
            amount: loan['amount'],
            disbursementRef,
            phone: loan['employeePhone'],
          });
        } catch (e: unknown) {
          console.warn('Queue unavailable:', (e as Error).message);
        }

        try {
          await auditLog(db, {
            action: 'loan.disbursed',
            actorUid: auth.uid,
            actorRole: auth.role,
            targetId: loanId,
            after: { status: 'active', disbursementRef },
          });
        } catch (_) { /* non-critical */ }

        return { success: true };
      })
  )
);

// ── generatePaymentLink — employee only ──────────────────────────────────────

interface GeneratePaymentLinkData {
  loanId: string;
}

export const generatePaymentLink = onCall(
  { cors: true, enforceAppCheck: false },
  withAuth<GeneratePaymentLinkData, { paymentUrl: string }>(
    ['employee'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'generatePaymentLink', uid: auth.uid, loanId: data.loanId }, async () => {
        const { loanId } = data;
        const loanDoc = await db.collection('loans').doc(loanId).get();
        if (!loanDoc.exists) throw new HttpsError('not-found', 'Loan not found');
        const loan = loanDoc.data()!;

        if (loan['employeeId'] !== auth.uid)
          throw new HttpsError('permission-denied', 'Not your loan');
        if (!['active', 'overdue'].includes(loan['status'] as string))
          throw new HttpsError('failed-precondition', 'Loan not payable');

        const generatedAt = loan['paymentLinkGeneratedAt'] as FirebaseFirestore.Timestamp | null;
        if (
          loan['paymentUrl'] &&
          generatedAt &&
          Date.now() - generatedAt.toMillis() < 23 * 60 * 60 * 1000
        ) {
          return { paymentUrl: loan['paymentUrl'] as string };
        }

        const b64 = Buffer.from(process.env['CONEKTA_API_KEY'] + ':').toString('base64');
        const resp = await fetch('https://api.conekta.io/orders', {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + b64,
            'Content-Type': 'application/json',
            Accept: 'application/vnd.conekta-v2.1.0+json',
          },
          body: JSON.stringify({
            currency: 'MXN',
            customer_info: {
              name: loan['employeeName'],
              email: loan['employeeEmail'],
              phone: loan['employeePhone'] || '0000000000',
            },
            line_items: [
              {
                name: 'Pago préstamo VIDA ' + loanId.slice(0, 8).toUpperCase(),
                unit_price: Math.round((loan['total'] as number) * 100),
                quantity: 1,
              },
            ],
            checkout: {
              type: 'HostedPayment',
              expires_at: Math.floor(Date.now() / 1000) + 86400,
            },
            metadata: { loanId, employeeId: loan['employeeId'] },
          }),
        });

        const order = (await resp.json()) as Record<string, unknown>;
        if (!resp.ok) {
          const details = order['details'] as Array<{ message: string }> | undefined;
          throw new HttpsError('internal', details?.[0]?.message ?? 'Conekta error');
        }

        const checkout = order['checkout'] as Record<string, unknown>;
        await db.collection('loans').doc(loanId).update({
          conektaOrderId: order['id'],
          paymentUrl: checkout['url'],
          paymentLinkGeneratedAt: FieldValue.serverTimestamp(),
        });

        try {
          await auditLog(db, {
            action: 'payment_link.generated',
            actorUid: auth.uid,
            actorRole: auth.role,
            targetId: loanId,
          });
        } catch (_) { /* non-critical */ }

        return { paymentUrl: checkout['url'] as string };
      })
  )
);

// ── approveEmployer — admin only ─────────────────────────────────────────────

interface ApproveEmployerData {
  employerUid: string;
}

export const approveEmployer = onCall(
  { cors: true, enforceAppCheck: false },
  withAuth<ApproveEmployerData, { success: boolean; approved: boolean; reason?: string }>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'approveEmployer', uid: auth.uid }, async () => {
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
          console.warn('ML scoring unavailable:', (e as Error).message);
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
          console.warn('SoftCrédito registration warning:', (e as Error).message);
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
          console.warn('Notification queue unavailable:', (e as Error).message);
        }

        try {
          await auditLog(db, {
            action: 'employer.approved',
            actorUid: auth.uid,
            actorRole: auth.role,
            targetId: employerUid,
          });
        } catch (_) { /* non-critical */ }

        return { success: true, approved: true };
      })
  )
);

// ── setAdminClaim / revokeAdminClaim — admin only ────────────────────────────

interface SetClaimData {
  uid: string;
  role?: AuthContext['role'];
}

export const setAdminClaim = onCall(
  { cors: true, enforceAppCheck: false },
  withAuth<SetClaimData, { success: boolean }>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'setAdminClaim', uid: auth.uid }, async () => {
        if (!data.uid) throw new HttpsError('invalid-argument', 'uid is required');
        await getAuth().setCustomUserClaims(data.uid, { admin: true, role: data.role ?? 'admin' });
        return { success: true };
      })
  )
);

export const revokeAdminClaim = onCall(
  { cors: true, enforceAppCheck: false },
  withAuth<SetClaimData, { success: boolean }>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'revokeAdminClaim', uid: auth.uid }, async () => {
        if (!data.uid) throw new HttpsError('invalid-argument', 'uid is required');
        await getAuth().setCustomUserClaims(data.uid, { admin: false, role: 'employee' });
        return { success: true };
      })
  )
);

// ── getPortfolioReport — admin only ──────────────────────────────────────────

export const getPortfolioReport = onCall(
  { cors: true, enforceAppCheck: false },
  withAuth<Record<string, never>, { snapshots: unknown[] }>(
    ['admin', 'super_admin', 'ops'],
    async (_data, auth) =>
      withErrorHandling({ functionName: 'getPortfolioReport', uid: auth.uid }, async () => {
        const snap = await db
          .collection('portfolio_snapshots')
          .orderBy('snapshotDate', 'desc')
          .limit(52)
          .get();
        return { snapshots: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
      })
  )
);

// ── getAdminDashboard — ops/admin only ───────────────────────────────────────

export const getAdminDashboard = onCall(
  { cors: true, enforceAppCheck: false },
  withAuth<Record<string, never>, Record<string, unknown>>(
    ['admin', 'super_admin', 'ops'],
    async (_data, auth) =>
      withErrorHandling({ functionName: 'getAdminDashboard', uid: auth.uid }, async () => {
        const [healthDoc, queueDoc, pendingLoans, activeLoans] = await Promise.all([
          db.collection('system_health').doc('current').get(),
          db.collection('system_health').doc('queues').get(),
          db.collection('loans').where('status', '==', 'pending').get(),
          db.collection('loans').where('status', '==', 'active').get(),
        ]);
        return {
          systemHealth: healthDoc.data() ?? {},
          queues: queueDoc.data() ?? {},
          pendingLoans: pendingLoans.size,
          activeLoans: activeLoans.size,
        };
      })
  )
);

// ── getEmployerDashboard — employer only ─────────────────────────────────────

export const getEmployerDashboard = onCall(
  { cors: true, enforceAppCheck: false },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    return withErrorHandling({ functionName: 'getEmployerDashboard', uid: request.auth.uid }, async () => {
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

  try {
    await getQueue('vida-disbursements').add('disburse', {
      loanId,
      employeeId: after['employeeId'],
      amount: after['amount'],
      clabe: emp['bankClabe'],
      concept: 'VIDA-' + loanId.slice(0, 8).toUpperCase(),
      employeeName: after['employeeName'],
      employerName: after['employerName'],
    });
    await getQueue('vida-notifications').add('loan_approved', {
      type: 'loan_approved',
      loanId,
      employeeId: after['employeeId'],
      employeeName: after['employeeName'],
      phone: emp['phone'],
      amount: after['amount'],
    });
    await getQueue('vida-pdfs').add('loan_contract', {
      type: 'loan_contract',
      loanId,
      employeeId: after['employeeId'],
      employeeName: after['employeeName'],
      employerName: after['employerName'],
      amount: after['amount'],
      total: after['total'],
      fee: after['fee'],
      dueDate: (after['dueDate'] as FirebaseFirestore.Timestamp).toDate().toISOString(),
    });
  } catch (e: unknown) {
    console.warn('Queue unavailable:', (e as Error).message);
  }

  return null;
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
    const services = [
      { name: 'payment-server', url: process.env['PAYMENT_SERVER_URL'] + '/health' },
      { name: 'softcredito-adapter', url: process.env['SOFTCREDITO_ADAPTER_URL'] + '/health' },
      { name: 'notification-service', url: process.env['NOTIFICATION_SERVICE_URL'] + '/health' },
      { name: 'pdf-generator', url: process.env['PDF_GENERATOR_URL'] + '/health' },
      { name: 'ml-service', url: process.env['ML_SERVICE_URL'] + '/health' },
    ];

    const results = await Promise.allSettled(
      services.map(async (s) => {
        const start = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await fetch(s.url, { signal: (AbortSignal as any).timeout(6000) });
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signal: (AbortSignal as any).timeout(6000),
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
      console.warn('Queue health check failed:', (e as Error).message);
    }
  }
);
