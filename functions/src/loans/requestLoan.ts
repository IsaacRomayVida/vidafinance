import { randomUUID } from 'crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { z } from 'zod';
import fetch from 'node-fetch';
import { checkRateLimit } from '../utils/rateLimiter';
import { auditLog } from '../utils/auditLog';

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

// ─── Input Schema ─────────────────────────────────────────────────────────────

export const RequestLoanSchema = z.object({
  amount: z
    .number()
    .positive('El monto debe ser positivo')
    .max(5000, 'El monto máximo del préstamo es MXN $5,000')
    .multipleOf(100, 'El monto debe ser en incrementos de MXN $100'),
  employerCode: z
    .string()
    .min(6, 'Código de empleador inválido')
    .max(12, 'Código de empleador inválido')
    .regex(/^[A-Z0-9]+$/, 'Formato de código de empleador inválido'),
  bankAccountClabe: z
    .string()
    .length(18, 'La CLABE debe tener exactamente 18 dígitos')
    .regex(/^\d{18}$/, 'La CLABE solo debe contener dígitos')
    .refine(validateClabeChecksum, 'CLABE inválida. Verifica el número con tu banco.'),
  termsAccepted: z.literal(true, {
    error: 'Debes aceptar los términos y condiciones',
  }),
  loanPurpose: z
    .enum([
      'emergency',
      'medical',
      'education',
      'home_repair',
      'transportation',
      'debt_consolidation',
      'other',
    ], { error: 'Selecciona un motivo válido para el préstamo' }),
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
  const correlationId = randomUUID();

  // 1. Authentication check
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Se requiere autenticación');
  }
  const uid = request.auth.uid;

  logger.info('Solicitud de préstamo iniciada', {
    correlationId, userId: uid, service: 'functions',
  });

  // 2. Input validation via Zod (includes CLABE checksum via .refine())
  const validationResult = RequestLoanSchema.safeParse(request.data);
  if (!validationResult.success) {
    const firstError = validationResult.error.issues[0];
    logger.warn('Validación de entrada fallida', {
      correlationId, userId: uid, field: firstError.path.join('.'), service: 'functions',
    });
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
      logger.warn('Límite de solicitudes excedido', {
        correlationId, userId: uid, service: 'functions',
      });
      throw new HttpsError('resource-exhausted', 'Demasiadas solicitudes de préstamo hoy. Intenta mañana.');
    }
  } catch (e: unknown) {
    if (e instanceof HttpsError) throw e;
    logger.warn('Redis rate limit unavailable', {
      error: (e as Error).message, correlationId, userId: uid, service: 'functions',
    });
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
      'Ya tienes un préstamo activo. Liquídalo antes de solicitar uno nuevo.',
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
      'Código de empleador inválido. Verifícalo con tu departamento de RH.'
    );
  }
  const employer = employerQuery.docs[0].data();

  // 6. Validate borrower profile and KYC status
  const borrowerDoc = await db.collection('users').doc(uid).get();
  if (!borrowerDoc.exists) {
    throw new HttpsError('not-found', 'Perfil de usuario no encontrado. Completa tu registro primero.');
  }
  const borrower = borrowerDoc.data()!;

  if (borrower['kycStatus'] !== 'verified') {
    throw new HttpsError(
      'failed-precondition',
      'Se requiere verificación de identidad antes de solicitar un préstamo.',
      { kycStatus: borrower['kycStatus'] as string }
    );
  }

  if (borrower['employerId'] !== employer['employerId']) {
    throw new HttpsError(
      'permission-denied',
      'El código de empleador no corresponde a tu empleador registrado.'
    );
  }

  // 7. Salary cap enforcement — max 30% of monthly salary, hard cap MXN $5,000
  const monthlySalary = borrower['monthlySalary'] as number;
  const maxAllowedAmount = Math.floor((monthlySalary * 0.3) / 100) * 100;
  const cappedMax = Math.min(maxAllowedAmount, 5000);

  if (input.amount > cappedMax) {
    throw new HttpsError(
      'invalid-argument',
      `El monto máximo es MXN $${cappedMax} (30% de tu salario mensual de MXN $${monthlySalary}).`,
      { maxAmount: cappedMax, requestedAmount: input.amount }
    );
  }

  // 8. Credit bureau check via SoftCrédito (non-blocking — failure logged, not thrown)
  let bureauResult: BureauResult = { bureauScore: null, bureauDefaults: null, bureauDaysPastDue: null };
  try {
    bureauResult = await fetchBureauScore({
      curp: borrower['curp'] as string,
      fullName: borrower['fullName'] as string,
      dateOfBirth: borrower['dateOfBirth'] as string,
      rfc: borrower['rfc'] as string,
    });
    logger.info('Consulta de buró completada', {
      correlationId, userId: uid, bureauScore: bureauResult.bureauScore, service: 'functions',
    });
  } catch (e: unknown) {
    logger.warn('Consulta de buró no disponible — continuando sin datos de buró', {
      error: (e as Error).message, correlationId, userId: uid, service: 'functions',
    });
  }

  // 9. Write loan document to Firestore
  const loanRef = db.collection('loans').doc();
  const loanId = loanRef.id;
  const now = Timestamp.now();
  const feeAmount = Math.round(input.amount * 0.3);

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
    loanPurpose: input.loanPurpose,
    termsVersion: TERMS_VERSION,
    termsAcceptedAt: now,
    requestedAt: now,
    updatedAt: now,
  });

  logger.info('Préstamo creado en Firestore', {
    correlationId, userId: uid, loanId, principalAmount: input.amount, service: 'functions',
  });

  // 10. Audit log (non-blocking — failure logged, not thrown)
  try {
    await auditLog({
      action: 'loan.requested',
      actorUid: uid,
      actorRole: 'employee',
      targetId: loanId,
      after: {
        principalAmount: input.amount,
        employerCode: input.employerCode,
        loanPurpose: input.loanPurpose,
        status: 'pending',
      },
      meta: { correlationId },
    });
  } catch (e: unknown) {
    logger.warn('Audit log write failed', {
      error: (e as Error).message, correlationId, loanId, service: 'functions',
    });
  }

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
    logger.info('Trabajo de underwriting encolado', {
      correlationId, userId: uid, loanId, service: 'functions',
    });
  } catch (e: unknown) {
    logger.warn('Cola de underwriting no disponible', {
      error: (e as Error).message, correlationId, loanId, service: 'functions',
    });
  }

  return {
    loanId,
    status: 'pending',
    message: 'Solicitud de préstamo enviada exitosamente. Te notificaremos cuando sea revisada.',
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
