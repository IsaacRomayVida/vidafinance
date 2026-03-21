import { useTranslation } from 'react-i18next';

export function AnalyticsPage() {
  const { t } = useTranslation();

  return (
    <div>
      <h1 className="text-2xl font-bold text-teal-900">
        {t('analytics_title', 'Analytics')}
      </h1>
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <p className="text-sm text-gray-500">
          {t('analytics_empty', 'Analytics dashboard coming soon.')}
        </p>
      </div>
    </div>
  );
}
