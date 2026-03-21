import { useTranslation } from 'react-i18next';

export function OnboardingWizard() {
  const { t } = useTranslation();

  return (
    <div>
      <h1 className="text-2xl font-bold text-teal-900">
        {t('onboarding_title', 'Employee Onboarding')}
      </h1>
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <p className="text-sm text-gray-500">
          {t('onboarding_desc', 'Onboarding wizard coming soon.')}
        </p>
      </div>
    </div>
  );
}
