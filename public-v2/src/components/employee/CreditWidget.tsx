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

/**
 * Capture first: the available credit is the first thing on the Home board —
 * a 50px numeral with MXN as a light suffix — and the one green control on
 * the screen sits directly under it. The limit and utilisation are not
 * chrome here; the companion explains them on request.
 */
export function CreditWidget({ employee, hasActiveLoan, onOpenModal }: CreditWidgetProps) {
  const { t } = useTranslation();
  const [activeLoanError, setActiveLoanError] = useState(false);

  const handleCTA = () => {
    if (hasActiveLoan) {
      setActiveLoanError(true);
      return;
    }
    setActiveLoanError(false);
    onOpenModal();
  };

  return (
    <>
      <div className="bo-bal-l sh">{t('dash_available_credit')}</div>
      <div className="bo-bal sh money">
        {fmt(employee.availableCredit)}<small>MXN</small>
      </div>

      <div style={{ marginTop: 18 }}>
        <button
          type="button"
          onClick={handleCTA}
          disabled={employee.availableCredit < 500}
          className="bo-cta"
        >
          {t('dash_request_funds')}
        </button>
      </div>

      {activeLoanError && (
        <div role="alert" aria-live="polite" className="bo-alert">
          {t('dash_active_loan_error', 'Ya tienes un crédito activo. Termina de pagarlo antes de solicitar otro.')}
        </div>
      )}
    </>
  );
}
