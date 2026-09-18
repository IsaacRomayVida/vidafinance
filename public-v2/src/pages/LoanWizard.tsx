import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  doc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  onSnapshot,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, db } from '../lib/firebase';
import { friendlyError } from '../lib/errors';
import { MIN_AMOUNT, sliderFillPercent } from '../lib/loanSlider';
import { useAuth } from '../hooks/useAuth';

const LOAN_PURPOSES = [
  'emergency',
  'medical',
  'education',
  'home_repair',
  'transportation',
  'debt_consolidation',
  'other',
] as const;

// Three borrower-facing steps since the term step was dropped (#423): a screen
// offering one option was a full page tap for no decision. The count lives here
// rather than inline so the indicator, the step labels and the branches cannot
// drift apart the way the old "de 4" copy did.
const TOTAL_STEPS = 3;
const MAX_AMOUNT = 5000;
const STEP = 100;
const ACTIVE_STATUSES = ['pending', 'under_review', 'approved', 'disbursed', 'disbursement_queued'];

/** One installment as the server publishes it: when, and what share — no pesos. */
interface RepaymentInstallmentTerms {
  number: number;
  dueInDays: number;
  shareOfTotal: number;
}

/** The repayment terms for one allowed term, published by getLoanConfig. */
interface RepaymentTerms {
  termDays: number;
  installments: RepaymentInstallmentTerms[];
  catPercent: number;
}

interface LoanConfig {
  feeRate: number;
  allowedTermDays: number[];
  defaultTermDays: number;
  repayment: RepaymentTerms[];
  /**
   * The borrower's next payroll date, resolved server-side (#433). ISO string.
   * "Estimated" is literal: disbursement recomputes it against the clock at that
   * moment, and a loan waits for human review in between.
   */
  estimatedDeductionDate: string;
  /**
   * Where the cadence behind that date came from. Only 'default_monthly' is a
   * guess — it means the borrower's cadence could not be read and monthly was
   * assumed (#431), which must not be presented as confidently as a known one.
   */
  payFrequencySource: 'loan_snapshot' | 'employee_record' | 'default_monthly';
}

/**
 * The server's ISO deduction date, or null if it is missing or unparseable.
 *
 * There is deliberately no local fallback. This screen used to compute the date
 * itself as `Date.now() + termDays` (#439) — a calendar offset that had nothing
 * to do with when the borrower is actually paid, and that the system never used
 * for anything: the loan is collected on a payday. A plausible wrong date is
 * worse than a visibly absent one, so an unreadable date renders in the same
 * reserved slot as an unreadable price rather than degrading to something that
 * looks right.
 */
function parseDeductionDate(iso: string | undefined): Date | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The peso split of a published schedule.
 *
 * This screen does NOT decide how many payments there are, when they fall, or
 * what the CAT is — all three come from the server
 * (functions/src/config/loanConfig.ts, REPAYMENT_STRUCTURE). It used to decide
 * all of them: `Math.ceil(termDays / 15)` quoted the borrower two biweekly
 * payments and a locally-derived CAT, while the backend registered a single
 * payroll deduction for the full total on the due date (#424). Shares are the
 * contract; turning them into pesos is presentation, and the last installment
 * absorbs the rounding remainder so the parts always sum to exactly the total
 * the borrower agreed to — the same rule the server applies.
 *
 * There is deliberately no local fallback schedule. A schedule we could not read
 * renders as "no disponible", never as a confident-looking number, for the same
 * reason FEE_RATE was deleted rather than kept as a default.
 */
function allocateInstallments(
  total: number,
  terms: RepaymentTerms | null
): { number: number; amount: number; dueInDays: number }[] | null {
  if (!terms || terms.installments.length === 0) return null;
  let allocated = 0;
  return terms.installments.map((inst, i) => {
    const isLast = i === terms.installments.length - 1;
    const amount = isLast ? total - allocated : Math.round(total * inst.shareOfTotal);
    allocated += amount;
    return { number: inst.number, amount, dueInDays: inst.dueInDays };
  });
}

/** The published terms for one term length, or null if the server sent none. */
function repaymentTermsFor(config: LoanConfig | null, termDays: number | null): RepaymentTerms | null {
  if (termDays === null) return null;
  return (config?.repayment ?? []).find((r) => r.termDays === termDays) ?? null;
}

interface EmployeeData {
  name?: string;
  email?: string;
  employerName?: string;
  employerId?: string;
  bankClabe?: string;
  creditLimit: number;
  availableCredit: number;
  kycStatus?: string;
  employerCode?: string;
  monthlySalary?: number;
}

interface LoanDoc {
  id: string;
  status: string;
  amount?: number;
  createdAt?: { seconds: number };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/** Lifecycle of the server-held pricing config, tracked separately from
 *  eligibility: a rate we failed to READ is a technical fault, not a verdict on
 *  the borrower, and must never render in the eligibility-rejection chrome. */
type ConfigStatus = 'loading' | 'ready' | 'error';

// ── Price slots ───────────────────────────────────────────────────────────────
// Every figure on the quote is priced by the server-held fee rate (getLoanConfig
// → config/loanConfig.ts). When that rate cannot be read, each figure is `null`
// and renders through one of these two slots. A price slot must NEVER fall back
// to 0: a zero comisión quotes a free loan, and a zero CAT is a false statement
// in a disclosure the law requires us to make. Blank is honest; zero is a claim.

/** Placeholder while the rate is in flight — a bar, never a digit or a "$". */
function PriceShimmer({ width = 72 }: { width?: number }) {
  return (
    <span
      aria-busy="true"
      data-testid="price-shimmer"
      className="bo-shimmer"
      style={{ width }}
    />
  );
}

/**
 * One money (or CAT) value on the quote. `value === null` means the rate is
 * unavailable: shimmer while loading, neutral "no disponible" on failure. The
 * failure copy is deliberately NOT a danger colour — the emphasis belongs to
 * the one banner that explains the failure, so a transient pricing outage does
 * not render as a card full of broken fields, or as a rejection.
 */
function PriceValue({
  value,
  status,
  prefix = '$',
  suffix = '',
  shimmerWidth,
  className,
}: {
  value: number | string | null;
  status: ConfigStatus;
  prefix?: string;
  suffix?: string;
  shimmerWidth?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  if (value === null) {
    if (status === 'loading') return <PriceShimmer width={shimmerWidth} />;
    // The reserved state: the one string that stands in for a figure the
    // borrower came here to read. It is ink-soft (#443) — a reserved state
    // nobody can read is indistinguishable from an empty slot, which is the
    // exact failure this component exists to prevent.
    return (
      <span data-testid="price-unavailable" className={`bo-unavail${className ? ` ${className}` : ''}`}>
        {t('wiz_price_unavailable')}
      </span>
    );
  }
  return (
    <span className={className}>
      {prefix}
      {typeof value === 'number' ? fmt(value) : value}
      {suffix}
    </span>
  );
}

/**
 * Cost in plain sight — the disclosure line.
 *
 * Every step of the request shows, directly under the memo, at 13px, without
 * a tap: the total to repay, the per-deduction amount, and the CAT labelled
 * informational, followed by the standardised-measure note and the CONDUSEF
 * reference (LTOSF Art. 8). All three figures are READ from getLoanConfig —
 * `feeRate` prices the total, the published `installments` split it, and
 * `catPercent` is rendered exactly as published. Nothing here derives a rate;
 * a figure that could not be read renders as missing (`CAT — informativo ·
 * pendiente`), never as a number.
 *
 * One component rather than three copies of the same markup: the disclosure
 * had already drifted once (a block on one step, a bare row on the next).
 */
function CatDisclosure({
  total,
  deduction,
  cat,
  status,
}: {
  total: number | null;
  deduction: number | null;
  cat: string | null;
  status: ConfigStatus;
}) {
  const { t } = useTranslation();
  const slot = (value: number | null, render: (v: number) => string, width: number) => {
    if (value === null) {
      if (status === 'loading') return <PriceShimmer width={width} />;
      return (
        <span data-testid="price-unavailable" className="bo-unavail">
          {t('cost_pending')}
        </span>
      );
    }
    return render(value);
  };
  return (
    <div data-testid="cat-disclosure" className="bo-disc">
      <div>
        <b>{t('cost_label')}</b>{' '}
        {slot(total, (v) => t('cost_total', { total: fmt(v) }), 72)}
        {' · '}
        {slot(deduction, (v) => t('cost_per_deduction', { amount: fmt(v) }), 88)}
        {' · '}
        {cat === null && status !== 'loading' ? (
          <span data-testid="price-unavailable" className="bo-unavail">{t('cost_cat_pending')}</span>
        ) : (
          <>
            {t('modal_cat_label')}{' '}
            <PriceValue value={cat} status={status} prefix="" suffix="%" shimmerWidth={56} />
            {' '}
            {t('cost_cat_suffix')}
          </>
        )}
      </div>
      <div>
        {t('modal_cat_note')}{' '}
        <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener noreferrer">
          {t('modal_cat_condusef')}
        </a>
      </div>
    </div>
  );
}

/**
 * The single emphasised element on the screen when pricing cannot be read. It
 * carries the whole explanation so that the value slots can stay neutral, and
 * it says plainly that nothing was charged and nothing about the borrower's
 * application changed — this is our fault, not a decision about them.
 *
 * It deliberately uses NO semantic status pair (#422): `--danger-*` is what a
 * denial renders in and `--warning-*` is what "under review" renders in, both
 * reachable in the same session. Emphasis comes from WEIGHT — a solid ink
 * border on a white surface — never from a verdict's colour.
 */
function PricingErrorBanner({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" data-testid="pricing-error-banner" className="bo-price-err">
      <b>{t('wiz_price_error_title')}</b>
      <p>{t('wiz_price_error_body')}</p>
      <button type="button" onClick={onRetry} className="bo-btn">
        {t('wiz_price_retry')}
      </button>
    </div>
  );
}

export function LoanWizard() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  // Loading & eligibility
  const [loading, setLoading] = useState(true);
  const [eligibilityError, setEligibilityError] = useState('');
  const [employee, setEmployee] = useState<EmployeeData | null>(null);
  const [loanConfig, setLoanConfig] = useState<LoanConfig | null>(null);
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('loading');
  const [configAttempt, setConfigAttempt] = useState(0);

  // Wizard state
  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState(1000);
  // `null` until the server says otherwise. It used to initialise to a literal
  // 30, which was invisible while the term had its own step and a visible list —
  // but now the term sits inside the quote card, and a hardcoded 30 rendered
  // beside prices that honestly read "no disponible" is a client-side fact
  // wearing a server fact's clothes. It is right today only because
  // ALLOWED_LOAN_TERM_DAYS is [30]; the same accident that made the old
  // "Quincenal" cadence encode correctly (#435).
  const [termDays, setTermDays] = useState<number | null>(null);
  const [purpose, setPurpose] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ loanId: string; loanRef: string } | null>(null);

  // Real-time tracking of pending loan after submit
  const [pendingLoan, setPendingLoan] = useState<LoanDoc | null>(null);
  const [statusStale, setStatusStale] = useState(false);

  // Salary-based max amount
  const salaryMax = employee?.monthlySalary
    ? Math.floor((employee.monthlySalary * 0.3) / 100) * 100
    : MAX_AMOUNT;
  const effectiveMax = Math.min(salaryMax, MAX_AMOUNT, employee?.availableCredit ?? MAX_AMOUNT);
  const cappedMax = Math.max(effectiveMax, MIN_AMOUNT);

  // Calculations
  // `null` here means "we could not read the rate", and it propagates all the
  // way to the screen. It must not degrade to 0 anywhere along this chain —
  // see the PriceValue comment above for why zero is the dangerous value.
  const feeRate = loanConfig?.feeRate ?? null;
  const feeRatePct = feeRate === null ? null : Math.round(feeRate * 100);
  const fee = feeRate === null ? null : Math.round(amount * feeRate);
  const total = fee === null ? null : amount + fee;
  // Deduction date and CAT: read, never derived — see parseDeductionDate.
  const deductionDate = parseDeductionDate(loanConfig?.estimatedDeductionDate);
  const deductionDateText =
    deductionDate === null
      ? null
      : t('wiz_deduction_date_value', {
          date: deductionDate.toLocaleDateString(i18n.language, {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }),
        });
  // Only 'default_monthly' is an assumption (#431). The date text itself reads
  // "previsto" in BOTH cases — human review sits between quote and disbursement,
  // so it is a prediction either way. What the assumed case adds is the extra
  // line saying we could not read the cadence.
  const deductionCadenceAssumed = loanConfig?.payFrequencySource === 'default_monthly';
  // Schedule and CAT: read, never derived. `null` propagates exactly like the
  // fee rate does — a schedule we could not read must not render as "$0 × 0".
  const repaymentTerms = repaymentTermsFor(loanConfig, termDays);
  const installments = total === null ? null : allocateInstallments(total, repaymentTerms);
  const installmentCount = installments?.length ?? null;
  const deductionAmount = installments?.[0]?.amount ?? null;
  // Today the server always publishes exactly one installment
  // (REPAYMENT_STRUCTURE), and toPayrollDeduction() refuses to register anything
  // else — so "a single charge" is a guarantee of the system, not a claim by
  // this screen. It is still asked rather than assumed: if the repayment product
  // ever really changes, the per-installment row comes back and the
  // single-charge sentence disappears, instead of becoming a false statement
  // nobody remembered was hardcoded.
  const singleCharge = installmentCount === null || installmentCount === 1;
  const cat = repaymentTerms === null ? null : String(repaymentTerms.catPercent);
  const pricingReady = configStatus === 'ready' && feeRate !== null && repaymentTerms !== null;
  const sliderPct = sliderFillPercent(amount, cappedMax);

  // ── Fetch pricing config ──────────────────────────────────────────────────
  // Deliberately SEPARATE from the eligibility fetch below. Bundling the two (as
  // this did until now) meant a transient failure to read the fee rate was
  // reported to the borrower in the eligibility-rejection card — the same chrome
  // as "you are not verified" and "you already have an active loan". A pricing
  // outage is our fault and is retryable; a rejection is neither. They cannot
  // share a failure path.
  //
  // Failing to read the rate still blocks submission (see `pricingReady`): the
  // rule that a borrower must never see a rate nobody approved is unchanged.
  // What changes is that they now see *no* rate and a retry, instead of a
  // dead end that reads like a denial.
  const uid = user?.uid;
  useEffect(() => {
    // Keyed on the uid, not the user object: a re-render that hands back an
    // equal-but-new user must not re-fetch pricing.
    if (!uid) return;
    let cancelled = false;

    setConfigStatus('loading');
    (async () => {
      try {
        const functions = getFunctions();
        const getLoanConfig = httpsCallable<Record<string, never>, LoanConfig>(
          functions,
          'getLoanConfig'
        );
        const configResult = await getLoanConfig();
        if (cancelled) return;
        const config = configResult.data;
        // A response that arrives without a usable rate — or without the
        // repayment schedule and CAT that go with it (#424) — is a failure, not
        // a quote. Treating it as success is how a null reaches the price slots
        // with `status === 'ready'` and renders as a blank nobody can retry.
        if (
          !config ||
          typeof config.feeRate !== 'number' ||
          !Array.isArray(config.repayment) ||
          config.repayment.length === 0
        ) {
          setLoanConfig(null);
          setConfigStatus('error');
          return;
        }
        setLoanConfig(config);
        if (typeof config.defaultTermDays === 'number') setTermDays(config.defaultTermDays);
        setConfigStatus('ready');
      } catch {
        if (cancelled) return;
        setLoanConfig(null);
        setConfigStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uid, configAttempt]);

  // ── Fetch employee data & check eligibility ──
  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        const empDoc = await getDoc(doc(db, 'employees', user.uid));

        if (!empDoc.exists()) {
          navigate('/employee', { replace: true });
          return;
        }
        const data = empDoc.data() as EmployeeData;
        setEmployee(data);

        // Check KYC
        if (data.kycStatus && data.kycStatus !== 'approved' && data.kycStatus !== 'verified') {
          setEligibilityError(t('wiz_error_unverified'));
          setLoading(false);
          return;
        }

        // Check available credit
        if (data.availableCredit < MIN_AMOUNT) {
          setEligibilityError(t('wiz_error_no_credit'));
          setLoading(false);
          return;
        }

        // Fetch employer code if not on employee doc
        if (!data.employerCode && data.employerId) {
          try {
            const emplerDoc = await getDoc(doc(db, 'employers', data.employerId));
            if (emplerDoc.exists()) {
              const emplerData = emplerDoc.data();
              // Check employer is active
              if (emplerData.status !== 'approved') {
                setEligibilityError(t('wiz_error_employer_inactive'));
                setLoading(false);
                return;
              }
              setEmployee((prev) =>
                prev ? { ...prev, employerCode: emplerData.employerCode || '' } : prev
              );
            }
          } catch {
            // proceed without — submit will fail with server-side validation
          }
        }

        // Check for existing active/pending loans
        const existingLoans = await getDocs(
          query(collection(db, 'loans'), where('employeeId', '==', user.uid))
        );
        const hasActive = existingLoans.docs.some((d) =>
          ACTIVE_STATUSES.includes(d.data().status)
        );
        if (hasActive) {
          setEligibilityError(t('wiz_error_active_loan'));
          setLoading(false);
          return;
        }
      } catch {
        setEligibilityError(t('wiz_error_generic'));
      } finally {
        setLoading(false);
      }
    })();
  }, [user, navigate, t]);

  // ── Real-time loan listener after successful submit ──
  // Without an error callback the listener could die silently and leave the
  // badge frozen on its initial 'pending' — actively telling the borrower
  // their application is still under review when the client had simply
  // stopped listening. A dead listener must read as "we lost the live
  // connection", never as a status (F7).
  useEffect(() => {
    if (!success || !user) return;
    setStatusStale(false);

    const unsub = onSnapshot(
      doc(db, 'loans', success.loanId),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          setPendingLoan({
            id: snap.id,
            status: data.status,
            amount: data.principalAmount || data.amount,
            createdAt: data.requestedAt || data.createdAt,
          });
        }
      },
      () => setStatusStale(true),
    );

    return unsub;
  }, [success, user]);

  // Clamp amount when effectiveMax changes
  useEffect(() => {
    if (amount > cappedMax) setAmount(Math.floor(cappedMax / STEP) * STEP || MIN_AMOUNT);
  }, [cappedMax, amount]);

  const retryLoanConfig = () => setConfigAttempt((n) => n + 1);

  // "Comisión (30%)" carries the rate inside the label, so without a rate the
  // label has to change too — interpolating an empty string would ship
  // "Comisión (%)", which reads as a formatting bug rather than a missing value.
  const feeLabel =
    feeRatePct === null ? t('wiz_flat_fee_unknown') : t('wiz_flat_fee', { rate: feeRatePct });

  const handleConfirm = async () => {
    // A submission with no server-published term is not a degraded quote, it is
    // a request the server cannot price. The confirm button is already disabled
    // on !pricingReady, which cannot be true with a null term — this is the
    // belt to that suspenders, so the type stays honest instead of being
    // asserted away.
    if (termDays === null) return;
    setError('');
    setSubmitting(true);
    try {
      // Force token refresh for fresh claims
      if (auth.currentUser) await auth.currentUser.getIdToken(true);

      const functions = getFunctions();
      const requestLoan = httpsCallable<
        {
          amount: number;
          employerCode: string;
          bankAccountClabe: string;
          termsAccepted: true;
          termDays: number;
          loanPurpose?: string;
        },
        { loanId: string; loanRef?: string; status: string; message: string }
      >(functions, 'requestLoan');

      const result = await requestLoan({
        amount,
        employerCode: employee?.employerCode || '',
        bankAccountClabe: employee?.bankClabe || '',
        termsAccepted: true,
        termDays,
        ...(purpose ? { loanPurpose: purpose } : {}),
      });

      setSuccess({
        loanId: result.data.loanId,
        loanRef: result.data.loanRef || result.data.loanId,
      });
    } catch (err) {
      setError(friendlyError(err));
      setSubmitting(false);
    }
  };

  // ── Presentation ──────────────────────────────────────────────────────────
  // Everything below is markup. The wizard is the Request board from the
  // design reference: "Se descuenta de tu nómina", the term as `1 descuento ·
  // 1,300 cada uno` with the count in the avatar circle, the amount at 64px
  // with a blinking caret, the memo as a highlighted <mark>, the disclosure
  // line directly under it, and ONE green pill per step.

  const stepIndicator = (
    <>
      <div className="bo-head">
        <span className="dot">{t('wiz_title')}</span>
        <span className="dot">{t('wiz_step_indicator', { current: step, total: TOTAL_STEPS })}</span>
      </div>
      <div className="bo-steps" aria-hidden="true">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((s) => (
          <i key={s} data-testid="step-segment" className={s <= step ? 'on' : ''} />
        ))}
      </div>
    </>
  );

  /** `1 descuento · 1,300 cada uno`, the count in the avatar circle. */
  const termLine = (
    <div className="bo-who">
      <span className="bo-av" aria-hidden="true">{installmentCount ?? '·'}</span>
      {installmentCount === null ? (
        <span>{configStatus === 'loading' ? <PriceShimmer width={120} /> : t('wiz_term_pending')}</span>
      ) : (
        <span>
          {installmentCount === 1 ? t('wiz_term_one') : t('wiz_term_many', { count: installmentCount })}
          {' · '}
          <PriceValue value={deductionAmount} status={configStatus} prefix="" shimmerWidth={56} />
          {' '}
          {t('wiz_term_each')}
        </span>
      )}
    </div>
  );

  const disclosure = (
    <CatDisclosure total={total} deduction={deductionAmount} cat={cat} status={configStatus} />
  );

  const deductionDateRow = (
    <>
      <div className="r">
        <span>{t('wiz_deduction_date_label')}</span>
        <b>
          <PriceValue value={deductionDateText} status={configStatus} prefix="" shimmerWidth={140} />
        </b>
      </div>
      {deductionDateText !== null && deductionCadenceAssumed && (
        <p data-testid="deduction-cadence-assumed" className="fine">
          {t('wiz_deduction_date_note')}
        </p>
      )}
    </>
  );

  // ── Loading state ──
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
        <span
          className="spinner"
          style={{ borderColor: 'rgba(30,32,29,0.1)', borderTopColor: 'var(--ink)' }}
        />
      </div>
    );
  }

  // ── Eligibility error ──
  if (eligibilityError) {
    return (
      <div className="bo-screen paper">
        <div className="bo-head">
          <span className="dot">{t('wiz_title')}</span>
        </div>
        <div className="bo-center">
          <h2>{t('wiz_title')}</h2>
          <p>{eligibilityError}</p>
        </div>
        <div className="bo-actions">
          <button type="button" onClick={() => navigate('/employee', { replace: true })} className="bo-cta">
            {t('wiz_success_back')}
          </button>
        </div>
      </div>
    );
  }

  // ── Success / Pending tracking screen ──
  if (success) {
    const statusLabel = pendingLoan?.status
      ? t(`status_${pendingLoan.status}`, pendingLoan.status)
      : t('status_pending');

    return (
      <div className="bo-screen paper">
        <div className="bo-head">
          <span className="dot">{t('wiz_title')}</span>
          <span className={`bo-badge ${pendingLoan?.status || 'pending'}`}>{statusLabel}</span>
        </div>
        <div className="bo-center">
          <h2>{t('wiz_success_title')}</h2>
          <p>{t('wiz_success_desc')}</p>
        </div>
        {statusStale && (
          <p role="status" className="bo-note">
            {t(
              'wizard_status_stale',
              'Perdimos la conexión en vivo; este estado podría no estar actualizado. Consulta Mis Créditos.',
            )}
          </p>
        )}
        <div className="bo-ref">
          <span className="dot">{t('wiz_success_ref')}</span>
          <b>{success.loanRef}</b>
        </div>
        <div className="bo-quote">
          <div className="r">
            <span>{t('modal_loan_amount')}</span>
            <b className="money">${fmt(amount)}</b>
          </div>
          <div className="r total">
            <span>{t('modal_total')}</span>
            <b className="money"><PriceValue value={total} status={configStatus} /></b>
          </div>
        </div>
        {disclosure}
        <div className="bo-actions">
          <button type="button" onClick={() => navigate('/employee', { replace: true })} className="bo-cta">
            {t('wiz_success_back')}
          </button>
        </div>
      </div>
    );
  }

  // ── Wizard steps ──
  return (
    <div className="bo-screen paper">
      {stepIndicator}

      {/* ─── Step 1: Amount ─── */}
      {step === 1 && (
        <>
          <p className="bo-payto">
            <span className="sr-only">{t('wiz_step_1_label')} · </span>
            {t('wiz_pay_to')}
          </p>
          {termLine}

          <div className="bo-amount money" aria-live="polite">
            {fmt(amount)}<small>MXN</small><i aria-hidden="true" />
          </div>

          {/* Slider */}
          <div className="bo-range">
            <div className="track">
              <div className="fill" style={{ width: `${Math.min(100, Math.max(0, sliderPct))}%` }} />
            </div>
            <input
              id="lw-amount-range"
              type="range"
              aria-label={t('a11y_loan_amount_slider')}
              min={MIN_AMOUNT}
              max={cappedMax}
              step={STEP}
              value={amount}
              onChange={(e) => setAmount(parseInt(e.target.value))}
            />
          </div>
          <div className="bo-range-l money">
            <span>{fmt(MIN_AMOUNT)}</span>
            <span>{fmt(cappedMax)}</span>
          </div>

          {/* Salary cap note */}
          {employee?.monthlySalary && cappedMax < MAX_AMOUNT && (
            <p className="bo-note">{t('wiz_step_1_max_note', { max: fmt(cappedMax) })}</p>
          )}

          {disclosure}

          {/* Quick amounts as a pill pad, ending in the one green control */}
          <div className="bo-pad">
            {[500, 1000, 2000, 3000, 5000]
              .filter((v) => v <= cappedMax)
              .map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setAmount(v)}
                  className={`money${amount === v ? ' on' : ''}`}
                  aria-pressed={amount === v}
                >
                  {fmt(v)}
                </button>
              ))}
            <button type="button" onClick={() => setStep(2)} className="bo-cta">
              {t('wiz_next')}
            </button>
          </div>
        </>
      )}

      {/* ─── Step 2: Repayment Preview ─── */}
      {step === 2 && (
        <>
          <p className="bo-payto">
            <span className="sr-only">{t('wiz_step_2_label')} · </span>
            {t('wiz_pay_to')}
          </p>
          {termLine}
          <div className="bo-amount title money">
            {fmt(amount)}<small>MXN</small>
          </div>

          {/* Breakdown */}
          <div className="bo-quote">
            <div className="r">
              <span>{t('modal_loan_amount')}</span>
              <b className="money">${fmt(amount)}</b>
            </div>
            <div className="r">
              <span>{feeLabel}</span>
              <b className="money"><PriceValue value={fee} status={configStatus} /></b>
            </div>
            <div className="r total">
              <span>{t('modal_total')}</span>
              <b className="money"><PriceValue value={total} status={configStatus} /></b>
            </div>
            <div className="r">
              <span>{t('modal_term')}</span>
              <b>
                <PriceValue
                  value={termDays}
                  status={configStatus}
                  prefix=""
                  suffix={` ${t('calc_days')}`}
                  shimmerWidth={64}
                />
              </b>
            </div>
            {!singleCharge && (
              <div className="r">
                <span>{t('wiz_payroll_deduction')}</span>
                <b className="money">
                  <PriceValue
                    value={deductionAmount}
                    status={configStatus}
                    suffix={` × ${installmentCount}`}
                  />
                </b>
              </div>
            )}
            {deductionDateRow}
            {/* One charge, not a payment plan — stated only while the published
                schedule actually is one installment. */}
            {singleCharge && <p className="fine">{t('wiz_single_charge_notice')}</p>}
          </div>

          {disclosure}

          {configStatus === 'error' && <PricingErrorBanner onRetry={retryLoanConfig} />}
          <div className="bo-actions">
            <button onClick={() => setStep(1)} type="button" className="bo-ghost">
              {t('wiz_back')}
            </button>
            <button onClick={() => setStep(3)} type="button" className="bo-cta" disabled={!pricingReady}>
              {t('wiz_next')}
            </button>
          </div>
        </>
      )}

      {/* ─── Step 3: Review & Confirm ─── */}
      {step === 3 && (
        <>
          <p className="bo-payto">
            <span className="sr-only">{t('wiz_step_3_label')} · </span>
            {t('wiz_pay_to')}
          </p>
          {termLine}
          <div className="bo-amount title money">
            {fmt(amount)}<small>MXN</small>
          </div>

          {/* Review summary */}
          <div className="bo-quote">
            <div className="r">
              <span>{t('modal_loan_amount')}</span>
              <b className="money">${fmt(amount)} MXN</b>
            </div>
            <div className="r">
              <span>{feeLabel}</span>
              <b className="money"><PriceValue value={fee} status={configStatus} suffix=" MXN" /></b>
            </div>
            <div className="r total">
              <span>{t('modal_total')}</span>
              <b className="money"><PriceValue value={total} status={configStatus} suffix=" MXN" /></b>
            </div>
            <div className="r">
              <span>{t('modal_term')}</span>
              <b>
                <PriceValue
                  value={termDays}
                  status={configStatus}
                  prefix=""
                  suffix={` ${t('calc_days')}`}
                  shimmerWidth={64}
                />
              </b>
            </div>
            {!singleCharge && (
              <div className="r">
                <span>{t('wiz_payroll_deduction')}</span>
                <b className="money">
                  <PriceValue
                    value={deductionAmount}
                    status={configStatus}
                    suffix={` × ${installmentCount}`}
                  />
                </b>
              </div>
            )}
            {deductionDateRow}
            {singleCharge && <p className="fine">{t('wiz_single_charge_notice')}</p>}
          </div>

          {/* The memo: the purpose, highlighted the way the companion tags it */}
          <label htmlFor="lw-purpose" className="bo-payto" style={{ marginTop: 18, fontSize: 13 }}>
            {t('modal_purpose_label')}
          </label>
          <p className="bo-memo">
            <mark>
              <select id="lw-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                <option value="">{t('modal_purpose_none')}</option>
                {LOAN_PURPOSES.map((p) => (
                  <option key={p} value={p}>
                    {t(`modal_purpose_${p}`)}
                  </option>
                ))}
              </select>
            </mark>
          </p>

          {disclosure}

          {/* Terms checkbox */}
          <label className="bo-check">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
            />
            <span>{t('modal_accept_terms')}</span>
          </label>

          {/* Error */}
          {error && (
            <div className="bo-err" role="alert">
              {error}
            </div>
          )}

          {configStatus === 'error' && <PricingErrorBanner onRetry={retryLoanConfig} />}
          <div className="bo-actions">
            <button onClick={() => setStep(2)} type="button" className="bo-ghost">
              {t('wiz_back')}
            </button>
            <button
              onClick={handleConfirm}
              type="button"
              disabled={!termsAccepted || submitting || !pricingReady}
              className="bo-cta money"
            >
              {submitting ? (
                <>
                  <span className="spinner" aria-hidden="true" /> {t('modal_submitting')}
                </>
              ) : (
                t('wiz_confirm_amount', { amount: fmt(amount) })
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
