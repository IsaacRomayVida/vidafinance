import { useTranslation } from 'react-i18next';

export function OnboardingWizard() {
  const { t } = useTranslation();

  return (
    <div className="ops-page">
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_payroll')}</div>
          <h1 className="ops-title">{t('onboarding_title', 'Employee Onboarding')}</h1>
        </div>
      </div>
      <div className="ops-card">
        <p className="ops-sub">{t('onboarding_desc', 'Onboarding wizard coming soon.')}</p>
      </div>
    </div>
  );
}
