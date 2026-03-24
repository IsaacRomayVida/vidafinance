import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';

export function EmployeeLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/employee" className="text-xl font-bold text-teal-900">
            VIDA
          </Link>
          <div className="flex flex-wrap items-center gap-4">
            <Link
              to="/employee"
              className="text-sm font-medium text-teal-700 hover:text-teal-900"
            >
              {t('dash_dashboard')}
            </Link>
            <Link
              to="/employee/loans"
              className="text-sm font-medium text-teal-700 hover:text-teal-900"
            >
              {t('dash_my_loans')}
            </Link>
            <button
              onClick={handleSignOut}
              className="text-sm font-medium text-gray-500 hover:text-gray-700"
            >
              {t('dash_signout')}
            </button>
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
