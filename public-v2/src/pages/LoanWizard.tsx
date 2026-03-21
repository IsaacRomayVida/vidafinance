import { useTranslation } from 'react-i18next';

export function LoanWizard() {
  const { t } = useTranslation();

  return (
    <div>
      <h1 className="text-2xl font-bold text-teal-900">
        {t('loan_apply_title', 'Apply for a Loan')}
      </h1>
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <p className="text-sm text-gray-500">
          {t('loan_apply_coming_soon', 'Loan application wizard coming soon.')}
        </p>
      </div>
    </div>
  );
}
