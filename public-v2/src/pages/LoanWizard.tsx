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
const MIN_AMOUNT = 500;
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
      style={{
        display: 'inline-block',
        width,
        height: '1em',
        verticalAlign: 'middle',
        borderRadius: 4,
        background: 'rgba(25,68,69,0.08)',
      }}
    />
  );
}

/**
 * One money (or CAT) value on the quote. `value === null` means the rate is
 * unavailable: shimmer while loading, neutral "no disponible" on failure. The
 * failure copy is deliberately NOT --danger — the red belongs to the one banner
 * that explains the failure, so a transient pricing outage does not render as a
 * card full of broken fields, or as a rejection.
 */
function PriceValue({
  value,
  status,
  prefix = '$',
  suffix = '',
  shimmerWidth,
  style,
}: {
  value: number | string | null;
  status: ConfigStatus;
  prefix?: string;
  suffix?: string;
  shimmerWidth?: number;
  style?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  if (value === null) {
    if (status === 'loading') return <PriceShimmer width={shimmerWidth} />;
    // --t2, not --t3 (#443). This is the reserved state: the one string that
    // stands in for a figure the borrower came here to read. --t3 (#93aaa9) is
    // 2.45:1 on --bg and 2.29:1 on --bg2 — under AA's 4.5:1 for body text and
    // under even the 3:1 floor that applies to non-text UI. A reserved state
    // nobody can read is indistinguishable from an empty slot, which is the
    // exact failure this component exists to prevent.
    return (
      <span data-testid="price-unavailable" style={{ color: 'var(--t2)', ...style }}>
        {t('wiz_price_unavailable')}
      </span>
    );
  }
  return (
    <span style={style}>
      {prefix}
      {typeof value === 'number' ? fmt(value) : value}
      {suffix}
    </span>
  );
}

/**
 * The single emphasised element on the screen when pricing cannot be read. It
 * carries the whole explanation so that the value slots can stay neutral, and
 * it says plainly that nothing was charged and nothing about the borrower's
 * application changed — this is our fault, not a decision about them.
 *
 * It deliberately uses NO semantic status pair (#422). `--danger-bg`/
 * `--danger-text` is what LoanStatusCard renders `denied` in, and
 * `--warning-bg`/`--warning-text` is what it renders `pending_review` and
 * `escalated` in — both borrower-facing, both reachable in the same session as
 * this wizard. A banner whose entire purpose is to stop our outage from reading
 * as a verdict cannot be painted in a verdict's colours: the red pair reads as
 * "I was rejected", and the amber pair reads as "my application is under
 * review", which is worse here because it is plausible at this exact moment.
 *
 * So the emphasis comes from WEIGHT — a solid border and more air on a neutral
 * surface — with `--warning` used only as a border accent. It is not used for
 * text: #b08420 on white is 3.4:1, which clears the 3:1 bar for a non-text UI
 * boundary but fails AA for body copy. Text stays on --t1/--t2.
 */
/**
 * The CAT disclosure.
 *
 * Deliberately NOT a row in the quote breakdown. The CAT is a regulated
 * disclosure (LTOSF Art. 8), not a line item of the quote: it is the one figure
 * a borrower can carry to another lender and compare, it is the only non-peso
 * value in a column of pesos, and at this product's rate it is four digits, so
 * inline it stops reading as a line item and becomes the first thing the eye
 * lands on.
 *
 * It is a component rather than two copies of the same markup because it had
 * already drifted: the step-3 card rendered it as this block while the step-4
 * summary rendered it as an inline row, so the same disclosure had two
 * treatments in one flow. One definition means the next change reaches both.
 *
 * Its text is --t2, never --t3 (#443). The rule Design and I settled on is
 * categorical rather than positional: --t3 may not carry a regulated
 * disclosure, a reserved state or a confidence qualifier, on any page, in any
 * file. It stays what it is good for — decorative chrome. Scoping the rule by
 * file would not have survived the next screen someone builds; scoping it by
 * what the text IS does.
 */
function CatDisclosure({ cat, status }: { cat: string | null; status: ConfigStatus }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="cat-disclosure"
      style={{
        background: 'var(--bg2)',
        borderRadius: 12,
        padding: '14px 16px',
        border: '1px solid rgba(25,68,69,0.04)',
        marginBottom: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 13, color: 'var(--t2)' }}>{t('modal_cat_label')}</span>
        <span className="cat-highlight">
          <PriceValue
            value={cat}
            status={status}
            prefix=""
            suffix={t('modal_cat_annual')}
            shimmerWidth={56}
          />
        </span>
      </div>
      <p style={{ fontSize: 11, color: 'var(--t2)', margin: 0, lineHeight: 1.5 }}>
        {t('modal_cat_note')}{' '}
        <a
          href="https://www.condusef.gob.mx"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--brand)' }}
        >
          {t('modal_cat_condusef')}
        </a>
      </p>
    </div>
  );
}

function PricingErrorBanner({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      data-testid="pricing-error-banner"
      style={{
        background: 'var(--bg)',
        border: '1.5px solid var(--warning)',
        borderRadius: 12,
        padding: '18px 20px',
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 700,
          color: 'var(--t1)',
          marginBottom: 6,
        }}
      >
        {t('wiz_price_error_title')}
      </div>
      <p
        style={{
          fontSize: 12.5,
          color: 'var(--t2)',
          margin: '0 0 14px',
          lineHeight: 1.5,
        }}
      >
        {t('wiz_price_error_body')}
      </p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          padding: '8px 16px',
          borderRadius: 10,
          border: '1.5px solid var(--warning)',
          background: 'transparent',
          color: 'var(--t1)',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'var(--db)',
          cursor: 'pointer',
        }}
      >
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
  const sliderPct = ((amount - MIN_AMOUNT) / (cappedMax - MIN_AMOUNT)) * 100;

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
  useEffect(() => {
    if (!success || !user) return;

    const unsub = onSnapshot(doc(db, 'loans', success.loanId), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setPendingLoan({
          id: snap.id,
          status: data.status,
          amount: data.principalAmount || data.amount,
          createdAt: data.requestedAt || data.createdAt,
        });
      }
    });

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

  // ── Loading state ──
  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '80px 0',
        }}
      >
        <span
          className="spinner"
          style={{
            borderColor: 'rgba(25,68,69,0.1)',
            borderTopColor: 'var(--brand)',
          }}
        />
      </div>
    );
  }

  // ── Eligibility error ──
  if (eligibilityError) {
    return (
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '48px 20px' }}>
        <div
          style={{
            background: '#fff',
            borderRadius: 20,
            padding: '48px 32px',
            boxShadow: '0 2px 8px rgba(25,68,69,0.02)',
            border: '1px solid rgba(25,68,69,0.04)',
            textAlign: 'center',
          }}
        >
          {/* Warning icon */}
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'rgba(220,80,60,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 24px',
            }}
          >
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#dc503c"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>

          <h3
            style={{
              fontFamily: 'var(--df)',
              fontSize: 24,
              color: 'var(--t1)',
              margin: '0 0 12px',
            }}
          >
            {t('wiz_title')}
          </h3>
          <p
            style={{
              fontSize: 14,
              color: 'var(--t2)',
              margin: '0 0 28px',
              lineHeight: 1.6,
            }}
          >
            {eligibilityError}
          </p>

          <button
            onClick={() => navigate('/employee', { replace: true })}
            className="btn-primary"
          >
            {t('wiz_success_back')}
          </button>
        </div>
      </div>
    );
  }

  // ── Success / Pending tracking screen ──
  if (success) {
    const statusLabel = pendingLoan?.status
      ? t(`status_${pendingLoan.status}`)
      : t('status_pending');

    return (
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '48px 20px' }}>
        <div
          style={{
            background: '#fff',
            borderRadius: 20,
            padding: '48px 32px',
            boxShadow: '0 2px 8px rgba(25,68,69,0.02)',
            border: '1px solid rgba(25,68,69,0.04)',
            textAlign: 'center',
          }}
        >
          {/* Success icon */}
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'rgba(36,122,110,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 24px',
            }}
          >
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#247a6e"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>

          <h3
            style={{
              fontFamily: 'var(--df)',
              fontSize: 24,
              color: 'var(--t1)',
              margin: '0 0 8px',
            }}
          >
            {t('wiz_success_title')}
          </h3>
          <p
            style={{
              fontSize: 14,
              color: 'var(--t2)',
              margin: '0 0 28px',
              lineHeight: 1.6,
            }}
          >
            {t('wiz_success_desc')}
          </p>

          {/* Reference number */}
          <div
            style={{
              background: 'var(--bg2)',
              borderRadius: 12,
              padding: '16px 20px',
              marginBottom: 20,
              border: '1px solid rgba(25,68,69,0.04)',
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 2.2,
                color: 'var(--gold)',
                marginBottom: 8,
              }}
            >
              {t('wiz_success_ref')}
            </div>
            <div
              style={{
                fontFamily: 'var(--mono, monospace)',
                fontSize: 15,
                fontWeight: 600,
                color: 'var(--t1)',
                letterSpacing: 0.5,
              }}
            >
              {success.loanRef}
            </div>
          </div>

          {/* Real-time status badge */}
          <div
            style={{
              background: 'var(--bg2)',
              borderRadius: 12,
              padding: '16px 20px',
              marginBottom: 28,
              border: '1px solid rgba(25,68,69,0.04)',
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 2.2,
                color: 'var(--gold)',
                marginBottom: 8,
              }}
            >
              {t('dash_th_status')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <span
                className={`badge badge-${pendingLoan?.status || 'pending'}`}
                style={{ fontSize: 13 }}
              >
                {statusLabel}
              </span>
            </div>
          </div>

          {/* Summary */}
          <div
            style={{
              borderTop: '1px solid rgba(25,68,69,0.06)',
              padding: '20px 0 0',
              marginBottom: 28,
              display: 'flex',
              justifyContent: 'space-around',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 2.2,
                  color: 'var(--gold)',
                  marginBottom: 4,
                }}
              >
                {t('modal_loan_amount')}
              </div>
              <div style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>
                ${fmt(amount)}
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 2.2,
                  color: 'var(--gold)',
                  marginBottom: 4,
                }}
              >
                {t('modal_total')}
              </div>
              <div style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>
                <PriceValue value={total} status={configStatus} />
              </div>
            </div>
          </div>

          <button
            onClick={() => navigate('/employee', { replace: true })}
            className="btn-primary"
          >
            {t('wiz_success_back')}
          </button>
        </div>
      </div>
    );
  }

  // ── Wizard steps ──
  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '48px 20px' }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1
          style={{
            fontFamily: 'var(--df)',
            fontSize: 28,
            color: 'var(--t1)',
            margin: '0 0 8px',
          }}
        >
          {t('wiz_title')}
        </h1>
        {employee?.name && (
          <p style={{ fontSize: 14, color: 'var(--t2)', margin: 0 }}>
            {t('wiz_subtitle', { name: employee.name })}
          </p>
        )}
      </div>

      {/* Step indicator */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 32 }}>
        {[1, 2, 3, 4].map((s) => (
          <div
            key={s}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 10,
              background: s <= step ? 'var(--brand)' : 'rgba(25,68,69,0.08)',
              transition: 'background 0.3s ease',
            }}
          />
        ))}
      </div>

      {/* Card */}
      <div
        style={{
          background: '#fff',
          borderRadius: 20,
          padding: '32px 28px',
          boxShadow: '0 2px 8px rgba(25,68,69,0.02)',
          border: '1px solid rgba(25,68,69,0.04)',
        }}
      >
        {/* ─── Step 1: Amount ─── */}
        {step === 1 && (
          <div>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 2.2,
                color: 'var(--gold)',
                marginBottom: 8,
              }}
            >
              {t('wiz_step_1_label')}
            </div>
            <h3
              style={{
                fontFamily: 'var(--df)',
                fontSize: 20,
                color: 'var(--t1)',
                margin: '0 0 24px',
              }}
            >
              {t('wiz_step_1_title')}
            </h3>

            {/* Amount display */}
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div
                style={{
                  fontFamily: 'var(--df)',
                  fontSize: 48,
                  color: 'var(--t1)',
                  lineHeight: 1,
                  marginBottom: 4,
                }}
              >
                ${fmt(amount)}
              </div>
              <div style={{ fontSize: 13, color: 'var(--t2)' }}>MXN</div>
            </div>

            {/* Slider */}
            <div className="slider-wrap">
              <div className="sw">
                <div
                  className="sw-fill"
                  style={{ width: `${Math.min(100, Math.max(0, sliderPct))}%` }}
                />
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
              <div className="sw-labels">
                <span>${fmt(MIN_AMOUNT)}</span>
                <span>${fmt(cappedMax)}</span>
              </div>
            </div>

            {/* Salary cap note */}
            {employee?.monthlySalary && cappedMax < MAX_AMOUNT && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--t2)',
                  textAlign: 'center',
                  marginTop: 8,
                }}
              >
                {t('wiz_step_1_max_note', { max: fmt(cappedMax) })}
              </div>
            )}

            {/* Quick amount buttons */}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              {[500, 1000, 2000, 3000, 5000]
                .filter((v) => v <= cappedMax)
                .map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmount(v)}
                    style={{
                      flex: '1 1 auto',
                      padding: '10px 0',
                      borderRadius: 10,
                      border:
                        amount === v
                          ? '1.5px solid var(--brand)'
                          : '1.5px solid rgba(25,68,69,0.08)',
                      background: amount === v ? 'var(--brand)' : 'transparent',
                      color: amount === v ? '#fff' : 'var(--t2)',
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: 'var(--db)',
                      cursor: 'pointer',
                      transition: 'all 0.25s ease',
                      minWidth: 60,
                    }}
                  >
                    ${fmt(v)}
                  </button>
                ))}
            </div>

            <button
              onClick={() => setStep(2)}
              className="btn-primary"
              style={{ marginTop: 28 }}
            >
              {t('wiz_next')}
            </button>
          </div>
        )}


        {/* ─── Step 2: Repayment Preview ─── */}
        {step === 2 && (
          <div>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 2.2,
                color: 'var(--gold)',
                marginBottom: 8,
              }}
            >
              {t('wiz_step_2_label')}
            </div>
            <h3
              style={{
                fontFamily: 'var(--df)',
                fontSize: 20,
                color: 'var(--t1)',
                margin: '0 0 24px',
              }}
            >
              {t('wiz_step_2_title')}
            </h3>

            {/* Term & fee summary row */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 12,
                marginBottom: 24,
              }}
            >
              <div
                style={{
                  background: 'var(--bg2)',
                  borderRadius: 12,
                  padding: '16px 14px',
                  border: '1px solid rgba(25,68,69,0.04)',
                }}
              >
                <div
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: 2.2,
                    color: 'var(--gold)',
                    marginBottom: 6,
                  }}
                >
                  {t('modal_term')}
                </div>
                <div style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>
                  <PriceValue
                    value={termDays}
                    status={configStatus}
                    prefix=""
                    suffix={` ${t('calc_days')}`}
                    shimmerWidth={64}
                  />
                </div>
              </div>
              <div
                style={{
                  background: 'var(--bg2)',
                  borderRadius: 12,
                  padding: '16px 14px',
                  border: '1px solid rgba(25,68,69,0.04)',
                }}
              >
                <div
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: 2.2,
                    color: 'var(--gold)',
                    marginBottom: 6,
                  }}
                >
                  {feeLabel}
                </div>
                <div style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>
                  <PriceValue
                    value={feeRatePct}
                    status={configStatus}
                    prefix=""
                    suffix="%"
                    shimmerWidth={48}
                  />
                </div>
              </div>
            </div>

            {/* Breakdown */}
            <div
              style={{
                borderTop: '1px solid rgba(25,68,69,0.06)',
                borderBottom: '1px solid rgba(25,68,69,0.06)',
                padding: '16px 0',
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t2)' }}>
                  {t('modal_loan_amount')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  ${fmt(amount)}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t2)' }}>
                  {feeLabel}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  <PriceValue value={fee} status={configStatus} />
                </span>
              </div>
              <div
                style={{
                  height: 1,
                  background: 'rgba(25,68,69,0.06)',
                  margin: '4px 0',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--df)',
                    fontSize: 15,
                    color: 'var(--t1)',
                  }}
                >
                  {t('modal_total')}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--df)',
                    fontSize: 18,
                    color: 'var(--t1)',
                  }}
                >
                  <PriceValue value={total} status={configStatus} />
                </span>
              </div>
              {!singleCharge && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '8px 0',
                  }}
                >
                  <span style={{ fontSize: 13, color: 'var(--t2)' }}>
                    {t('wiz_payroll_deduction')}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                    <PriceValue
                      value={deductionAmount}
                      status={configStatus}
                      suffix={` × ${installmentCount}`}
                    />
                  </span>
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t2)' }}>
                  {t('wiz_deduction_date_label')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  <PriceValue
                    value={deductionDateText}
                    status={configStatus}
                    prefix=""
                    shimmerWidth={140}
                  />
                </span>
              </div>
              {deductionDateText !== null && deductionCadenceAssumed && (
                <p
                  data-testid="deduction-cadence-assumed"
                  style={{ fontSize: 11, color: 'var(--t2)', margin: '2px 0 0', lineHeight: 1.5 }}
                >
                  {t('wiz_deduction_date_note')}
                </p>
              )}
            </div>

            {/* One charge, not a payment plan — stated only while the published
                schedule actually is one installment. */}
            {singleCharge && (
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--t2)',
                  lineHeight: 1.5,
                  margin: '0 0 16px',
                }}
              >
                {t('wiz_single_charge_notice')}
              </p>
            )}

            <CatDisclosure cat={cat} status={configStatus} />

            {configStatus === 'error' && <PricingErrorBanner onRetry={retryLoanConfig} />}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setStep(1)}
                type="button"
                style={{
                  flex: '0 0 auto',
                  padding: '14px 20px',
                  borderRadius: 12,
                  border: '1.5px solid rgba(25,68,69,0.08)',
                  background: 'transparent',
                  color: 'var(--t2)',
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: 'var(--db)',
                  cursor: 'pointer',
                }}
              >
                {t('wiz_back')}
              </button>
              <button
                onClick={() => setStep(3)}
                className="btn-primary"
                style={{ flex: 1 }}
                disabled={!pricingReady}
              >
                {t('wiz_next')}
              </button>
            </div>
          </div>
        )}

        {/* ─── Step 3: Review & Confirm ─── */}
        {step === 3 && (
          <div>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 2.2,
                color: 'var(--gold)',
                marginBottom: 8,
              }}
            >
              {t('wiz_step_3_label')}
            </div>
            <h3
              style={{
                fontFamily: 'var(--df)',
                fontSize: 20,
                color: 'var(--t1)',
                margin: '0 0 24px',
              }}
            >
              {t('wiz_step_3_title')}
            </h3>

            {/* Review summary */}
            <div
              style={{
                background: 'var(--bg2)',
                borderRadius: 12,
                padding: '20px 16px',
                border: '1px solid rgba(25,68,69,0.04)',
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t2)' }}>
                  {t('modal_loan_amount')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  ${fmt(amount)} MXN
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t2)' }}>
                  {feeLabel}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  <PriceValue value={fee} status={configStatus} suffix=" MXN" />
                </span>
              </div>
              <div
                style={{
                  height: 1,
                  background: 'rgba(25,68,69,0.06)',
                  margin: '8px 0',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--df)',
                    fontSize: 15,
                    color: 'var(--t1)',
                  }}
                >
                  {t('modal_total')}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--df)',
                    fontSize: 18,
                    color: 'var(--t1)',
                  }}
                >
                  <PriceValue value={total} status={configStatus} suffix=" MXN" />
                </span>
              </div>
              <div
                style={{
                  height: 1,
                  background: 'rgba(25,68,69,0.06)',
                  margin: '8px 0',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t2)' }}>
                  {t('modal_term')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  <PriceValue
                    value={termDays}
                    status={configStatus}
                    prefix=""
                    suffix={` ${t('calc_days')}`}
                    shimmerWidth={64}
                  />
                </span>
              </div>
              {!singleCharge && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '6px 0',
                  }}
                >
                  <span style={{ fontSize: 13, color: 'var(--t2)' }}>
                    {t('wiz_payroll_deduction')}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                    <PriceValue
                      value={deductionAmount}
                      status={configStatus}
                      suffix={` × ${installmentCount}`}
                    />
                  </span>
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t2)' }}>
                  {t('wiz_deduction_date_label')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  <PriceValue
                    value={deductionDateText}
                    status={configStatus}
                    prefix=""
                    shimmerWidth={140}
                  />
                </span>
              </div>
              {deductionDateText !== null && deductionCadenceAssumed && (
                <p
                  data-testid="deduction-cadence-assumed"
                  style={{ fontSize: 11, color: 'var(--t2)', margin: '2px 0 0', lineHeight: 1.5 }}
                >
                  {t('wiz_deduction_date_note')}
                </p>
              )}
              {singleCharge && (
                <p
                  style={{
                    fontSize: 12,
                    color: 'var(--t2)',
                    lineHeight: 1.5,
                    margin: '10px 0 0',
                  }}
                >
                  {t('wiz_single_charge_notice')}
                </p>
              )}
            </div>

            <CatDisclosure cat={cat} status={configStatus} />

            {/* Loan Purpose (optional) */}
            <div style={{ marginBottom: 20 }}>
              <label
                htmlFor="lw-purpose"
                style={{
                  display: 'block',
                  fontSize: 13,
                  color: 'var(--t2)',
                  marginBottom: 8,
                }}
              >
                {t('modal_purpose_label')}
              </label>
              <select
                id="lw-purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: '1.5px solid rgba(25,68,69,0.08)',
                  fontSize: 14,
                  color: 'var(--t1)',
                  fontFamily: 'var(--db)',
                  background: '#fff',
                }}
              >
                <option value="">{t('modal_purpose_none')}</option>
                {LOAN_PURPOSES.map((p) => (
                  <option key={p} value={p}>
                    {t(`modal_purpose_${p}`)}
                  </option>
                ))}
              </select>
            </div>

            {/* Terms checkbox */}
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                marginBottom: 20,
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--t2)',
                lineHeight: 1.5,
              }}
            >
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <span>{t('modal_accept_terms')}</span>
            </label>

            {/* Error */}
            {error && (
              <div className="auth-error show" style={{ marginBottom: 12 }}>
                {error}
              </div>
            )}

            {configStatus === 'error' && <PricingErrorBanner onRetry={retryLoanConfig} />}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setStep(2)}
                type="button"
                style={{
                  flex: '0 0 auto',
                  padding: '14px 20px',
                  borderRadius: 12,
                  border: '1.5px solid rgba(25,68,69,0.08)',
                  background: 'transparent',
                  color: 'var(--t2)',
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: 'var(--db)',
                  cursor: 'pointer',
                }}
              >
                {t('wiz_back')}
              </button>
              <button
                onClick={handleConfirm}
                disabled={!termsAccepted || submitting || !pricingReady}
                className="btn-primary"
                style={{ flex: 1 }}
              >
                {submitting ? (
                  <>
                    <span className="spinner" /> {t('modal_submitting')}
                  </>
                ) : (
                  t('modal_confirm')
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Step description under card */}
      <div style={{ textAlign: 'center', marginTop: 20 }}>
        <span style={{ fontSize: 12, color: 'var(--t2)' }}>
          {t('wiz_step_indicator', { current: step, total: TOTAL_STEPS })}
        </span>
      </div>
    </div>
  );
}
