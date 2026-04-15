import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import confetti from 'canvas-confetti';
import { db } from '../lib/firebase';
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
const STEP = 500;
const MONTHLY_FEE = 0.30;
const TERM_DAYS = 30;

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function LoanWizard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState(1000);
  const [purpose, setPurpose] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ loanRef: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [employeeName, setEmployeeName] = useState('');

  // Fetch employee data
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const empDoc = await getDoc(doc(db, 'employees', user.uid));
        if (!empDoc.exists()) {
          navigate('/employee', { replace: true });
          return;
        }
        const data = empDoc.data();
        setEmployeeName(data.name || user.displayName || '');
      } catch {
        // proceed without name
      } finally {
        setLoading(false);
      }
    })();
  }, [user, navigate]);

  // Calculations
  const fee = Math.round(amount * MONTHLY_FEE);
  const total = amount + fee;
  const payrollDeduction = total; // single deduction at end of month
  const dueDate = new Date(Date.now() + TERM_DAYS * 24 * 60 * 60 * 1000);
  const cat = amount > 0 ? ((Math.pow(1 + fee / amount, 365 / TERM_DAYS) - 1) * 100).toFixed(0) : '0';
  const sliderPct = ((amount - MIN_AMOUNT) / (MAX_AMOUNT - MIN_AMOUNT)) * 100;

  const mapCfError = useCallback((err: unknown): string => {
    const code = (err as { code?: string }).code ?? '';
    const message = (err as { message?: string }).message ?? '';
    const details = (err as { details?: { maxAmount?: number } }).details;

    if (code.includes('resource-exhausted')) return t('wiz_err_rate_limit');
    if (code.includes('failed-precondition') && message.toLowerCase().includes('active loan'))
      return t('wiz_err_active_loan');
    if (code.includes('not-found') || code.includes('permission-denied'))
      return t('wiz_err_employer_not_approved');
    if (code.includes('invalid-argument') && details?.maxAmount != null)
      return t('wiz_err_amount_exceeds');
    if (code.includes('invalid-argument')) return message;

    return t('wiz_err_generic');
  }, [t]);

  const fireConfetti = useCallback(() => {
    const end = Date.now() + 1500;
    const tick = () => {
      confetti({ particleCount: 3, angle: 60, spread: 55, origin: { x: 0, y: 0.7 } });
      confetti({ particleCount: 3, angle: 120, spread: 55, origin: { x: 1, y: 0.7 } });
      if (Date.now() < end) requestAnimationFrame(tick);
    };
    tick();
  }, []);

  const handleConfirm = async () => {
    setError('');
    setSubmitting(true);
    try {
      const functions = getFunctions();
      const requestLoan = httpsCallable<
        { amount: number; purpose: string; termDays: number },
        { loanId: string; loanRef?: string }
      >(functions, 'requestLoan');
      const result = await requestLoan({
        amount,
        purpose,
        termDays: TERM_DAYS,
      });
      setSuccess({ loanRef: result.data.loanRef || result.data.loanId });
      fireConfetti();
    } catch (err) {
      setError(mapCfError(err));
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
        <span className="spinner" style={{ borderColor: 'rgba(25,68,69,0.1)', borderTopColor: 'var(--brand)' }} />
      </div>
    );
  }

  // Success screen
  if (success) {
    return (
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '48px 20px' }}>
        <div style={{
          background: '#fff',
          borderRadius: 20,
          padding: '48px 32px',
          boxShadow: '0 2px 8px rgba(25,68,69,0.02)',
          border: '1px solid rgba(25,68,69,0.04)',
          textAlign: 'center',
        }}>
          {/* Success icon */}
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'rgba(36,122,110,0.08)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px',
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>

          <h3 style={{ fontFamily: 'var(--df)', fontSize: 24, color: 'var(--t1)', margin: '0 0 8px' }}>
            {t('wiz_success_title')}
          </h3>
          <p style={{ fontSize: 14, color: 'var(--t2)', margin: '0 0 28px', lineHeight: 1.6 }}>
            {t('wiz_success_desc')}
          </p>

          {/* Reference number */}
          <div style={{
            background: 'var(--bg2)', borderRadius: 12, padding: '16px 20px', marginBottom: 28,
            border: '1px solid rgba(25,68,69,0.04)',
          }}>
            <div style={{
              fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: 2.2, color: 'var(--gold)', marginBottom: 8,
            }}>
              {t('wiz_success_ref')}
            </div>
            <div style={{ fontFamily: 'var(--mono, monospace)', fontSize: 15, fontWeight: 600, color: 'var(--t1)', letterSpacing: 0.5 }}>
              {success.loanRef}
            </div>
          </div>

          {/* Summary */}
          <div style={{
            borderTop: '1px solid rgba(25,68,69,0.06)',
            padding: '20px 0 0',
            marginBottom: 28,
            display: 'flex', justifyContent: 'space-around',
          }}>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2.2, color: 'var(--gold)', marginBottom: 4 }}>
                {t('modal_loan_amount')}
              </div>
              <div style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>${fmt(amount)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2.2, color: 'var(--gold)', marginBottom: 4 }}>
                {t('modal_total')}
              </div>
              <div style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>${fmt(total)}</div>
            </div>
          </div>

          <button
            onClick={() => navigate('/employee', { replace: true, state: { toast: t('toast_loan_submitted') } })}
            className="btn-primary"
          >
            {t('wiz_success_back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '48px 20px' }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: 'var(--df)', fontSize: 28, color: 'var(--t1)', margin: '0 0 8px' }}>
          {t('wiz_title')}
        </h1>
        {employeeName && (
          <p style={{ fontSize: 14, color: 'var(--t2)', margin: 0 }}>
            {t('wiz_subtitle', { name: employeeName })}
          </p>
        )}
      </div>

      {/* Step indicator */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 32 }}>
        {[1, 2, 3, 4].map((s) => (
          <div
            key={s}
            style={{
              flex: 1, height: 3, borderRadius: 10,
              background: s <= step ? 'var(--brand)' : 'rgba(25,68,69,0.08)',
              transition: 'background 0.3s ease',
            }}
          />
        ))}
      </div>

      {/* Card */}
      <div style={{
        background: '#fff',
        borderRadius: 20,
        padding: '32px 28px',
        boxShadow: '0 2px 8px rgba(25,68,69,0.02)',
        border: '1px solid rgba(25,68,69,0.04)',
      }}>

        {/* ─── Step 1: Amount ─── */}
        {step === 1 && (
          <div>
            <div style={{
              fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: 2.2, color: 'var(--gold)', marginBottom: 8,
            }}>
              {t('wiz_step_1_label')}
            </div>
            <h3 style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)', margin: '0 0 24px' }}>
              {t('wiz_step_1_title')}
            </h3>

            {/* Amount display */}
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{
                fontFamily: 'var(--df)', fontSize: 48, color: 'var(--t1)',
                lineHeight: 1, marginBottom: 4,
              }}>
                ${fmt(amount)}
              </div>
              <div style={{ fontSize: 13, color: 'var(--t3)' }}>MXN</div>
            </div>

            {/* Slider */}
            <div className="slider-wrap">
              <div className="sw">
                <div className="sw-fill" style={{ width: `${sliderPct}%` }} />
              </div>
              <input
                type="range"
                min={MIN_AMOUNT}
                max={MAX_AMOUNT}
                step={STEP}
                value={amount}
                onChange={(e) => setAmount(parseInt(e.target.value))}
              />
              <div className="sw-labels">
                <span>${fmt(MIN_AMOUNT)}</span>
                <span>${fmt(MAX_AMOUNT)}</span>
              </div>
            </div>

            {/* Quick amount buttons */}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              {[500, 1000, 2000, 3000, 5000].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setAmount(v)}
                  style={{
                    flex: '1 1 auto',
                    padding: '10px 0',
                    borderRadius: 10,
                    border: amount === v ? '1.5px solid var(--brand)' : '1.5px solid rgba(25,68,69,0.08)',
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

        {/* ─── Step 2: Loan Terms ─── */}
        {step === 2 && (
          <div>
            <div style={{
              fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: 2.2, color: 'var(--gold)', marginBottom: 8,
            }}>
              {t('wiz_step_2_label')}
            </div>
            <h3 style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)', margin: '0 0 24px' }}>
              {t('wiz_step_2_title')}
            </h3>

            {/* Term details */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24,
            }}>
              <div style={{
                background: 'var(--bg2)', borderRadius: 12, padding: '16px 14px',
                border: '1px solid rgba(25,68,69,0.04)',
              }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2.2, color: 'var(--gold)', marginBottom: 6 }}>
                  {t('modal_term')}
                </div>
                <div style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>
                  {TERM_DAYS} {t('calc_days')}
                </div>
              </div>
              <div style={{
                background: 'var(--bg2)', borderRadius: 12, padding: '16px 14px',
                border: '1px solid rgba(25,68,69,0.04)',
              }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2.2, color: 'var(--gold)', marginBottom: 6 }}>
                  {t('wiz_monthly_fee')}
                </div>
                <div style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>
                  30%
                </div>
              </div>
            </div>

            {/* Breakdown */}
            <div style={{
              borderTop: '1px solid rgba(25,68,69,0.06)',
              borderBottom: '1px solid rgba(25,68,69,0.06)',
              padding: '16px 0', marginBottom: 20,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_loan_amount')}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(amount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_fee')}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(fee)}</span>
              </div>
              <div style={{ height: 1, background: 'rgba(25,68,69,0.06)', margin: '4px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                <span style={{ fontFamily: 'var(--df)', fontSize: 15, color: 'var(--t1)' }}>{t('modal_total')}</span>
                <span style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>${fmt(total)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('wiz_payroll_deduction')}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(payrollDeduction)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_due_date')}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{dueDate.toLocaleDateString()}</span>
              </div>
            </div>

            {/* CAT disclosure */}
            <div style={{
              background: 'var(--bg2)', borderRadius: 12, padding: '14px 16px',
              border: '1px solid rgba(25,68,69,0.04)', marginBottom: 24,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_cat_label')}</span>
                <span className="cat-highlight">{cat}{t('modal_cat_annual')}</span>
              </div>
              <p style={{ fontSize: 11, color: 'var(--t3)', margin: 0, lineHeight: 1.5 }}>
                {t('modal_cat_note')}{' '}
                <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand)' }}>
                  {t('modal_cat_condusef')}
                </a>
              </p>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setStep(1)}
                type="button"
                style={{
                  flex: '0 0 auto', padding: '14px 20px', borderRadius: 12,
                  border: '1.5px solid rgba(25,68,69,0.08)', background: 'transparent',
                  color: 'var(--t2)', fontSize: 14, fontWeight: 600, fontFamily: 'var(--db)',
                  cursor: 'pointer',
                }}
              >
                {t('wiz_back')}
              </button>
              <button
                onClick={() => setStep(3)}
                className="btn-primary"
                style={{ flex: 1 }}
              >
                {t('wiz_next')}
              </button>
            </div>
          </div>
        )}

        {/* ─── Step 3: Purpose ─── */}
        {step === 3 && (
          <div>
            <div style={{
              fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: 2.2, color: 'var(--gold)', marginBottom: 8,
            }}>
              {t('wiz_step_3_label')}
            </div>
            <h3 style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)', margin: '0 0 8px' }}>
              {t('wiz_step_3_title')}
            </h3>
            <p style={{ fontSize: 13, color: 'var(--t3)', margin: '0 0 24px' }}>
              {t('wiz_step_3_desc')}
            </p>

            {/* Purpose options */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
              {LOAN_PURPOSES.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPurpose(p)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '14px 16px', borderRadius: 12,
                    border: purpose === p ? '1.5px solid var(--brand)' : '1.5px solid rgba(25,68,69,0.08)',
                    background: purpose === p ? 'rgba(25,68,69,0.03)' : 'transparent',
                    cursor: 'pointer', transition: 'all 0.25s ease',
                    textAlign: 'left', fontFamily: 'var(--db)',
                  }}
                >
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%',
                    border: purpose === p ? '6px solid var(--brand)' : '2px solid rgba(25,68,69,0.15)',
                    flexShrink: 0, transition: 'border 0.2s ease',
                  }} />
                  <span style={{
                    fontSize: 14, fontWeight: 500,
                    color: purpose === p ? 'var(--t1)' : 'var(--t2)',
                  }}>
                    {t(`modal_purpose_${p}`)}
                  </span>
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setStep(2)}
                type="button"
                style={{
                  flex: '0 0 auto', padding: '14px 20px', borderRadius: 12,
                  border: '1.5px solid rgba(25,68,69,0.08)', background: 'transparent',
                  color: 'var(--t2)', fontSize: 14, fontWeight: 600, fontFamily: 'var(--db)',
                  cursor: 'pointer',
                }}
              >
                {t('wiz_back')}
              </button>
              <button
                onClick={() => setStep(4)}
                disabled={!purpose}
                className="btn-primary"
                style={{ flex: 1 }}
              >
                {t('wiz_next')}
              </button>
            </div>
          </div>
        )}

        {/* ─── Step 4: Review & Confirm ─── */}
        {step === 4 && (
          <div>
            <div style={{
              fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: 2.2, color: 'var(--gold)', marginBottom: 8,
            }}>
              {t('wiz_step_4_label')}
            </div>
            <h3 style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)', margin: '0 0 24px' }}>
              {t('wiz_step_4_title')}
            </h3>

            {/* Review summary */}
            <div style={{
              background: 'var(--bg2)', borderRadius: 12, padding: '20px 16px',
              border: '1px solid rgba(25,68,69,0.04)', marginBottom: 20,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_loan_amount')}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(amount)} MXN</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_fee')}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(fee)} MXN</span>
              </div>
              <div style={{ height: 1, background: 'rgba(25,68,69,0.06)', margin: '8px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ fontFamily: 'var(--df)', fontSize: 15, color: 'var(--t1)' }}>{t('modal_total')}</span>
                <span style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>${fmt(total)} MXN</span>
              </div>
              <div style={{ height: 1, background: 'rgba(25,68,69,0.06)', margin: '8px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_term')}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{TERM_DAYS} {t('calc_days')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('wiz_payroll_deduction')}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(payrollDeduction)} MXN</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_due_date')}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{dueDate.toLocaleDateString()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_purpose_label')}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{t(`modal_purpose_${purpose}`)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_cat_label')}</span>
                <span className="cat-highlight">{cat}{t('modal_cat_annual')}</span>
              </div>
            </div>

            {/* Terms checkbox */}
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 20,
              cursor: 'pointer', fontSize: 13, color: 'var(--t2)', lineHeight: 1.5,
            }}>
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
              <div className="auth-error show" style={{ marginBottom: 12 }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setStep(3)}
                type="button"
                style={{
                  flex: '0 0 auto', padding: '14px 20px', borderRadius: 12,
                  border: '1.5px solid rgba(25,68,69,0.08)', background: 'transparent',
                  color: 'var(--t2)', fontSize: 14, fontWeight: 600, fontFamily: 'var(--db)',
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
                  <><span className="spinner" /> {t('modal_submitting')}</>
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
