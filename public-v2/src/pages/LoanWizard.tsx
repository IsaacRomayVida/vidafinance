import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  doc,
  getDoc,
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

const MIN_AMOUNT = 500;
const MAX_AMOUNT = 5000;
const STEP = 100;
const ACTIVE_STATUSES = ['pending', 'under_review', 'approved', 'disbursed', 'disbursement_queued'];

interface LoanConfig {
  feeRate: number;
  allowedTermDays: number[];
  defaultTermDays: number;
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

export function LoanWizard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  // Loading & eligibility
  const [loading, setLoading] = useState(true);
  const [eligibilityError, setEligibilityError] = useState('');
  const [employee, setEmployee] = useState<EmployeeData | null>(null);
  const [loanConfig, setLoanConfig] = useState<LoanConfig | null>(null);

  // Wizard state
  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState(1000);
  const [termDays, setTermDays] = useState<number>(30);
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
  const feeRate = loanConfig?.feeRate ?? 0;
  const feeRatePct = Math.round(feeRate * 100);
  const fee = Math.round(amount * feeRate);
  const total = amount + fee;
  const biweeklyPeriods = Math.ceil(termDays / 15);
  const biweeklyDeduction = Math.ceil(total / biweeklyPeriods);
  const dueDate = new Date(Date.now() + termDays * 24 * 60 * 60 * 1000);
  const cat =
    amount > 0
      ? ((Math.pow(1 + fee / amount, 365 / termDays) - 1) * 100).toFixed(0)
      : '0';
  const sliderPct = ((amount - MIN_AMOUNT) / (cappedMax - MIN_AMOUNT)) * 100;

  // ── Fetch employee data & check eligibility ──
  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        const functions = getFunctions();
        const getLoanConfig = httpsCallable<Record<string, never>, LoanConfig>(
          functions,
          'getLoanConfig'
        );
        const [empDoc, configResult] = await Promise.all([
          getDoc(doc(db, 'employees', user.uid)),
          getLoanConfig(),
        ]);
        const config = configResult.data;
        setLoanConfig(config);
        setTermDays(config.defaultTermDays);

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
        const { getDocs } = await import('firebase/firestore');
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

  const handleConfirm = async () => {
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
                ${fmt(total)}
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
              <div style={{ fontSize: 13, color: 'var(--t3)' }}>MXN</div>
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
                  color: 'var(--t3)',
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

        {/* ─── Step 2: Term Selection ─── */}
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
                margin: '0 0 8px',
              }}
            >
              {t('wiz_step_2_title')}
            </h3>
            <p style={{ fontSize: 13, color: 'var(--t3)', margin: '0 0 24px' }}>
              {t('wiz_step_2_desc')}
            </p>

            {/* Term options */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
              {(loanConfig?.allowedTermDays ?? []).map((days) => {
                const periods = Math.ceil(days / 15);
                const deduction = Math.ceil((amount + Math.round(amount * feeRate)) / periods);
                const isSelected = termDays === days;

                return (
                  <button
                    key={days}
                    type="button"
                    onClick={() => setTermDays(days)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '16px 18px',
                      borderRadius: 14,
                      border: isSelected
                        ? '1.5px solid var(--brand)'
                        : '1.5px solid rgba(25,68,69,0.08)',
                      background: isSelected ? 'rgba(25,68,69,0.03)' : 'transparent',
                      cursor: 'pointer',
                      transition: 'all 0.25s ease',
                      textAlign: 'left',
                      fontFamily: 'var(--db)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          border: isSelected
                            ? '6px solid var(--brand)'
                            : '2px solid rgba(25,68,69,0.15)',
                          flexShrink: 0,
                          transition: 'border 0.2s ease',
                        }}
                      />
                      <div>
                        <div
                          style={{
                            fontSize: 15,
                            fontWeight: 600,
                            color: isSelected ? 'var(--t1)' : 'var(--t2)',
                          }}
                        >
                          {t('wiz_term_days', { days })}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
                          {periods === 1
                            ? t('wiz_term_biweekly', { count: periods })
                            : t('wiz_term_biweekly_plural', { count: periods })}
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: isSelected ? 'var(--t1)' : 'var(--t2)',
                        }}
                      >
                        ${fmt(deduction)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--t3)' }}>
                        /{t('wiz_biweekly_deduction').toLowerCase().split(' ')[0]}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

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
              <button onClick={() => setStep(3)} className="btn-primary" style={{ flex: 1 }}>
                {t('wiz_next')}
              </button>
            </div>
          </div>
        )}

        {/* ─── Step 3: Repayment Preview ─── */}
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
                  {termDays} {t('calc_days')}
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
                  {t('wiz_flat_fee', { rate: feeRatePct })}
                </div>
                <div style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>
                  {t('wiz_flat_fee_rate', { rate: feeRatePct })}
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
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
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
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  {t('wiz_flat_fee', { rate: feeRatePct })}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  ${fmt(fee)}
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
                  ${fmt(total)}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  {t('wiz_biweekly_deduction')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  ${fmt(biweeklyDeduction)} × {biweeklyPeriods}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  {t('modal_due_date')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  {dueDate.toLocaleDateString()}
                </span>
              </div>
            </div>

            {/* CAT disclosure */}
            <div
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
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  {t('modal_cat_label')}
                </span>
                <span className="cat-highlight">
                  {cat}
                  {t('modal_cat_annual')}
                </span>
              </div>
              <p
                style={{
                  fontSize: 11,
                  color: 'var(--t3)',
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
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
              <button onClick={() => setStep(4)} className="btn-primary" style={{ flex: 1 }}>
                {t('wiz_next')}
              </button>
            </div>
          </div>
        )}

        {/* ─── Step 4: Review & Confirm ─── */}
        {step === 4 && (
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
              {t('wiz_step_4_label')}
            </div>
            <h3
              style={{
                fontFamily: 'var(--df)',
                fontSize: 20,
                color: 'var(--t1)',
                margin: '0 0 24px',
              }}
            >
              {t('wiz_step_4_title')}
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
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
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
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  {t('wiz_flat_fee', { rate: feeRatePct })}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  ${fmt(fee)} MXN
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
                  ${fmt(total)} MXN
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
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  {t('modal_term')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  {termDays} {t('calc_days')}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  {t('wiz_biweekly_deduction')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  ${fmt(biweeklyDeduction)} × {biweeklyPeriods}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  {t('modal_due_date')}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                  {dueDate.toLocaleDateString()}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  {t('modal_cat_label')}
                </span>
                <span className="cat-highlight">
                  {cat}
                  {t('modal_cat_annual')}
                </span>
              </div>
            </div>

            {/* Loan Purpose (optional) */}
            <div style={{ marginBottom: 20 }}>
              <label
                htmlFor="lw-purpose"
                style={{
                  display: 'block',
                  fontSize: 13,
                  color: 'var(--t3)',
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

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setStep(3)}
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
                disabled={!termsAccepted || submitting}
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
        <span style={{ fontSize: 12, color: 'var(--t3)' }}>
          {t('wiz_step_indicator', { current: step, total: 4 })}
        </span>
      </div>
    </div>
  );
}
