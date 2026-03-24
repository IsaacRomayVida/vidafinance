import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

export function LoanWizard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [show, setShow] = useState(true);

  useEffect(() => {
    // Show toast briefly, then redirect to employee dashboard where the loan modal lives
    const timer = setTimeout(() => {
      setShow(false);
      navigate('/employee', { replace: true });
    }, 2500);

    return () => clearTimeout(timer);
  }, [navigate]);

  return (
    <div className="flex items-center justify-center py-20">
      {show && (
        <div
          style={{
            background: 'var(--brand)',
            color: '#fff',
            padding: '14px 28px',
            borderRadius: 12,
            fontSize: 14,
            fontWeight: 600,
            boxShadow: '0 4px 24px rgba(0,0,0,0.12)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          {t('loan_wizard_redirect', 'Redirecting to your dashboard to apply for a loan...')}
        </div>
      )}
    </div>
  );
}
