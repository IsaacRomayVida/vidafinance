import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';
import { StepAmount } from '../components/loan/StepAmount';
import {
  MIN_AMOUNT,
  MAX_AMOUNT,
  STEP_INCREMENT,
  MONTHLY_FEE,
  TERM_DAYS,
  fmt,
} from '../components/loan/LoanWizard';
import type { LoanPurpose } from '../components/loan/LoanWizard';

export function LoanWizard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState(1000);
  const [purpose, setPurpose] = useState<LoanPurpose | ''>('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ loanRef: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [employeeName, setEmployeeName] = useState('');
  const [salary, setSalary] = useState<number | undefined>(undefined);
  const [availableCredit, setAvailableCredit] = useState<number | undefined>(undefined);

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
        if (data.salary) setSalary(Number(data.salary));
        if (data.availableCredit != null) setAvailableCredit(Number(data.availableCredit));
      } catch {
        // proceed without name
      } finally {
        setLoading(false);
      }
    })();
  }, [user, navigate]);

  // Derived max = min(availableCredit, salary*0.3, 5000)
  const effectiveMax = useMemo(() => {
    const caps = [MAX_AMOUNT];
    if (availableCredit != null && availableCredit > 0) caps.push(availableCredit);
    if (salary != null && salary > 0) caps.push(Math.floor(salary * 0.3));
    const raw = Math.min(...caps);
    return Math.max(MIN_AMOUNT, Math.floor(raw / STEP_INCREMENT) * STEP_INCREMENT);
  }, [availableCredit, salary]);

  // Calculations
  const fee = Math.round(amount * MONTHLY_FEE);
  const total = amount + fee;
  const payrollDeduction = total; // single deduction at end of month
  const dueDate = new Date(Date.now() + TERM_DAYS * 24 * 60 * 60 * 1000);
  const cat = amount > 0 ? ((Math.pow(1 + fee / amount, 365 / TERM_DAYS) - 1) * 100).toFixed(0) : '0';

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
            onClick={() => navigate('/employee', { replace: true })}
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
        {[1, 2, 3].map((s) => (
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

        {/* ─── Step 1: Amount + Purpose ─── */}
        {step === 1 && (
          <StepAmount
            amount={amount}
            onAmountChange={setAmount}
            purpose={purpose}
            onPurposeChange={setPurpose}
            min={MIN_AMOUNT}
            max={effectiveMax}
            step={STEP_INCREMENT}
            fee={fee}
            total={total}
            cat={cat}
            onNext={() => setStep(2)}
          />
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
                onClick={() => { if (purpose) setStep(3); }}
                disabled={!purpose}
                className="btn-primary"
                style={{ flex: 1 }}
              >
                {t('wiz_next')}
              </button>
            </div>
          </div>
        )}

        {/* ─── Step 3: Review & Confirm ─── */}
        {step === 3 && (
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
          {t('wiz_step_indicator', { current: step, total: 3 })}
        </span>
      </div>
    </div>
  );
}
