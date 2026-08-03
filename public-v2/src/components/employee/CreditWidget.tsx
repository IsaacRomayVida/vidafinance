import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EmployeeData, Loan } from './types';
import { fmt } from './types';

interface CreditWidgetProps {
  employee: EmployeeData;
  loans: Loan[];
  hasActiveLoan: boolean;
  onOpenModal: () => void;
}

export function CreditWidget({ employee, loans, hasActiveLoan, onOpenModal }: CreditWidgetProps) {
  const { t } = useTranslation();
  const [activeLoanError, setActiveLoanError] = useState(false);

  const utilized = employee.creditLimit - employee.availableCredit;
  const utilPct = employee.creditLimit > 0
    ? Math.round((utilized / employee.creditLimit) * 100)
    : 0;

  const handleCTA = () => {
    if (hasActiveLoan) {
      setActiveLoanError(true);
      return;
    }
    setActiveLoanError(false);
    onOpenModal();
  };

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 40,
      marginBottom: 48, alignItems: 'center',
    }}>
      {/* Left: Credit Ring */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 0' }}>
        <div style={{ position: 'relative', width: 200, height: 200 }}>
          <svg width="200" height="200" viewBox="0 0 200 200" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx="100" cy="100" r="85" fill="none" stroke="rgba(25,68,69,0.04)" strokeWidth="12" />
            <circle cx="100" cy="100" r="85" fill="none"
              stroke="url(#creditGrad)" strokeWidth="12" strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 85}
              strokeDashoffset={2 * Math.PI * 85 * (1 - utilPct / 100)}
              style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(0.16,1,0.3,1)' }}
            />
            <defs>
              <linearGradient id="creditGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#194445" />
                <stop offset="100%" stopColor="#a8d5d0" />
              </linearGradient>
            </defs>
          </svg>
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--gold)', marginBottom: 6 }}>
              {t('dash_utilization')}
            </div>
            <div className="money" style={{ fontFamily: 'var(--df)', fontSize: 42, color: 'var(--t1)', lineHeight: 1 }}>
              {utilPct}%
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--t2)', marginBottom: 6 }}>
            {t('dash_credit_limit')}
          </div>
          <div className="money" style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t2)' }}>
            ${fmt(employee.creditLimit)} <span style={{ fontSize: 12, color: 'var(--t2)', fontFamily: 'var(--db)' }}>MXN</span>
          </div>
        </div>
      </div>

      {/* Right: Amount + CTA */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2.5, textTransform: 'uppercase', color: 'var(--gold)', marginBottom: 12 }}>
          {t('dash_available_credit')}
        </div>
        <div className="money" style={{
          fontFamily: 'var(--df)', fontSize: 56, color: 'var(--t1)',
          lineHeight: 1, letterSpacing: '-0.03em', marginBottom: 4,
        }}>
          <span style={{ fontSize: 24, color: 'var(--aqua)', opacity: 0.6, verticalAlign: 'top', marginRight: 2 }}>$</span>
          {fmt(employee.availableCredit)}
        </div>
        <div style={{ fontSize: 14, color: 'var(--t2)', marginBottom: 32 }}>MXN</div>

        <button
          onClick={handleCTA}
          disabled={employee.availableCredit < 500}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 10,
            padding: '18px 36px', borderRadius: 14, border: 'none',
            background: employee.availableCredit >= 500
              ? 'linear-gradient(135deg, var(--brand) 0%, var(--brand-mid) 100%)'
              : 'rgba(25,68,69,0.08)',
            color: employee.availableCredit >= 500 ? 'white' : 'var(--t3)',
            fontSize: 16, fontWeight: 700, fontFamily: 'var(--db)',
            cursor: employee.availableCredit >= 500 ? 'pointer' : 'not-allowed',
            boxShadow: employee.availableCredit >= 500
              ? '0 4px 20px rgba(25,68,69,0.2), inset 0 1px 0 rgba(255,255,255,0.1)'
              : 'none',
            transition: 'all 0.35s cubic-bezier(0.22,1,0.36,1)',
            letterSpacing: '0.01em',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
          </svg>
          {t('dash_request_funds')}
        </button>

        {activeLoanError && (
          <div
            role="alert"
            aria-live="polite"
            style={{
              marginTop: 12, padding: '12px 16px', borderRadius: 10,
              background: 'rgba(220,80,60,0.06)', border: '1px solid rgba(220,80,60,0.15)',
              fontSize: 13, color: 'var(--danger)', lineHeight: 1.5,
            }}
          >
            {t('dash_active_loan_error', 'Ya tienes un préstamo activo. Completa tu préstamo actual antes de solicitar otro.')}
          </div>
        )}

        {/* Quick stats row */}
        <div style={{ display: 'flex', gap: 32, marginTop: 32, paddingTop: 24, borderTop: '1px solid rgba(25,68,69,0.05)' }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: 'var(--t2)', marginBottom: 4 }}>
              {t('dash_active_loans', 'Préstamos activos')}
            </div>
            <div style={{ fontFamily: 'var(--df)', fontSize: 24, color: 'var(--t1)' }}>
              {loans.filter(l => l.status === 'active' || l.status === 'approved').length}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: 'var(--t2)', marginBottom: 4 }}>
              {t('dash_total_borrowed', 'Total prestado')}
            </div>
            <div className="money" style={{ fontFamily: 'var(--df)', fontSize: 24, color: 'var(--t1)' }}>
              ${fmt(loans.reduce((s, l) => s + (l.amount || 0), 0))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
