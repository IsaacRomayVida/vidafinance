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

import { withAuth } from './middleware/authMiddleware';
import { withErrorHandling, VidaErrorCode } from './utils/errorHandler';
import { enforceRateLimit } from './utils/rateLimiter';
import { sendSlackAlert } from './utils/slackAlert';
import { initSentry } from './utils/sentry';
import {
  getLoanConfigValues,
  type LoanConfig,
  ALLOWED_LOAN_TERM_DAYS,
  DEFAULT_LOAN_TERM_DAYS,
  MIN_LOAN_AMOUNT,
  MAX_LOAN_AMOUNT,
  buildLoanInstallments,
  toPayrollDeduction,
  computeCatPercent,
} from './config/loanConfig';
import { calculateNextPayrollDate, type PayFrequency } from './loans/calculateNextPayrollDate';
import { resolvePayFrequency, type PayFrequencySource } from './loans/resolvePayFrequency';
import {
  isLoanApprovalTransition,
  isCreditReleasingRejection,
  DISBURSEMENT_INITIATED_STATUSES,
} from './loans/loanStatusTransitions';
import {
  ALL_LOAN_STATUSES,
  isCreditRestoringRepayment,
  isDisbursedStatus,
  isRepaidStatus,
  OUTSTANDING_STATUSES,
} from './loans/loanStatus';
import { computeEmployerDashboardStats } from './employers/computeEmployerDashboardStats';
import { allowTestBypass } from './utils/environment';
import { AUDIT_LOG_COLLECTION, buildAuditLogDocument, type AuditLogEntry } from './utils/auditLog';
import { getQueue } from './utils/queue';

initSentry();

// Re-export fully-implemented cloud functions from their own modules
export { markLoanDisbursed } from './loans/markLoanDisbursed';
export { getContractDownloadUrl } from './loans/getContractDownloadUrl';
export { generatePaymentLink } from './payments/generatePaymentLink';
export { setAdminClaim, revokeAdminClaim } from './admin/adminClaims';
export { getSystemHealth } from './admin/getSystemHealth';
export { getReviewQueue } from './admin/getReviewQueue';
export { sendVerificationEmail } from './auth/sendVerificationEmail';
export { sendEmployeeInvite, lookupInvite, acceptInvite } from './invites';
export { metamapWebhook } from './webhooks';
export { onContactCreated } from './contact/onContactCreated';
export { lookupEmployerByCode } from './employers/lookupEmployerByCode';
export { proposeLoanConfigChange, approveLoanConfigChange } from './config/loanConfigAdmin';


initializeApp();
const db = getFirestore();

// Credit-line policy. Single source of truth for the derived employee credit
// limit (onEmployeeDocCreated) and the per-request salary cap (requestLoan), so
// the two cannot drift apart.
const EMPLOYEE_CREDIT_SALARY_RATIO = 0.3;
const EMPLOYEE_CREDIT_CEILING = 5000;

// The inline ML default-probability cut-off applied in requestLoan. Named, not
// because the policy changed — it is the same 0.4 that has always been in force
// — but because a denial record has to state the bound the applicant was
// compared against, and the bound and the comparison must not be able to drift
// apart into two separately-editable literals.
const INLINE_ML_MAX_DEFAULT_PROBABILITY = 0.4;

// Loan statuses that occupy a "slot" — one employee-at-one-employer allowed to
// have a loan outstanding at the same time (ADR-005 Finding 2 / ADR-007). This
// is the same status set requestLoan's per-employee duplicate-application
// guard already treats as "an open application", per the #407 comment near
// DECIDABLE_REVIEW_STATUSES below: `under_review` counts, because leaving it
// out is exactly what stranded borrowers there before.
const ACTIVE_LOAN_STATUSES = ['pending', 'under_review', 'approved', 'disbursement_queued', 'active'];

// Mirrors services/underwriting-service/src/stages/employer-b.js's
// `computeInitialSlots(assignTier(score))` for the two tiers that are ever
// granted a nonzero cap (ADR-007). Duplicated here rather than imported:
// firebase.json's `functions.source` is "functions" only, so a Cloud
// Functions deploy never uploads services/underwriting-service — a
// cross-package `require` would compile locally and then fail to resolve in
// the deployed function. Keep the two literals below in sync with
// TIER_1_INITIAL_SLOTS / TIER_2_INITIAL_SLOTS in employer-b.js if either
// changes there.
const EMPLOYER_TIER_1_INITIAL_SLOTS = 10;
const EMPLOYER_TIER_2_INITIAL_SLOTS = 3;

/**
 * The employer-level loan concurrency cap to enforce when `maxActiveSlots`
 * has never been written (true for every employer that predates the
 * updateEmployerTier admin control — ADR-005 Finding 2).
 *
 * Fail-direction, deliberately NOT a flat 0: this codebase's credit-path
 * convention is to fail closed on missing data (getLoanConfigValues above;
 * decision-engine.js:66-72 in the underwriting service), and that is followed
 * here for a `riskTier` that is present but not 1 or 2 (e.g. 3, an actual
 * due-diligence rejection, or any other unrecognized value) — those get 0,
 * genuinely no capacity. But a `riskTier` that is simply ABSENT — the
 * default state of most of the existing employer book today, since neither
 * approveEmployer.ts nor onboarding ever sets it — is treated as Tier 2
 * (3 slots), not 0. That mirrors the existing fallback this exact function
 * already uses for the same field a few lines below
 * (`employerTier: employer['riskTier'] ?? 2` in the inline-ML call), and
 * avoids the alternative: a flat 0 default would silently zero out loan
 * origination for essentially every current employer the moment this ships,
 * since none of them have ever had a tier assigned. That is a materially
 * larger blast radius than the missing-config-document case the fail-closed
 * convention was written for, so it is not applied mechanically here. This
 * is a judgment call, not a settled ADR ruling — flagged for Isaac to
 * confirm, same as ADR-007's forfeit-vs-carry-forward question.
 */
function initialSlotsForEmployerTier(riskTier: unknown): number {
  const tier = riskTier ?? 2;
  if (tier === 1) return EMPLOYER_TIER_1_INITIAL_SLOTS;
  if (tier === 2) return EMPLOYER_TIER_2_INITIAL_SLOTS;
  return 0;
}

// ── Internal utilities ───────────────────────────────────────────────────────

async function auditLog(database: FirebaseFirestore.Firestore, entry: AuditLogEntry): Promise<void> {
  await database.collection(AUDIT_LOG_COLLECTION).add(buildAuditLogDocument(entry));
}

// A dropped notification job (Redis down, misconfigured REDIS_URL) must not
// break the loan/employer action that triggered it — same non-fatal contract
// `.catch(() => {})` gave the direct notifyLoanEvent() calls this replaces —
// but it also must not vanish into a bare `logger.warn` with nothing ops can
// query later. Mirrors notify.ts's recordSendFailure, which is the house
// style for "non-fatal send failure, recorded in audit_log" established
// alongside this fix.
async function recordNotificationEnqueueFailure(event: string, targetId: string, err: unknown): Promise<void> {
  try {
    await auditLog(db, {
      action: 'notification.enqueue_failed',
      actorUid: 'system',
      actorRole: 'system',
      targetId,
      meta: { event, error: err instanceof Error ? err.message : String(err) },
    });
  } catch (auditErr: unknown) {
    logger.warn('Failed to record notification enqueue failure in audit_log', {
      error: (auditErr as Error).message,
      service: 'functions',
    });
  }
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
    // Rate limit: 30 requests/min keyed on App Check token (unauth endpoint).
    // Fails CLOSED: this endpoint answers "does an account exist for this
    // address" to anyone, so the limit is the only thing between a caller and
    // a bulk membership oracle over an email list.
    const appCheckToken = (request as unknown as { app?: { appId?: string } }).app?.appId ?? 'anonymous';
    await enforceRateLimit(`rl:checkEmailAvailability:${appCheckToken}`, 30, 60, {
      onUnavailable: 'closed',
      context: 'checkEmailAvailability',
    });

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
    // Fails CLOSED: unauthenticated, and every call fans out to a metered
    // external identity API. A limiter outage here is a billing drain and a
    // CURP-enumeration surface, which is the same direction #534 settled for
    // the rest of this handler.
    const appCheckToken = (request as unknown as { app?: { appId?: string } }).app?.appId ?? 'anonymous';
    await enforceRateLimit(`rl:validateCURP:${appCheckToken}`, 10, 60, {
      onUnavailable: 'closed',
      context: 'validateCURP',
    });

    const { curp, expectedName, email } = (request.data ?? {}) as ValidateCURPData;

    if (!curp || typeof curp !== 'string' || !CURP_REGEX.test(curp.toUpperCase())) {
      throw new HttpsError('invalid-argument', 'Invalid CURP format');
    }

    // Test-mode bypass. Gated on the environment, not on the CURP prefix or the
    // email suffix — the caller picks both of those, so on their own they are a
    // self-service way to skip identity validation entirely.
    if (allowTestBypass() && (curp.toUpperCase().startsWith('VIDA') || (email && email.endsWith('@vida-test.com')))) {
      logger.info('Test-mode CURP bypass', { curp });
      return {
        valid: true,
        fullName: expectedName || 'Test Employee',
        dateOfBirth: '1990-01-15',
        gender: curp[10] === 'H' ? 'M' : 'F',
      };
    }

    // FAIL CLOSED. This endpoint answers one question — "is this a real CURP,
    // and does it belong to this person" — and every failure path below used to
    // answer it `valid: true` with a `fullName` copied straight out of the
    // caller's own `expectedName`. An adapter that is unconfigured, unreachable,
    // or rejecting us for a missing/rotated `INTERNAL_SECRET` therefore did not
    // degrade identity validation, it switched it off: any string matching
    // CURP_REGEX came back validated, under whatever name the caller asked for.
    // That is the same shape as the webhook verifiers in #534 — a check that
    // passes precisely when its dependency or its secret is absent — applied to
    // the identity gate of a regulated consumer lender.
    //
    // An outage now costs the caller an `unavailable` they can retry, never a
    // fabricated identity. Verified before changing: nothing calls this
    // callable today (Onboarding.tsx's `validateCURPRemote` is commented out —
    // CURP is extracted from the INE via MetaMap), so no live flow changes
    // behaviour. If it is ever re-enabled, the client must treat `unavailable`
    // as "try again", NOT as a rejection of the applicant.
    const adapterUrl = process.env['SOFTCREDITO_ADAPTER_URL'];
    const adapterSecret = process.env['INTERNAL_SECRET'] ?? '';
    if (!adapterUrl || !adapterSecret) {
      logger.error('CURP adapter not configured — refusing to validate', {
        hasUrl: !!adapterUrl,
        hasSecret: !!adapterSecret,
        service: 'functions',
      });
      throw new HttpsError(
        'unavailable',
        'La validación de identidad no está disponible en este momento. Intenta de nuevo.'
      );
    }

    try {
      const resp = await fetch(`${adapterUrl}/curp/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': adapterSecret,
        },
        body: JSON.stringify({
          curp: curp.toUpperCase(),
          ...(expectedName ? { expectedName } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        // Logged, never returned: the adapter's error body is an upstream
        // response about an identity document (#533).
        logger.error('CURP adapter error — refusing to validate', {
          status: resp.status,
          body: body.slice(0, 100),
          service: 'functions',
        });
        throw new HttpsError(
          'unavailable',
          'La validación de identidad no está disponible en este momento. Intenta de nuevo.'
        );
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
      // The `unavailable` thrown above lands here too — rethrow it unchanged
      // rather than re-wrapping it, and never fall through to a `valid: true`.
      if (e instanceof HttpsError) throw e;
      logger.error('CURP validation service unavailable — refusing to validate', {
        error: (e as Error).message,
        service: 'functions',
      });
      throw new HttpsError(
        'unavailable',
        'La validación de identidad no está disponible en este momento. Intenta de nuevo.'
      );
    }
  }
);

// ── getLoanConfig — employee only; the single place the UI reads pricing/term rules ──
// LoanWizard.tsx must call this rather than hardcoding the fee rate or term
// options, so the borrower-facing quote can never drift from what requestLoan
// actually charges (see config/loanConfig.ts).

// As of #389 the fee rate is read from the admin-editable config document, so
// this can now FAIL. That is intentional and must stay that way: a borrower
// seeing a rate nobody approved is the outcome we refuse.
//
// What the CLIENT does with a rejection changed. It used to surface in the
// eligibility-rejection card — the same screen as "you are not verified" and
// "you already have an active loan" — so an outage on our side was reported to
// an eligible borrower as a refusal, with no way to retry. LoanWizard.tsx now
// tracks pricing separately from eligibility: no figure renders at all (never
// 0 — a zero comisión quotes a free loan and a zero CAT is a false statement in
// a disclosure the law requires), every fee-derived step is blocked, and the
// borrower gets an in-place retry. The guarantee this callable depends on is
// unchanged and is pinned by LoanWizard.test.tsx: a rate that failed to load
// can never reach a quote or a submission.
// The quote also has to say WHEN the money comes out, and that is per-borrower
// rather than per-config: it is the first payday on or after the end of the
// term. It ships on this payload rather than its own callable so it inherits
// the same single loading/error state as the prices — a deduction date that
// failed to load must disappear from the quote exactly like a fee that failed
// to load, never render blank next to real figures (a blank date reads as
// "today").
//
// `estimatedDeductionDate` is still named for what it is, though it is a much
// better estimate since #437. It is now the same rule requestLoan will resolve
// the binding date with, evaluated against the clock at quote time; the two
// answers differ only if the borrower sits on the quote long enough to cross a
// payday. Once the loan exists the date is fixed and disbursement no longer
// moves it. `payFrequencySource` says how much to trust it: 'default_monthly'
// means we could not read the borrower's cadence and assumed one (#431), which
// must not be presented with the same confidence as a known date (#424).
export interface LoanQuoteConfig extends LoanConfig {
  estimatedDeductionDate: string;
  payFrequency: PayFrequency;
  payFrequencySource: PayFrequencySource;
}

export const getLoanConfig = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<Record<string, never>, LoanQuoteConfig>(['employee'], async (_data, auth) => {
    const config = await getLoanConfigValues();
    const { frequency, source } = await resolvePayFrequency(auth.uid);
    return {
      ...config,
      // Same rule requestLoan resolves the real due date with (#437), applied
      // to the term this quote is for. Quoting `calculateNextPayrollDate(freq)`
      // — the borrower's NEXT payday, days from now — would advertise a date
      // roughly a month before the one the loan will actually carry, which is
      // the "quoted a deduction date the system never uses" defect (#439) in a
      // new coat. One rule, applied twice, is fine; two rules is what #437 is.
      estimatedDeductionDate: calculateNextPayrollDate(
        frequency,
        new Date(Date.now() + config.defaultTermDays * 24 * 60 * 60 * 1000)
      )
        .toDate()
        .toISOString(),
      payFrequency: frequency,
      payFrequencySource: source,
    };
  })
);

// ── requestLoan — employee only ──────────────────────────────────────────────

interface RequestLoanData {
  amount: number;
  // The deployed UI (LoanWizard.tsx) sends `termDays`, not `term`. Keep this
  // in sync with the payload shape it actually sends — see loanConfig.ts.
  termDays?: number;
}

export const requestLoan = onCall(
  // Existing rate limit is 3/day/uid — intentionally stricter than the 20/min mutation default.
  { cors: true, enforceAppCheck: true },
  withAuth<RequestLoanData, { loanId: string; status: string; total: number; dueDate: string }>(
    ['employee'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'requestLoan', uid: auth.uid }, async () => {
        const { amount } = data;
        const term = data.termDays ?? DEFAULT_LOAN_TERM_DAYS;
        const uid = auth.uid;

        // Rate limit: max 3 requests per day. Fails CLOSED — this is the only
        // brake on loan-request spam per borrower, so a limiter outage must not
        // quietly turn "3 per day" into "unbounded".
        await enforceRateLimit(`rl:loan:${uid}`, 3, 86400, {
          onUnavailable: 'closed',
          message: 'Too many loan requests today',
          context: 'requestLoan',
        });

        if (typeof amount !== 'number' || amount < MIN_LOAN_AMOUNT || amount > MAX_LOAN_AMOUNT)
          throw new HttpsError('invalid-argument', 'El monto debe estar entre $500 y $5,000 MXN');
        if (!ALLOWED_LOAN_TERM_DAYS.includes(term)) throw new HttpsError('invalid-argument', 'Plazo inválido');

        const empRef = db.collection('employees').doc(uid);
        const emplDoc = await empRef.get();
        if (!emplDoc.exists) throw new HttpsError('not-found', VidaErrorCode.EMPLOYEE_NOT_FOUND);
        const emp = emplDoc.data()!;

        if (amount > emp['availableCredit'])
          throw new HttpsError('invalid-argument', 'El monto excede tu crédito disponible');
        if (amount > Math.round(emp['monthlySalary'] * EMPLOYEE_CREDIT_SALARY_RATIO))
          throw new HttpsError('invalid-argument', 'El monto excede el 30% de tu salario mensual');

        const active = await db
          .collection('loans')
          .where('employeeId', '==', uid)
          .where('status', 'in', ACTIVE_LOAN_STATUSES)
          .limit(1)
          .get();
        if (!active.empty)
          throw new HttpsError('failed-precondition', VidaErrorCode.DUPLICATE_LOAN_APPLICATION);

        const employerRef = db.collection('employers').doc(emp['employerId']);
        const employerSnap = await employerRef.get();
        const employer = employerSnap.data() ?? {};

        if (employer['status'] !== 'active' && employer['status'] !== 'pending_verification')
          throw new HttpsError('failed-precondition', VidaErrorCode.EMPLOYER_NOT_APPROVED);

        // The employer-wide concurrency-cap query, read for real INSIDE the
        // transaction below (tx.get) alongside the write it gates — never
        // here. Building the Query object is cheap and side-effect-free;
        // resolving it here and trusting the count would be exactly the race
        // this change exists to close (see the comment at the transaction).
        const activeEmployerLoansCountQuery = db
          .collection('loans')
          .where('employerId', '==', emp['employerId'])
          .where('status', 'in', ACTIVE_LOAN_STATUSES)
          .count();

        // Read the live, admin-approved rate. Fails closed (#389): if the config
        // document is unreadable or out of bounds this THROWS and no loan is
        // created, rather than pricing one at a rate nobody chose. Read here —
        // after validation, before the loan exists — so the failure costs the
        // borrower an error, never a mispriced obligation.
        const loanConfig = await getLoanConfigValues();
        const loanId = nanoid();
        const fee = Math.round(amount * loanConfig.feeRate);
        // THE loan's due date, resolved once and never recomputed (#437).
        //
        // It used to be `now + term` here and the borrower's next payroll date
        // again at disbursement (markLoanDisbursed.ts), from a different rule
        // and against a different clock. The second answer could — and for a
        // month-end borrower routinely did — land EARLIER than the first: same
        // fee, fewer days, so the CAT the borrower signed against was
        // understated. That is the one direction a CONDUSEF disclosure must
        // never be wrong in.
        //
        // So the governing date is decided here, where the disclosure is made:
        // the first real payday on or after `now + term`. It is payroll-aligned,
        // so disbursement has nothing left to correct, and it is never earlier
        // than the quoted term, so the disclosure below stays conservative.
        const { frequency: payFrequency, source: payFrequencySource } =
          await resolvePayFrequency(uid);
        const dueDate = calculateNextPayrollDate(
          payFrequency,
          new Date(Date.now() + term * 24 * 60 * 60 * 1000)
        );

        if (payFrequencySource === 'default_monthly') {
          // The cadence is now priced in at creation rather than guessed at
          // disbursement, so an assumed one is worth saying out loud here.
          logger.warn('Pricing a loan against an assumed monthly pay frequency', {
            loanId,
            uid,
            service: 'functions',
          });
        }

        // The repayment schedule and the CAT in force at creation, persisted on
        // the loan for the same reason `feeRate` is (#389): the contract PDF and
        // the disclosure must render what this borrower agreed to, not whatever
        // the code says later. Built from the SAME helper the payroll deduction
        // registration uses, so the quote, the contract and the deduction are
        // one schedule and not three (#424).
        const installments = buildLoanInstallments(amount + fee, dueDate.toDate(), term);

        // The CAT is deliberately computed on the code-owned 30-day `term`, NOT
        // on the real request→dueDate interval, and this change is priced
        // exactly as before: same fee, same term, same published figure.
        //
        // That is now CONSERVATIVE by construction. `dueDate` is the first
        // payday on or AFTER `now + term`, so the interval the borrower is
        // actually given is >= the 30 days the disclosure assumes — between 30
        // and roughly 30 + one pay cycle. A longer interval at the same fee
        // means a LOWER true CAT than the one disclosed. The disclosure can
        // therefore overstate the cost of credit but can no longer understate
        // it, which is the asymmetry that matters.
        //
        // Pricing the fee pro-rata over the real interval instead would be a
        // commercial decision, not a refactor, and is not made here.
        const catPercent = computeCatPercent(loanConfig.feeRate, term);

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
                employer: {
                  rfc: employer['rfc'] || '',
                  companyName: employer['companyName'] || '',
                  // ADR-007 slot ledger. Measured before adding these: this
                  // payload previously carried rfc + companyName ONLY, so
                  // employer-b's `employer.maxActiveSlots` was always
                  // undefined in production, `isReturning` was therefore
                  // always false, and `autoScaleTier1` — the whole hybrid
                  // growth rule ADR-007 ratified — was unreachable outside
                  // its unit tests. Every Tier-1 employer was re-granted a
                  // flat 10 on every single loan request, forever, and the
                  // 15/100 payrollHistory weight scored 0 for everyone.
                  //
                  // Passing the stored ledger makes the rule reachable. It
                  // does not by itself grant anyone a slot: nothing writes
                  // `cleanPayrollCyclesSinceReview`, so it reads 0, so
                  // autoScaleTier1 credits 0 increments and preserves the
                  // stored cap. The observable change today is that a
                  // Tier-1 cap stops being recomputed from scratch on every
                  // request and starts being a ledger. See ADR-009 Q1/Q2.
                  //
                  // `employerId` is deliberately NOT sent: employer-b's own
                  // Firestore write is keyed on it, and activating that
                  // would make the underwriting service a second concurrent
                  // writer of `maxActiveSlots` racing the block below.
                  // requestLoan stays the single writer (#487).
                  tier: typeof employer['tier'] === 'number' ? employer['tier'] : null,
                  maxActiveSlots: typeof employer['maxActiveSlots'] === 'number' ? employer['maxActiveSlots'] : 0,
                  cleanPayrollCycles: typeof employer['cleanPayrollCycles'] === 'number' ? employer['cleanPayrollCycles'] : 0,
                  cleanPayrollCyclesSinceReview:
                    typeof employer['cleanPayrollCyclesSinceReview'] === 'number'
                      ? employer['cleanPayrollCyclesSinceReview']
                      : 0,
                },
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

        // Both inline-ML gates below deny the applicant BEFORE the loan
        // transaction runs, so no loan document and no `loan.requested` audit
        // row is ever written for them. Without this record a denial is
        // invisible: ops cannot see that it happened, to whom, or on what
        // number. For a regulated consumer lender that is an adverse-action
        // decision with no auditable trace, so every denial path writes to
        // `audit_log` — the one collection firestore.rules grants ops read on
        // (firestore.rules:213) — before it throws.
        //
        // `targetId` is the loanId that WOULD have been used. No document
        // exists at loans/{loanId}; the id is here as the correlation key
        // between this row and the request's logs, not as a live reference.
        //
        // Fail-soft by construction: a failing audit write is swallowed and
        // logged. The borrower must receive the denial error the gate decided
        // on, never a different error caused by our own bookkeeping.
        //
        // Deliberately NOT recorded: CURP, RFC, CLABE. The uid, the amount and
        // the tripping number are what ops needs to review a denial; the
        // identity documents are not, and `audit_log` is a long-lived
        // ops-readable collection.
        const recordInlineMlDenial = async (
          gate: 'fraud_flag' | 'default_probability',
          gateDetail: Record<string, unknown>
        ): Promise<void> => {
          try {
            await auditLog(db, {
              action: 'loan.request_denied',
              actorUid: uid,
              actorRole: 'employee',
              targetId: loanId,
              meta: {
                deniedBy: 'inline_ml_gate',
                gate,
                amount,
                term,
                ...gateDetail,
                // The 6-stage pipeline's verdict at the moment the inline gate
                // fired. `null` means the pipeline was unreachable and this
                // gate is the only assessment that ran.
                uwDecision,
                uwCorrelationId: (uwResult?.['correlationId'] as string) ?? null,
                // ADR-001/ADR-004: the pipeline is the decision path. When it
                // HAS returned a verdict, this single-number gate is
                // second-guessing it — a `pending_review` ("a human must look
                // at this") becomes a flat denial the borrower sees as a
                // generic error. That override is current behaviour and is not
                // changed here; it is recorded explicitly so it is reviewable
                // rather than silent.
                overrodePipelineDecision: uwDecision !== null,
              },
            });
          } catch (auditErr: unknown) {
            logger.warn('Failed to record inline ML denial in audit_log', {
              gate,
              uid,
              loanId,
              error: (auditErr as Error).message,
              service: 'functions',
            });
          }
        };

        // Same auditable-record contract as `recordInlineMlDenial` above, for
        // the OTHER way this gate can fail to protect the applicant: not a
        // verdict, but an outage. `routedToReview` records whether this
        // outage actually changed the loan's fate (false when the 6-stage
        // pipeline had already reached its own verdict — see the override
        // note where this is called).
        const recordInlineMlOutage = async (
          reason: string,
          routedToReview: boolean
        ): Promise<void> => {
          try {
            await auditLog(db, {
              action: 'loan.ml_gate_unavailable',
              actorUid: uid,
              actorRole: 'employee',
              targetId: loanId,
              meta: {
                gate: 'ml_unavailable',
                reason,
                amount,
                term,
                routedToReview,
                uwDecision,
                uwCorrelationId: (uwResult?.['correlationId'] as string) ?? null,
              },
            });
          } catch (auditErr: unknown) {
            logger.warn('Failed to record inline ML outage in audit_log', {
              uid,
              loanId,
              error: (auditErr as Error).message,
              service: 'functions',
            });
          }
        };

        // The two signals below used to be hardcoded to 0 in the ML payload,
        // which permanently disabled the scorer's existing-debt and
        // request-frequency checks — every applicant looked debt-free and
        // first-time no matter their real history.
        //
        // `existingLoans` reads OUTSTANDING_STATUSES (loanStatus.ts), not the
        // narrower ACTIVE_LOAN_STATUSES the duplicate-application guard above
        // already enforces. That guard guarantees zero ACTIVE_LOAN_STATUSES
        // loans by the time we get here, so counting that same set would
        // always read 0 — reproducing the dead-signal bug one layer down.
        // OUTSTANDING_STATUSES additionally covers 'disbursed', 'overdue' and
        // 'in_collections', none of which block a new application, so a
        // borrower who already owes money — the exact case this signal exists
        // to catch — can still reach this query with a nonzero count.
        //
        // `requestsLastHour` is read from `audit_log` (actorUid + timestamp),
        // not from the `loans` collection: an inline-ML-denied attempt never
        // creates a loan document (recordInlineMlDenial writes an audit row
        // and throws before the loan transaction), so a `loans`-only count
        // would undercount exactly the rapid-fire-denial pattern this signal
        // is meant to flag. The query is scoped to `actorUid` only (not also
        // filtered to loan-request actions) because `actorUid + action +
        // timestamp` would need a composite index this deployment does not
        // have — see getReviewQueue's index-outage comment (#414) — while
        // `actorUid + timestamp` is exactly the index already declared in
        // firestore.indexes.json. A borrower's audit trail outside loan
        // requests is small enough in practice that this is a reasonable
        // proxy, not a precise count.
        const oneHourAgo = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
        const [outstandingLoansSnap, recentRequestsSnap] = await Promise.all([
          db
            .collection('loans')
            .where('employeeId', '==', uid)
            .where('status', 'in', OUTSTANDING_STATUSES)
            .get(),
          db.collection('audit_log').where('actorUid', '==', uid).where('timestamp', '>=', oneHourAgo).get(),
        ]);
        const existingLoans = outstandingLoansSnap.size;
        const requestsLastHour = recentRequestsSnap.size;

        // Set when the inline ML gate itself could not be reached — infra
        // (ML_SERVICE_URL unset, non-2xx, the 8s timeout, DNS/connection
        // error, malformed JSON), NOT a genuine fraud/default verdict. Those
        // still throw above and are unaffected. `null` means the gate ran to
        // completion (denied, or passed).
        let mlGateOutageReason: string | null = null;

        const loanExtra: Record<string, unknown> = {};
        try {
          const ml = await callML('/underwrite/employee', {
            employeeId: uid,
            monthlySalary: emp['monthlySalary'] ?? 0,
            employerTier: employer['riskTier'] ?? 2,
            existingLoans,
            bankClabe: emp['bankClabe'] ?? null,
            amount,
            requestsLastHour,
          });
          if (ml['fraud'] && (ml['fraud'] as Record<string, unknown>)['is_fraud']) {
            const fraud = ml['fraud'] as Record<string, unknown>;
            await recordInlineMlDenial('fraud_flag', {
              mlDecisionId: ml['decisionId'] ?? null,
              value: fraud['is_fraud'],
              bound: 'is_fraud === true',
              fraudScore: fraud['fraud_score'] ?? null,
            });
            throw new HttpsError('permission-denied', 'Solicitud marcada como sospechosa');
          }
          if ((ml['default_probability'] as number) > INLINE_ML_MAX_DEFAULT_PROBABILITY) {
            await recordInlineMlDenial('default_probability', {
              mlDecisionId: ml['decisionId'] ?? null,
              value: ml['default_probability'],
              bound: INLINE_ML_MAX_DEFAULT_PROBABILITY,
              comparison: `> ${INLINE_ML_MAX_DEFAULT_PROBABILITY}`,
              mlCreditScore: ml['credit_score'] ?? null,
            });
            throw new HttpsError('failed-precondition', 'No es posible aprobar tu solicitud en este momento');
          }
          Object.assign(loanExtra, {
            mlDecisionId: ml['decisionId'],
            mlCreditScore: ml['credit_score'],
            mlDefaultProb: ml['default_probability'],
          });
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          mlGateOutageReason = (e as Error).message;
          logger.warn('ML unavailable', { error: mlGateOutageReason, service: 'functions' });
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

        // Fail CLOSED, not soft: an infra failure of the inline ML gate means
        // neither gate ran (the 6-stage pipeline is optional/rare-in-pilot —
        // see the mapping above — and often never configured at all). Letting
        // `initialStatus` stay at its 'pending' default here is exactly what
        // silently turned a credit gate into a no-op — 'pending' loans are
        // eligible for the same ops/employer approval → disbursement path as
        // any fully-underwritten loan, with nobody, human or model, ever
        // having looked at this one.
        //
        // Routes to the SAME `under_review` state and `review_queue` path
        // Stage 5 already uses for `pending_review` above — not a new status
        // — so the loan is reachable through submitReviewDecision like any
        // other manual review, and stays usable during an ML outage instead
        // of hard-erroring every applicant.
        //
        // Only overrides the 'pending' default: a `uwDecision` of
        // rejected/approved/pending_review means the 6-stage pipeline already
        // assessed this applicant, and that verdict is not second-guessed by
        // this gate's own outage (mirrors the override note on
        // `recordInlineMlDenial` above — the pipeline is the decision path).
        const mlGateFellOpen = mlGateOutageReason !== null && initialStatus === 'pending';
        if (mlGateFellOpen) {
          initialStatus = 'under_review';
        }
        if (mlGateOutageReason !== null) {
          await recordInlineMlOutage(mlGateOutageReason, mlGateFellOpen);
        }
        const holdCredit = initialStatus !== 'rejected';

        // Persist the Stage 3 auto-approve condition breakdown so ops can see WHY
        // a loan was approved/denied, not just the coarse decision. Fail-soft: if
        // underwriting is down or the pipeline never reached Stage 3 (e.g. an
        // earlier-stage rejection), omit the record entirely — never block loan
        // creation over missing explainability data.
        //
        // `uwResult` is the /underwrite HTTP response, NOT the raw
        // decision-engine return value — the two are different shapes and must
        // not be conflated. The endpoint deliberately publishes a lean
        // top-level `conditions`/`allPass` slice (services/underwriting-service
        // /index.js) precisely so this caller does not have to reach into the
        // verbose `stages` payload. Read the lean slice first: it is the
        // narrow, stable contract, and `stages` is the part that may later be
        // trimmed off the wire for payload size.
        //
        // The nested read is a defensive fallback only, for a service old
        // enough to predate the lean slice. Both are populated today.
        //
        // Each condition carries the applicant's ACTUAL bureau score, LTI,
        // RiskSeal fraud score and ML default probability alongside the bound it
        // was tested against (stage3-autoapprove.js) — regulated/borrower-
        // sensitive values, not a bare pass/fail flag, and exactly the numbers a
        // fraud applicant would want in order to learn where each gate sits.
        // This must NOT go on the `loans/{loanId}` document itself: that
        // document is readable by the loan's own borrower and by the employer's
        // admin (firestore.rules `isOwner`/`isEmployerAdminOf`), so writing it
        // there would hand every applicant their own bureau/fraud/model scores
        // and the exact thresholds over a plain client read. It is written to a
        // subcollection instead so it stays attached to the loan record without
        // inheriting the loan document's read rule, gated `isOps()`-only in
        // firestore.rules — the same ops-only pattern already used for
        // `audit_log`.
        const uwStages = uwResult?.['stages'] as Record<string, unknown> | undefined;
        const stage3 = uwStages?.['stage3'] as Record<string, unknown> | undefined;
        const stage3Data = stage3?.['data'] as Record<string, unknown> | undefined;
        const uwConditions = uwResult?.['conditions'] ?? stage3Data?.['conditions'];
        const uwAllPass = uwResult?.['allPass'] ?? stage3Data?.['allPass'];
        let underwritingDetail: Record<string, unknown> | null = null;
        if (Array.isArray(uwConditions) && uwConditions.length > 0) {
          underwritingDetail = {
            decision: uwDecision,
            reason: (uwResult?.['reason'] as string) ?? null,
            allPass: (uwAllPass as boolean) ?? null,
            conditions: uwConditions,
            evaluatedAt: FieldValue.serverTimestamp(),
          };
        }

        // ADR-008: employer-b (due diligence — services/underwriting-service
        // /src/stages/employer-b.js) computes the employer's lending
        // CAPACITY from its tier/score. Nothing previously wired that number
        // into `maxActiveSlots`, the one field the transaction below actually
        // enforces (ADR-005 Finding 2) — so a Tier 1 employer due diligence
        // scored for 10 slots stayed capped at the riskTier-absent fallback
        // of 3 forever. Persist it here.
        //
        // This is capacity plumbing on the loan-creation path, not a loan
        // decision, so it runs in its own transaction/try-catch, entirely
        // separate from the loan-creation transaction below: a failure here
        // must never block the loan itself, matching the fail-soft
        // convention `underwritingDecision` above and `recordInlineMlDenial`
        // follow for the same reason.
        //
        // Ops override always wins over an automated re-score
        // (updateEmployerTier's `approve_expansion` sets
        // `maxActiveSlotsSource: 'ops_override'`): due diligence only writes
        // `maxActiveSlots` when the stored source is not `'ops_override'`. A
        // MISSING source is NOT an override, so due diligence may still
        // write over a seeded/legacy value that predates this field.
        const employerBResult = uwStages?.['employerB'] as Record<string, unknown> | undefined;
        const dueDiligenceMaxSlots = employerBResult?.['maxActiveSlots'];
        const dueDiligenceTier = employerBResult?.['tier'];
        // ADR-007's hybrid growth detail for this review, when it ran:
        // `{cyclesConsidered, incrementsCredited, cyclesForfeited,
        // slotsBefore, slotsAfter}`. Null when the employer was granted a
        // fresh tier-initial cap rather than an incremented one.
        const dueDiligenceSlotGrowth = (employerBResult?.['slotGrowth'] ?? null) as Record<
          string,
          unknown
        > | null;
        if (typeof dueDiligenceMaxSlots === 'number') {
          try {
            let auditBefore: Record<string, unknown> | null = null;
            let auditAfter: Record<string, unknown> | null = null;
            await db.runTransaction(async (tx) => {
              const empSnap = await tx.get(employerRef);
              const empData = empSnap.data() ?? {};

              // ADR-007 named `tier` as one of the three ledger fields the
              // employer document was missing. It is what tells the NEXT
              // review which slot ladder this employer is standing on:
              // employer-b re-enters Tier 1's auto-scale ladder or Tier 2's
              // fixed bands based on it, and without it a downgraded
              // employer would carry a Tier-1 slot count onto the Tier-2
              // ladder. Distinct from `riskTier` (ML-assigned, ADR-005
              // Finding 2) — see DATABASE.md, which now states the
              // relationship between the two.
              //
              // Written whether or not ops owns the cap: `ops_override`
              // means ops owns the NUMBER, not the score behind it. That is
              // the same split employer-b.js's own transaction makes when it
              // freezes `maxActiveSlots` but still refreshes score/tier.
              const ledgerUpdate: Record<string, unknown> = {};
              if (typeof dueDiligenceTier === 'number') ledgerUpdate['tier'] = dueDiligenceTier;

              if (empData['maxActiveSlotsSource'] !== 'ops_override') {
                auditBefore = {
                  maxActiveSlots: empData['maxActiveSlots'] ?? null,
                  maxActiveSlotsSource: empData['maxActiveSlotsSource'] ?? null,
                };
                const capUpdate = {
                  maxActiveSlots: dueDiligenceMaxSlots,
                  maxActiveSlotsSource: 'due_diligence',
                };
                auditAfter = capUpdate;
                Object.assign(ledgerUpdate, capUpdate);
              }

              if (Object.keys(ledgerUpdate).length > 0) tx.update(employerRef, ledgerUpdate);
            });
            if (auditAfter) {
              await auditLog(db, {
                action: 'employer.due_diligence_cap',
                actorUid: uid,
                actorRole: 'employee',
                targetId: emp['employerId'],
                before: auditBefore,
                after: auditAfter,
                // ADR-007 caps credit at 2 increments per review and
                // FORFEITS the surplus. A forfeit that leaves no trace is
                // indistinguishable from a cycle that was never earned, so
                // the count is recorded here rather than only being returned
                // and dropped.
                meta: { slotGrowth: dueDiligenceSlotGrowth },
              });
            }
          } catch (e: unknown) {
            logger.warn('Failed to persist due-diligence maxActiveSlots', {
              error: (e as Error).message,
              employerId: emp['employerId'],
              loanId,
              service: 'functions',
            });
          }
        }

        await db.runTransaction(async (tx) => {
          // Employer slot cap (ADR-005 Finding 2 / ADR-007): both reads that
          // decide whether this loan is allowed to exist — the employer's
          // cap and how many of its slots are already occupied — happen
          // INSIDE this transaction, alongside the write that would occupy
          // one more. A read taken before the transaction (as the guards
          // above deliberately do NOT do for this check) is decorative for a
          // cap: two concurrent requests would both read N-1-of-N used and
          // both commit, overshooting the cap by exactly the race this
          // change exists to prevent.
          //
          // `tx.get()` on a Query (here, an aggregate `.count()`) is
          // documented by the Admin SDK to hold a pessimistic lock on every
          // document matched by the underlying query — including documents
          // that come to match it before this transaction commits. A second,
          // concurrent requestLoan for the same employer that would push the
          // count over the cap is therefore not just reading stale data, it
          // is forced to retry against this transaction's write, which is
          // the actual guarantee a slot cap needs.
          //
          // Both reads happen before any write in this transaction, per
          // Firestore's requirement that all reads precede all writes.
          const [employerTxSnap, activeCountSnap] = await Promise.all([
            tx.get(employerRef),
            tx.get(activeEmployerLoansCountQuery),
          ]);
          const employerTxData = employerTxSnap.data() ?? {};
          const storedMaxSlots = employerTxData['maxActiveSlots'];
          const maxSlots =
            typeof storedMaxSlots === 'number'
              ? storedMaxSlots
              : initialSlotsForEmployerTier(employerTxData['riskTier']);

          // Seed: this employer has never had maxActiveSlots written (true
          // for every employer that predates the updateEmployerTier admin
          // control). Persist the computed value now so it is a real,
          // ops-visible number the next updateEmployerTier audit log's
          // `before` snapshot can show, instead of staying undefined
          // forever. Tagged `update`, not `set`, since the employer document
          // is already known to exist (its `status` was read and checked
          // above) — an update here can never race a document creation.
          if (typeof storedMaxSlots !== 'number') {
            tx.update(employerRef, { maxActiveSlots: maxSlots });
          }

          if (activeCountSnap.data().count >= maxSlots) {
            throw new HttpsError('failed-precondition', VidaErrorCode.EMPLOYER_SLOT_LIMIT_REACHED);
          }

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
            // The rate IN FORCE at creation, persisted on the loan itself. The
            // fee rate is admin-editable as of #389, and a later change must
            // never reprice a loan the borrower has already signed — every
            // downstream consumer (contract PDF, CAT disclosure, statements)
            // reads this field, not the live config.
            feeRate: loanConfig.feeRate,
            total: amount + fee,
            term,
            status: initialStatus,
            dueDate,
            // The cadence `dueDate` was resolved against, frozen onto the loan
            // (#437). `resolvePayFrequency` reads this field first, so every
            // later reader — disbursement above all — re-derives the SAME date
            // instead of forming a second opinion from a borrower record that
            // may have changed in between. `payFrequencySource` records how
            // that cadence was arrived at; 'default_monthly' means it was
            // assumed, and a date built on an assumption should be legible as
            // one for the life of the loan (#431).
            borrowerSnapshot: { payFrequency },
            payFrequencySource,
            repaymentSchedule: installments.map((i) => ({
              number: i.number,
              amount: i.amount,
              dueDate: Timestamp.fromDate(i.dueDate),
            })),
            catPercent,
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

          // Same transaction as the loan write above: a decision can never be
          // persisted without its breakdown, or vice versa. See the comment at
          // `underwritingDetail`'s construction for why this is a subcollection
          // rather than a field on the loan doc.
          if (underwritingDetail) {
            tx.set(
              db.collection('loans').doc(loanId).collection('underwritingDetail').doc('detail'),
              underwritingDetail
            );
          }

          // The loan just landed as 'under_review' because the ML gate that
          // would have assessed it was unreachable (`mlGateFellOpen` above),
          // not because Stage 5 put it there. `under_review` is only
          // resolvable through submitReviewDecision, which acts on a
          // `review_queue` document, not on the loan directly (#407) — so
          // without this write the loan would be stranded `under_review`
          // forever, findable by no ops screen, exactly the dead end #407's
          // DECIDABLE_REVIEW_STATUSES comment describes. Written in the same
          // transaction as the loan itself so the two can never land apart.
          if (mlGateFellOpen) {
            tx.set(db.collection('review_queue').doc(), {
              loanId,
              correlationId: uwResult?.['correlationId'] ?? null,
              reason: 'ml_gate_unavailable',
              priority: 3,
              applicantName: emp['name'] ?? null,
              applicantRfc: emp['rfc'] ?? null,
              queuedAt: new Date().toISOString(),
              assignedTo: null,
              status: 'pending_review',
              slaDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              reviewedAt: null,
              reviewedBy: null,
              reviewDecision: null,
              reviewNotes: null,
            });
          }
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
      // Rate limit: 20/min/uid (mutation). Fail closed: this is the live
      // callable that writes loans/{loanId}.status, including
      // post-disbursement transitions — an outage must not lift the only
      // brake on it.
      await enforceRateLimit(`rl:updateLoanStatus:${request.auth!.uid}`, 20, 60, {
        onUnavailable: 'closed',
        context: 'updateLoanStatus',
      });

      const { loanId, status, note } = request.data as UpdateLoanStatusData;

      if (!loanId || !status) throw new HttpsError('invalid-argument', 'loanId and status are required');
      // Closes the vocabulary-drift entry point: this callable used to accept
      // any string, so ops (or a runbook typo) could write a spelling like
      // 'paid' that no report reader recognizes as repaid. Validating against
      // the single canonical vocabulary (functions/src/loans/loanStatus.ts)
      // makes that class of drift impossible going forward without narrowing
      // which of the real, live statuses ops can set — every one of them is
      // still allowed.
      if (!(ALL_LOAN_STATUSES as readonly string[]).includes(status)) {
        throw new HttpsError(
          'invalid-argument',
          `Unknown loan status '${status}'. Must be one of: ${ALL_LOAN_STATUSES.join(', ')}`
        );
      }

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
      } else if (
        DISBURSEMENT_INITIATED_STATUSES.includes(loan['status'] as string) &&
        !DISBURSEMENT_INITIATED_STATUSES.includes(status)
      ) {
        // Once disbursement has started, a loan may only be moved WITHIN
        // DISBURSEMENT_INITIATED_STATUSES. Ops correction paths inside that set
        // stay open (disbursement_failed → disbursement_queued to retry,
        // overdue → in_collections → written_off/repaid); every exit out of it
        // is refused.
        //
        // This used to be gated on the destination being in
        // PRE_DISBURSEMENT_STATUSES, i.e. it only blocked
        // post → pending/under_review/approved. But three canonical statuses —
        // 'rejected', 'rejected_ml' and 'cancelled' — are in NEITHER set, so
        // they were reachable from a funded loan and became a laundering route
        // straight around the guard:
        //
        //   1. disbursed → cancelled   (allowed: 'cancelled' ∉ PRE_DISBURSEMENT)
        //   2. cancelled → pending     (allowed: 'cancelled' ∉ DISBURSEMENT_INITIATED)
        //   3. pending   → rejected    → isCreditReleasingRejection fires and
        //      onLoanStatusChange hands the borrower their availableCredit back
        //      for a loan whose money actually went out and was never repaid —
        //      exactly what the comment on LOAN_REJECTION_SOURCE_STATUSES says
        //      must never happen. (Step 3 → 'approved' instead is the SPEI
        //      replay; that one is additionally caught by onLoanApproved's
        //      disbursement_queue/disbursedAt idempotency claim, but the credit
        //      path has no such second guard.)
        //
        // Step 1 is also harmful on its own: 'rejected'/'cancelled' are not in
        // DEDUCTIBLE_STATUSES, so processPayroll silently stops collecting on a
        // loan that has already been funded — the same harm submitReviewDecision
        // refuses below by gating on the source status alone.
        throw new HttpsError(
          'failed-precondition',
          `Cannot move loan from '${loan['status']}' to '${status}' — disbursement has already started`
        );
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
  // This callable has only ever implemented approval — see the guard below.
  // Both fields are accepted (not just read and discarded) purely so a
  // reject request can be told apart from an approve request and refused
  // loudly. EmployerMgmt.tsx sends `approved`; AdminDashboard.tsx sends
  // `decision`. Neither shape drives any approve/reject branching here.
  approved?: boolean;
  decision?: 'approved' | 'rejected';
}

export const approveEmployer = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<ApproveEmployerData, { success: boolean; approved: boolean; reason?: string }>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'approveEmployer', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation). Fail closed: this is the live
        // employer-approval callable — an outage must not lift the only
        // brake on it.
        await enforceRateLimit(`rl:approveEmployer:${auth.uid}`, 20, 60, {
          onUnavailable: 'closed',
          context: 'approveEmployer',
        });

        const { employerUid, approved, decision } = data;
        if (!employerUid) throw new HttpsError('invalid-argument', 'employerUid is required');

        // This handler has no reject branch — every call below unconditionally
        // activates the employer. Before this guard, AdminDashboard.tsx's
        // "reject employer" button (`decision: 'rejected'`) and a would-be
        // reject from EmployerMgmt.tsx (`approved: false`) both silently
        // APPROVED the employer instead — activating them, scoring them, and
        // emailing an approval notice — with no error surfaced to the admin
        // who clicked reject. Fail loudly instead of doing the opposite of
        // what was asked. A real reject branch needs a decision record, a
        // notification template and an appeal path, so it is left out here
        // deliberately rather than bolted on.
        if (approved === false || decision === 'rejected') {
          throw new HttpsError(
            'unimplemented',
            'Rejecting an employer application is not yet supported'
          );
        }

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
          // KNOWN, DELIBERATELY NOT FIXED HERE: this is the same fail-open
          // defect as requestLoan's inline ML gate above — an infra failure
          // (ML_SERVICE_URL unset, non-2xx, timeout, DNS, bad JSON) is not a
          // verdict, yet the `status: 'active'` write a few lines up stays in
          // force and the employer_admin claim below is still minted, so an
          // employer nobody assessed ends up fully approved.
          //
          // It is left alone in this change because the loan-side fix can
          // degrade to manual review while this one cannot: employers have no
          // review queue, so failing closed means refusing the approval
          // outright, which bricks onboarding end-to-end if ML_SERVICE_URL
          // turns out to be unreachable from Cloud Functions (the secret is
          // wired in deploy.yml, but railway-setup-env.yml points it at
          // `*.railway.internal`, which is not resolvable from GCP). That
          // reachability question has to be answered before this can fail
          // closed safely. Tracked separately — do not "fix" it blind.
          logger.warn('ML scoring unavailable', { error: (e as Error).message, service: 'functions' });
        }

        // Grant the employer_admin claim. THIS is the approval gate for it:
        // onEmployerDocCreated deliberately withholds the claim at self-signup
        // (firestore.rules pins a self-created employer to
        // 'pending_verification', and granting on creation would be
        // self-service privilege escalation), so an employer becomes an
        // employer_admin here and nowhere else on the normal path.
        //
        // Without this the deployed handler activated the employer, emailed
        // them an approval notice, and left them with no role claim at all —
        // every withAuth(['employer_admin']) callable (ensureEmployerCode,
        // submitEmployerDocs, submitPayrollDeductionSetup,
        // updateEmployerCurpConfig) plus processPayroll answered
        // permission-denied, and no client calls the setEmployerClaims
        // fallback, so there was no in-product remedy. The grant existed only
        // in functions/src/employers/approveEmployer.ts, which index.ts does
        // not export and which is therefore not deployed.
        //
        // Placed AFTER the ML block on purpose: an ML rejection returns early
        // above with status 'rejected_ml', and that employer must not walk away
        // holding the claim.
        //
        // Audit first, mint second, and let an audit failure propagate — the
        // same ordering onEmployerDocCreated and setEmployerClaims already
        // hold. An employer_admin grant nobody can attribute is worse than no
        // grant at all.
        await auditLog(db, {
          action: 'employer.claimGrantedOnApproval',
          actorUid: auth.uid,
          actorRole: auth.role,
          actorEmail: auth.email ?? null,
          targetId: employerUid,
          after: { role: 'employer_admin' },
        });
        await admin.auth().setCustomUserClaims(employerUid, { role: 'employer_admin' });

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

        // No separate 'employer_approved' send here (direct or enqueued): the
        // 'employer_activated' job queued above IS this notification — the
        // worker's switch statement treats employer_approved and
        // employer_activated as literally the same case (notificationWorker.ts
        // case 'employer_approved': case 'employer_activated': — one email,
        // one SendGrid template, keyed off the same employer['email']). This
        // used to also call notifyLoanEvent('employer_approved', ...) directly,
        // which never sent anything in production (SENDGRID_API_KEY is only
        // ever set on the Railway notification-service worker, never on the
        // Firebase Functions runtime), so removing it changes nothing observable
        // today. Enqueueing a second 'employer_approved' job instead of removing
        // the call would have "fixed" it into a live duplicate-send bug the
        // moment this ships — the employer would get the same activation email
        // twice for one approval.

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
        // Rate limit: 10/min/uid (expensive aggregation across all loans).
        // Fail open: read-only report, admin-only — the limit protects
        // query capacity, not money or a secret.
        await enforceRateLimit(`rl:getPortfolioReport:${auth.uid}`, 10, 60, {
          onUnavailable: 'open',
          context: 'getPortfolioReport',
        });

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
        // Deliberately fails OPEN. This is a read-only view: the limit is
        // here to protect capacity, not money or secrets, so a limiter
        // outage should degrade to an unthrottled dashboard rather than
        // to a dashboard nobody can open. Contrast the spend- and
        // enumeration-critical limits, which fail closed.
        await enforceRateLimit(`rl:getAdminDashboard:${auth.uid}`, 60, 60, {
          onUnavailable: 'open',
          context: 'getAdminDashboard',
        });

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

// Same rule as REVIEW_DETAIL_EMPLOYER_FIELDS, applied to the employer's own view
// of themselves. This handler returned `empDoc.data()` whole, so every dashboard
// load put `apiKeyHash` — the payroll-integration credential — plus `bankClabe`,
// `rfc`, `mlScore` and `llmAnalysis` into the browser.
//
// Neither consumer reads any of it: public-v2/src/pages/EmployerDashboard.tsx
// and public/js/app.js both render the employer from their own `employers/{uid}`
// document read and use only `stats` off this response. So the credential was
// shipped for nothing. The listed fields are the ones the two dashboards' own
// employer types declare — kept so a latent reader of this payload still works.
const EMPLOYER_DASHBOARD_FIELDS = [
  'companyName',
  'name',
  'email',
  'employerCode',
  'status',
  'totalEmployees',
  'docRFC',
  'docId',
  'docAddress',
  'sampleCurps',
  'partBStatus',
  'curpConfig',
] as const;

export const getEmployerDashboard = onCall(
  { cors: true, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

    return withErrorHandling({ functionName: 'getEmployerDashboard', uid: request.auth.uid }, async () => {
      // Rate limit: 60/min/uid (read-only dashboard). Fail open: protects
      // capacity, not money or a secret.
      await enforceRateLimit(`rl:getEmployerDashboard:${request.auth!.uid}`, 60, 60, {
        onUnavailable: 'open',
        context: 'getEmployerDashboard',
      });

      const uid = request.auth!.uid;

      const [empDoc, loans, employees] = await Promise.all([
        db.collection('employers').doc(uid).get(),
        db.collection('loans').where('employerId', '==', uid).orderBy('createdAt', 'desc').limit(50).get(),
        db.collection('employees').where('employerId', '==', uid).get(),
      ]);

      if (!empDoc.exists) throw new HttpsError('not-found', 'Employer not found');

      const loanDocs = loans.docs.map((d) => ({ id: d.id, ...d.data() }));

      return {
        employer: projectDoc(empDoc, EMPLOYER_DASHBOARD_FIELDS),
        loans: loanDocs,
        employeeCount: employees.size,
        stats: computeEmployerDashboardStats(loanDocs, employees.size),
      };
    });
  }
);

// ── submitReviewDecision — ops/admin Stage 5 review action ───────────────────

// Statuses a review can still be decided from.
//   pending / pending_review — never decided yet
//   info_requested           — ops asked the employee for a document; the answer has to be
//                              able to land, so this must stay decidable. Treating it as
//                              terminal stranded the loan in `under_review`, which
//                              requestLoan counts as an occupied slot — one click locked
//                              the employee out of the product permanently (#407).
const DECIDABLE_REVIEW_STATUSES = ['pending', 'pending_review', 'info_requested'];

// `escalated` is decidable too, but only from a role above the ops user who escalated it.
// That is what makes escalation mean something without building a separate supervisor
// queue — and it keeps the review resolvable instead of a dead end (#407).
const ESCALATED_DECIDER_ROLES = ['admin', 'super_admin'];

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
        // Rate limit: 20/min/uid (mutation). Fail closed: this decides loan
        // approve/reject and writes loans/{loanId}.status — an outage must
        // not lift the only brake on it.
        await enforceRateLimit(`rl:submitReviewDecision:${auth.uid}`, 20, 60, {
          onUnavailable: 'closed',
          context: 'submitReviewDecision',
        });

        const { reviewId, decision, notes } = data;
        if (!reviewId || !decision) throw new HttpsError('invalid-argument', 'reviewId and decision are required');
        if (!['approved', 'rejected', 'request_info', 'escalate'].includes(decision))
          throw new HttpsError('invalid-argument', 'Invalid decision. Must be approved, rejected, request_info, or escalate');

        const reviewSnap = await db.collection('review_queue').doc(reviewId).get();
        if (!reviewSnap.exists) throw new HttpsError('not-found', 'Review not found');
        const review = reviewSnap.data()!;

        const reviewStatus = review['status'] as string;
        if (reviewStatus === 'escalated') {
          if (!ESCALATED_DECIDER_ROLES.includes(auth.role))
            throw new HttpsError(
              'permission-denied',
              'Esta revisión fue escalada y solo un administrador puede resolverla'
            );
          if (decision === 'escalate')
            throw new HttpsError('failed-precondition', 'Review is already escalated');
        } else if (!DECIDABLE_REVIEW_STATUSES.includes(reviewStatus)) {
          throw new HttpsError('failed-precondition', 'Review has already been resolved');
        }

        // Same rewind guard updateLoanStatus carries (#488), applied to the
        // OTHER callable that writes loans/{loanId}.status. It was missing here.
        //
        // `request_info` and `escalated` reviews stay decidable indefinitely by
        // design (#407/#513), but the loan they point at does not stand still:
        // ops can approve the loan itself through updateLoanStatus, onLoanApproved
        // queues the real SoftCrédito transfer, and the stale review is still in
        // the queue. Deciding it then rewrote a funded loan's status from the
        // console — 'rejected' takes it out of DEDUCTIBLE_STATUSES, so
        // processPayroll silently stops collecting on money that has already been
        // paid out; 'approved' reproduces the approval trigger diff on a loan that
        // has already disbursed, which is exactly the SPEI replay #488 exists to
        // refuse.
        //
        // Checked BEFORE the review_queue write below so a refusal leaves the
        // review exactly as it was and still decidable, rather than half-applied.
        // Only approve/reject are gated — request_info and escalate never touch
        // the loan, and blocking them would recreate the #407 dead end.
        if (review['loanId'] && (decision === 'approved' || decision === 'rejected')) {
          const loanSnap = await db.collection('loans').doc(review['loanId'] as string).get();
          const loanStatus = loanSnap.exists ? (loanSnap.data()!['status'] as string) : null;
          if (loanStatus && DISBURSEMENT_INITIATED_STATUSES.includes(loanStatus)) {
            throw new HttpsError(
              'failed-precondition',
              `Loan is already '${loanStatus}' — disbursement has started, so this review can no longer change it`
            );
          }
        }

        const now = FieldValue.serverTimestamp();

        const statusMap: Record<string, string> = {
          approved: 'approved',
          rejected: 'rejected',
          request_info: 'info_requested',
          escalate: 'escalated',
        };

        // The review decision and the loan status it drives are one fact, not
        // two: two independent `.update()` calls left a window where the
        // review_queue write could land — moving the review out of
        // DECIDABLE_REVIEW_STATUSES, so it can never be resubmitted through
        // this callable again — while the loans write then failed (a
        // transient Firestore error, contention, an outage). That stranded
        // the loan in `under_review` forever: the review says decided, the
        // loan says undecided, and nothing in the product can reconcile the
        // two without a manual Firestore edit. Bundling both writes in one
        // transaction makes them land together or not at all, so a failure
        // here leaves the review exactly as decidable as it was and the
        // caller sees the error and can simply retry.
        await db.runTransaction(async (tx) => {
          tx.update(db.collection('review_queue').doc(reviewId), {
            status: statusMap[decision],
            reviewedBy: auth.uid,
            reviewedAt: now,
            reviewNotes: notes || null,
            ...(decision === 'escalate' ? { escalatedAt: now, escalatedBy: auth.uid } : {}),
            ...(decision === 'request_info' ? { infoRequestedAt: now, infoRequestedBy: auth.uid } : {}),
          });

          // If the review is tied to a loan, update the loan status (only for approve/reject)
          if (review['loanId'] && (decision === 'approved' || decision === 'rejected')) {
            tx.update(db.collection('loans').doc(review['loanId'] as string), {
              status: decision,
              statusNote: notes || null,
            });
          }
        });

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

// Exactly the fields ReviewDetail.tsx renders, and nothing else.
//
// This used to be `{ id, ...snap.data() }` for both documents, which shipped the
// whole stored record to the browser on every ops page view. The employer
// document is the sharp one: it carries `apiKeyHash` — the payroll-integration
// credential — plus `bankClabe`, `rfc`, `email`, `mlScore` and `llmAnalysis`
// (see the EMPLOYERS COLLECTION block in firestore.rules). The console renders
// three of those fields. The employee document likewise carries bank details and
// identity documents beyond the five the screen shows.
//
// Access control on the caller was never the gap — only ops/admin/super_admin
// reach this handler. The gap is the response boundary: an XSS, a stolen
// session, or a browser extension reading the callable's response walks the
// whole book one review at a time and collects the employer credential surface
// with it. Least privilege applies to what comes back, not just to who asks.
//
// Allowlist, not denylist, on purpose: a field added to the Firestore document
// next quarter stays invisible here until someone names it deliberately. If a
// screen needs another field, add it to this list — do NOT spread the document
// back in.
const REVIEW_DETAIL_EMPLOYEE_FIELDS = ['rfc', 'curp', 'email', 'phone', 'monthlySalary'] as const;
const REVIEW_DETAIL_EMPLOYER_FIELDS = ['companyName', 'industry', 'riskTier'] as const;

// Absent fields are omitted rather than nulled: the console already renders a
// missing field as "—", and null would assert the value is known to be empty.
function projectDoc(
  snap: FirebaseFirestore.DocumentSnapshot | null,
  fields: readonly string[]
): Record<string, unknown> | null {
  if (!snap?.exists) return null;
  const data = snap.data()!;
  const projected: Record<string, unknown> = { id: snap.id };
  for (const field of fields) {
    if (data[field] !== undefined) projected[field] = data[field];
  }
  return projected;
}

export const getReviewDetail = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<GetReviewDetailData, ReviewDetailResult>(
    ['ops', 'admin', 'super_admin'],
    async (data, _auth) =>
      withErrorHandling({ functionName: 'getReviewDetail', uid: _auth.uid }, async () => {
        // Rate limit: 60/min/uid (read-only detail view). Fail open:
        // protects capacity, not money or a secret.
        await enforceRateLimit(`rl:getReviewDetail:${_auth.uid}`, 60, 60, {
          onUnavailable: 'open',
          context: 'getReviewDetail',
        });

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

        const employee = projectDoc(employeeSnap, REVIEW_DETAIL_EMPLOYEE_FIELDS);
        const employer = projectDoc(employerSnap, REVIEW_DETAIL_EMPLOYER_FIELDS);
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
        // Rate limit: 20/min/uid (mutation). Fail closed: this changes an
        // employer's active-loan slot cap and risk tier — a lever on
        // aggregate loan exposure — an outage must not lift the only brake
        // on it.
        await enforceRateLimit(`rl:updateEmployerTier:${auth.uid}`, 20, 60, {
          onUnavailable: 'closed',
          context: 'updateEmployerTier',
        });

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
          // ADR-008: an ops-approved expansion always outranks the next
          // automated due-diligence re-score (requestLoan's ADR-008 block) —
          // tag the source so that write knows to leave this value alone.
          update['maxActiveSlotsSource'] = 'ops_override';
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
          before: {
            riskTier: emp['riskTier'],
            maxActiveSlots: emp['maxActiveSlots'],
            maxActiveSlotsSource: emp['maxActiveSlotsSource'] ?? null,
          },
          after: update,
        });

        return { success: true };
      })
  )
);

// ── onEmployerDocCreated — set employer_admin custom claim on employer create ─

// Creating an employer document must NOT by itself confer employer_admin.
// Self-signup writes employers/{ownUid}; granting the claim on creation meant
// any authenticated user could mint themselves cross-employee reads, Storage
// payroll access and processPayroll. The claim is granted only when the
// employer is already in an approved state at creation time -- which only an
// admin-created document can be, since firestore.rules pins self-created
// employers to 'pending_verification'. The normal path for a self-signup
// employer is approveEmployer, which grants the claim on approval.
const CLAIM_ELIGIBLE_EMPLOYER_STATUSES = ['approved', 'active'];

export const onEmployerDocCreated = onDocumentCreated('employers/{uid}', async (event) => {
  const uid = event.params['uid'];
  const status = event.data?.data()?.['status'] as string | undefined;

  if (!status || !CLAIM_ELIGIBLE_EMPLOYER_STATUSES.includes(status)) {
    logger.info('Withholding employer_admin claim pending approval', {
      uid,
      status: status ?? null,
      service: 'functions',
    });
    return null;
  }

  // This trigger mints employer_admin and previously left no trace at all — the
  // grant was invisible to ops even after audit_log became readable. Log first so
  // a failed audit write aborts (and retries) the grant instead of hiding it.
  await auditLog(db, {
    action: 'employer.claimGrantedOnCreate',
    actorUid: 'system',
    actorRole: 'system',
    targetId: uid,
    after: { role: 'employer_admin' },
    meta: { trigger: 'onEmployerDocCreated', status },
  });

  await admin.auth().setCustomUserClaims(uid, { role: 'employer_admin' });
  logger.info('Set employer_admin claim', { uid, status, service: 'functions' });
  return null;
});

// ── setEmployerClaims — retroactively set employer_admin claims ──────────────

export const setEmployerClaims = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<{ uid: string }, { success: boolean; uid: string }>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'setEmployerClaims', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation — claims assignment). Fail
        // closed: this grants employer_admin, a privilege escalation — an
        // outage must not lift the only brake on it.
        await enforceRateLimit(`rl:setEmployerClaims:${auth.uid}`, 20, 60, {
          onUnavailable: 'closed',
          context: 'setEmployerClaims',
        });

        const { uid } = data;
        if (!uid) throw new HttpsError('invalid-argument', 'uid is required');

        const empDoc = await db.collection('employers').doc(uid).get();
        if (!empDoc.exists) throw new HttpsError('not-found', 'Employer not found');

        // Privilege escalation: log first, mint the claim second, and let an audit
        // failure propagate. An employer_admin claim granted with no record of who
        // granted it is exactly the hole this path used to have.
        await auditLog(db, {
          action: 'employer.setCustomClaims',
          actorUid: auth.uid,
          actorRole: auth.role,
          actorEmail: auth.email ?? null,
          targetId: uid,
          after: { role: 'employer_admin' },
        });

        await admin.auth().setCustomUserClaims(uid, { role: 'employer_admin' });

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
        // Rate limit: 20/min/uid (mutation). Fail closed: this can flip an
        // employer's CURP gate to mode: 'open', widening who can request a
        // loan under that employer — an outage must not lift the only
        // brake on it.
        await enforceRateLimit(`rl:updateEmployerCurpConfig:${auth.uid}`, 20, 60, {
          onUnavailable: 'closed',
          context: 'updateEmployerCurpConfig',
        });

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

// ── submitEmployerDocs — employer KYC document URLs (E6a) ─────────────────────
// firestore.rules' employer-update whitelist never included docRFC/docId/
// docAddress, so DocUploadBanner's client write (EmployerDashboard.tsx) was
// denied and swallowed by an empty catch — verification could never complete.
// The files are already uploaded to Storage under the caller's own uid
// (storage.rules enforces that); this callable just records the resulting
// download URLs against the caller's own employer document.

interface SubmitEmployerDocsData {
  docRFC: string;
  docId: string;
  docAddress: string;
}

function isOwnDocUrl(uid: string, url: unknown): url is string {
  return typeof url === 'string' && url.length > 0 && url.length <= 2000
    && url.includes(`employer_docs%2F${uid}%2F`);
}

export const submitEmployerDocs = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<SubmitEmployerDocsData, { success: boolean }>(
    ['employer_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'submitEmployerDocs', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation — KYC document URLs feeding
        // employer approval). Fail closed: a mutation, not a read.
        await enforceRateLimit(`rl:submitEmployerDocs:${auth.uid}`, 20, 60, {
          onUnavailable: 'closed',
          context: 'submitEmployerDocs',
        });

        const uid = auth.uid;
        const { docRFC, docId, docAddress } = data;
        for (const [field, url] of Object.entries({ docRFC, docId, docAddress })) {
          if (!isOwnDocUrl(uid, url)) {
            throw new HttpsError('invalid-argument', `${field} must be a Storage URL for this employer's own upload path`);
          }
        }

        const empDoc = await db.collection('employers').doc(uid).get();
        if (!empDoc.exists) throw new HttpsError('not-found', 'Employer not found');

        await db.collection('employers').doc(uid).update({
          docRFC,
          docId,
          docAddress,
          docsSubmittedAt: FieldValue.serverTimestamp(),
        });

        try {
          await auditLog(db, {
            action: 'employer.submitDocs',
            actorUid: uid,
            actorRole: auth.role,
            targetId: uid,
          });
        } catch (_) { /* non-critical */ }

        return { success: true };
      })
  )
);

// ── submitPayrollDeductionSetup — Part B CURP sample (E6b) ────────────────────
// Same denial shape as E6a: sampleCurps/partBStatus are not on the employer-
// update whitelist, so PayrollDeductionCard's write (EmployerDashboard.tsx)
// was denied and ops never received the CURP sample needed to wire up the
// employer's payroll deduction feed.

interface SubmitPayrollDeductionSetupData {
  curps: string[];
}

const PARTB_CURP_REGEX = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z\d]\d$/;

export const submitPayrollDeductionSetup = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<SubmitPayrollDeductionSetupData, { success: boolean }>(
    ['employer_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'submitPayrollDeductionSetup', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation — sets up the payroll deduction
        // path that later collects on disbursed loans). Fail closed.
        await enforceRateLimit(`rl:submitPayrollDeductionSetup:${auth.uid}`, 20, 60, {
          onUnavailable: 'closed',
          context: 'submitPayrollDeductionSetup',
        });

        const curps = Array.isArray(data.curps) ? data.curps.map((c) => String(c).toUpperCase()) : [];
        if (curps.length !== 3 || curps.some((c) => !PARTB_CURP_REGEX.test(c))) {
          throw new HttpsError('invalid-argument', 'Exactly 3 valid CURPs are required');
        }
        if (new Set(curps).size !== curps.length) {
          throw new HttpsError('invalid-argument', 'CURPs must be unique');
        }

        const uid = auth.uid;
        const empDoc = await db.collection('employers').doc(uid).get();
        if (!empDoc.exists) throw new HttpsError('not-found', 'Employer not found');

        await db.collection('employers').doc(uid).update({
          sampleCurps: curps,
          partBStatus: 'pending',
        });

        try {
          await auditLog(db, {
            action: 'employer.submitPayrollDeductionSetup',
            actorUid: uid,
            actorRole: auth.role,
            targetId: uid,
          });
        } catch (_) { /* non-critical */ }

        return { success: true };
      })
  )
);

// ── ensureEmployerCode — server-minted, collision-safe join code (E6c) ────────
// EmployeeRoster.tsx's backfill (`setDoc(empRef, { employerCode }, { merge:
// true })`) hit the same update whitelist denial, and was otherwise unguarded
// (no try/catch around it) — an employer whose doc lacked employerCode could
// never obtain one. Minted here with a uniqueness reservation doc so two
// employers can never receive the same code (the client generator this
// replaces had no collision check at all — see audit finding E17).

const EMPLOYER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMPLOYER_CODE_LENGTH = 6;
const EMPLOYER_CODE_MAX_ATTEMPTS = 10;

function generateEmployerCodeCandidate(): string {
  let code = '';
  for (let i = 0; i < EMPLOYER_CODE_LENGTH; i++) {
    code += EMPLOYER_CODE_ALPHABET.charAt(Math.floor(Math.random() * EMPLOYER_CODE_ALPHABET.length));
  }
  return code;
}

export const ensureEmployerCode = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<unknown, { employerCode: string }>(
    ['employer_admin'],
    async (_data, auth) =>
      withErrorHandling({ functionName: 'ensureEmployerCode', uid: auth.uid }, async () => {
        // Rate limit: 10/min/uid (mints/reserves a join code). Fail closed:
        // this is the only brake on the code-minting loop below racing
        // itself into enumerating the employerCodes space.
        await enforceRateLimit(`rl:ensureEmployerCode:${auth.uid}`, 10, 60, {
          onUnavailable: 'closed',
          context: 'ensureEmployerCode',
        });

        const uid = auth.uid;
        const empRef = db.collection('employers').doc(uid);
        const empSnap = await empRef.get();
        if (!empSnap.exists) throw new HttpsError('not-found', 'Employer not found');

        const existing = empSnap.data()?.['employerCode'];
        if (typeof existing === 'string' && existing.length > 0) {
          return { employerCode: existing };
        }

        for (let attempt = 0; attempt < EMPLOYER_CODE_MAX_ATTEMPTS; attempt++) {
          const candidate = generateEmployerCodeCandidate();
          const reservationRef = db.collection('employerCodes').doc(candidate);
          const claimed = await db.runTransaction(async (tx) => {
            const reservationSnap = await tx.get(reservationRef);
            if (reservationSnap.exists) return false;
            tx.create(reservationRef, { employerId: uid, createdAt: FieldValue.serverTimestamp() });
            tx.update(empRef, { employerCode: candidate });
            return true;
          });
          if (claimed) {
            try {
              await auditLog(db, {
                action: 'employer.codeMinted',
                actorUid: uid,
                actorRole: auth.role,
                targetId: uid,
                after: { employerCode: candidate },
              });
            } catch (_) { /* non-critical */ }
            return { employerCode: candidate };
          }
        }

        throw new HttpsError('resource-exhausted', 'Could not mint a unique employer code, please retry');
      })
  )
);

// ── Firestore document triggers ──────────────────────────────────────────────

export const onLoanStatusChange = onDocumentUpdated('loans/{loanId}', async (event) => {
  const beforeData = event.data!.before.data();
  const afterData = event.data!.after.data();
  const loanId = event.params['loanId'];

  if (isLoanApprovalTransition(beforeData['status'], afterData['status'])) {
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
    try {
      await getQueue('vida-notifications').add('loan_approved', {
        type: 'loan_approved',
        loanId,
        employeeId: afterData['employeeId'],
        phone: afterData['employeePhone'],
        amount: afterData['amount'],
      });
    } catch (e: unknown) {
      logger.warn('Notification queue unavailable', { error: (e as Error).message, service: 'functions' });
      await recordNotificationEnqueueFailure('loan_approved', loanId, e);
    }
  }

  // Gated on the shared predicate, NOT on a hardcoded `pending`. #488 widened
  // the approval branch above to accept `under_review` because that is the only
  // approval production produces; this branch kept `pending` and so released
  // credit on a transition that no longer happens. See
  // isCreditReleasingRejection for why the set stops at approval.
  if (isCreditReleasingRejection(beforeData['status'], afterData['status'])) {
    await db.collection('employees').doc(afterData['employeeId'] as string).update({
      availableCredit: FieldValue.increment(afterData['amount'] as number),
    });
    try {
      await auditLog(db, {
        action: 'loan.rejected',
        actorUid: afterData['employerId'] as string,
        actorRole: 'employer',
        targetId: loanId,
        before: { status: beforeData['status'] },
        after: { status: 'rejected' },
      });
    } catch (_) { /* non-critical */ }
    try {
      await getQueue('vida-notifications').add('loan_rejected', {
        type: 'loan_rejected',
        loanId,
        employeeId: afterData['employeeId'],
        phone: afterData['employeePhone'],
        amount: afterData['amount'],
        rejectionReason: afterData['statusNote'],
      });
    } catch (e: unknown) {
      logger.warn('Notification queue unavailable', { error: (e as Error).message, service: 'functions' });
      await recordNotificationEnqueueFailure('loan_rejected', loanId, e);
    }
  }

  // Was gated on `beforeData.status === 'approved' && afterData.status === 'paid'`
  // — a transition no write path has ever produced. The real repayment path
  // (processPayroll.ts) moves a loan straight from 'active'/'disbursed' to
  // 'repaid' once its balance hits zero, so this never fired: the employer's
  // active-loan slot was never released and the employee's available credit
  // was never restored on repayment.
  //
  // Gated on the canonical 'repaid' only, NOT on every repaid spelling:
  // payment-server writes 'paid' and increments availableCredit itself in the
  // same transaction (order.paid, POST /internal/repayment). Firing here on
  // 'paid' as well would restore the credit twice and let the borrower
  // re-borrow against money they never repaid. See isCreditRestoringRepayment.
  if (isCreditRestoringRepayment(beforeData['status'], afterData['status'])) {
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
        before: { status: beforeData['status'] },
        after: { status: afterData['status'] },
      });
    } catch (_) { /* non-critical */ }
  }
});

export const onLoanApproved = onDocumentUpdated('loans/{loanId}', async (event) => {
  const before = event.data!.before.data();
  const after = event.data!.after.data();
  if (!isLoanApprovalTransition(before['status'], after['status'])) return null;

  const loanId = event.params['loanId'];
  const emp = (await db.collection('employees').doc(after['employeeId'] as string).get()).data() ?? {};

  const loanRef = db.collection('loans').doc(loanId);
  const disbursementQueueRef = db.collection('disbursement_queue').doc(loanId);

  // Idempotency guard (P0-B): this trigger fires on every pending/under_review
  // → approved transition, and updateLoanStatus's admin branch used to let ops
  // reproduce that exact diff twice on the same loan (rewind to pending, then
  // re-approve) with no server-side dedup — replaying a real SoftCrédito SPEI
  // transfer. Claim the disbursement_queue doc and the loan's move to
  // disbursement_queued atomically in one transaction: if a queue entry
  // already exists, or the loan already carries a disbursedAt from an earlier
  // fire, this fire is a duplicate and must not reach the adapter call below.
  const claimed = await db.runTransaction(async (tx) => {
    const [loanSnap, queueSnap] = await Promise.all([tx.get(loanRef), tx.get(disbursementQueueRef)]);
    const loanData = loanSnap.data() ?? {};
    if (queueSnap.exists || loanData['disbursedAt']) return false;

    tx.set(disbursementQueueRef, {
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
    tx.update(loanRef, { status: 'disbursement_queued' });
    return true;
  });

  if (!claimed) {
    logger.warn('Disbursement already claimed for loan — skipping duplicate trigger fire', {
      loanId,
      service: 'functions',
    });
    return null;
  }

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

  // Register payroll deduction with SoftCrédito.
  //
  // The amount and date come from buildLoanInstallments() — the same function
  // that produced the schedule quoted in the wizard and printed on the contract
  // (#424). Before, this hand-assembled `{ amount: total, dueDate }` while the
  // wizard advertised two biweekly payments, so what the borrower was promised
  // and what was collected were written in two different places and disagreed.
  try {
    const scUrl = process.env['SOFTCREDITO_ADAPTER_URL'];
    const secret = process.env['INTERNAL_SECRET'] ?? '';
    if (scUrl && secret) {
      const deduction = toPayrollDeduction(
        buildLoanInstallments(
          after['total'] as number,
          (after['dueDate'] as FirebaseFirestore.Timestamp).toDate(),
          (after['term'] as number) ?? DEFAULT_LOAN_TERM_DAYS
        )
      );
      const dedRes = await fetch(scUrl + '/internal/register-deduction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
        body: JSON.stringify({
          loanId,
          employeeId: after['employeeId'],
          employerId: after['employerId'],
          amount: deduction.amount,
          dueDate: deduction.dueDate,
        }),
        signal: AbortSignal.timeout(10000),
      });

      // A non-2xx here used to be swallowed by the caller's `if (r.ok)` doing
      // nothing on the else branch — no throw, so the catch below never ran
      // either. Nothing was logged, no alert fired, and `softcreditoDeductionId`
      // stayed null forever with no other code path ever checking for that.
      // The loan had already been disbursed by this point (or is being
      // retried post-disbursement), so the borrower had real money in hand
      // and no automated repayment channel behind it — invisibly. Throwing
      // routes this into the same escalation the disbursement failure above
      // already gets.
      if (!dedRes.ok) {
        const errBody = await dedRes.text();
        throw new Error(`Adapter returned ${dedRes.status}: ${errBody}`);
      }

      const result = (await dedRes.json()) as Record<string, unknown>;
      await db.collection('loans').doc(loanId).update({
        softcreditoDeductionId: result['deductionId'] ?? null,
      });
      logger.info('Payroll deduction registered', { loanId, service: 'functions' });
    }
  } catch (e: unknown) {
    logger.error('Payroll deduction registration failed — loan has no automated repayment collection', {
      error: (e as Error).message,
      loanId,
      service: 'functions',
    });
    sendSlackAlert(
      'Payroll deduction registration FAILED for loan ' +
        loanId +
        ' — funds were disbursed but repayment collection was not registered; manual follow-up required',
      'critical'
    ).catch(() => {});
    try {
      await db.collection('loans').doc(loanId).update({
        payrollDeductionError: (e as Error).message,
        payrollDeductionErrorAt: FieldValue.serverTimestamp(),
      });
    } catch (markErr: unknown) {
      logger.error('Failed to mark payrollDeductionError', {
        error: (markErr as Error).message,
        loanId,
        service: 'functions',
      });
    }
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

  // Derive the credit line server-side. The client used to compute and write
  // creditLimit/availableCredit into its own document during onboarding, which
  // let anyone pick their own borrowing ceiling; firestore.rules now rejects
  // those fields on create, so they are established here from the declared
  // salary using the server's formula.
  const data = event.data?.data() ?? {};
  const salary = typeof data['monthlySalary'] === 'number' ? (data['monthlySalary'] as number) : 0;
  const creditLimit = Math.max(Math.min(salary * EMPLOYEE_CREDIT_SALARY_RATIO, EMPLOYEE_CREDIT_CEILING), 0);

  try {
    await db.collection('employees').doc(uid).update({
      creditLimit,
      availableCredit: creditLimit,
      // monthlySalary is self-declared at registration and not yet corroborated
      // against employer payroll. Record that so underwriting does not read it
      // as a verified figure.
      salarySource: 'self_declared',
      creditLimitSetAt: FieldValue.serverTimestamp(),
    });
    logger.info('Derived employee credit limit', { uid, creditLimit, service: 'functions' });
  } catch (err) {
    logger.error('Failed to set derived credit limit', {
      uid,
      error: (err as Error).message,
      service: 'functions',
    });
  }

  // totalEmployees is a derived headcount, not a client-writable field (E2):
  // Onboarding.tsx used to increment it directly on the employer doc, which
  // firestore.rules denies (the new employee holds no employer_admin claim
  // and the field is not on the update whitelist), stranding the wizard on a
  // raw permission-denied error. Maintained here instead, the same pattern
  // as `activeLoans` in onLoanStatusChange below.
  const employerId = data['employerId'];
  if (typeof employerId === 'string' && employerId.length > 0) {
    try {
      await db.collection('employers').doc(employerId).update({
        totalEmployees: FieldValue.increment(1),
      });
      logger.info('Incremented employer totalEmployees', { uid, employerId, service: 'functions' });
    } catch (err) {
      logger.error('Failed to increment employer totalEmployees', {
        uid,
        employerId,
        error: (err as Error).message,
        service: 'functions',
      });
    }
  }
  return null;
});

export const autoVerifyOnEmployerCreate = onDocumentCreated('employers/{uid}', async (event) => {
  // Environment gate first: '@vida-test.com' is a suffix the signer-upper
  // chooses, so on production it would let anyone skip email verification and
  // auto-activate their own employer.
  if (!allowTestBypass()) return;
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
  // Environment gate first — see autoVerifyOnEmployerCreate.
  if (!allowTestBypass()) return;
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

// ─── Daily arrears sweep (#541) ─────────────────────────────────────────────
// The fix for D1 (manually-disbursed loans invisible to the sweep) and D2 (a
// failed/unconfigured SoftCrédito repayment sync letting the sweep run on
// stale data and dun borrowers who had already paid) lives in
// functions/src/scheduled/dailyLoanCheck.ts. It was written and tested there
// but never wired in here — this used to be a second, inline definition that
// still had both bugs, so the fix shipped in #541 had zero effect in
// production. See scheduled/__tests__/dailyLoanCheck.test.ts's wiring guard.
export { dailyLoanCheck } from './scheduled/dailyLoanCheck';

export const weeklyPortfolioSnapshot = onSchedule(
  { schedule: '0 8 * * 1', timeZone: 'America/Mexico_City' },
  async () => {
    const snap = await db.collection('loans').get();
    const loans = snap.docs.map((d) => d.data());

    // 'active' AND 'disbursed' are both live "funds sent" spellings (two
    // separate disbursement pipelines), and 'repaid' — not 'paid', which no
    // write path has ever produced — is the only spelling a full repayment
    // is ever written with. Counting 'paid' here always counted zero.
    const cnt = (pred: (s: string) => boolean) => loans.filter((l) => pred(l['status'] as string)).length;
    const sum = (pred: (s: string) => boolean) =>
      loans.filter((l) => pred(l['status'] as string)).reduce((a, l) => a + ((l['amount'] as number) || 0), 0);

    const active = cnt(isDisbursedStatus);
    const overdue = cnt((s) => s === 'overdue');
    const paid = cnt(isRepaidStatus);
    const total = active + overdue + paid;
    const date = new Date().toISOString().split('T')[0];

    await db.collection('portfolio_snapshots').doc(date).set({
      snapshotDate: date,
      totalActive: active,
      totalOverdue: overdue,
      totalPaid: paid,
      totalDisbursedMXN: sum(isDisbursedStatus) + sum((s) => s === 'overdue') + sum(isRepaidStatus),
      totalOutstandingMXN: sum(isDisbursedStatus) + sum((s) => s === 'overdue'),
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
