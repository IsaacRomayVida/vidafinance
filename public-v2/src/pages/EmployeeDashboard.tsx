import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';

export function EmployeeDashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();

  return (
    <div>
      <h1 className="text-2xl font-bold text-teal-900">
        {t('dash_welcome')}, {user?.displayName ?? user?.email}
      </h1>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_available_credit')}</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">$0 MXN</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_credit_limit')}</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">$0 MXN</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_utilization')}</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">0%</p>
        </div>
      </div>
      <div className="mt-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-teal-900">{t('dash_your_loans')}</h2>
        <p className="mt-4 text-sm text-gray-500">{t('dash_no_loans_employee')}</p>
      </div>
    </div>
  );
}
