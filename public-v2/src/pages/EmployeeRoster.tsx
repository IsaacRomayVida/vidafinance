import { useTranslation } from 'react-i18next';

export function EmployeeRoster() {
  const { t } = useTranslation();

  return (
    <div>
      <h1 className="text-2xl font-bold text-teal-900">
        {t('dash_employees', 'Employees')}
      </h1>
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <p className="text-sm text-gray-500">
          {t('roster_empty', 'No employees enrolled yet.')}
        </p>
      </div>
    </div>
  );
}
