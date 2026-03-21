import { useTranslation } from 'react-i18next';

export function EmployerDashboard() {
  const { t } = useTranslation();

  return (
    <div>
      <h1 className="text-2xl font-bold text-teal-900">{t('dash_dashboard')}</h1>
      <div className="mt-6 grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_total_employees')}</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">0</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_active_loans')}</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">0</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_pending_requests')}</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">0</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_total_disbursed')}</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">$0</p>
        </div>
      </div>
      <div className="mt-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-teal-900">{t('dash_recent_loans')}</h2>
        <p className="mt-4 text-sm text-gray-500">{t('dash_no_loans_employer')}</p>
      </div>
    </div>
  );
}
