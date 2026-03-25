import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';

export function EmployerLayout() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white" style={{ borderBottom: '1px solid #e5e7eb', backgroundColor: '#fff' }}>
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4 flex-wrap gap-y-2" style={{ display: 'flex', maxWidth: '72rem', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', flexWrap: 'wrap', gap: '8px 0' }}>
          <Link to="/employer" className="text-xl font-bold text-teal-900" style={{ fontSize: '1.25rem', fontWeight: 700, color: '#134e4a', textDecoration: 'none' }}>
            VIDA
          </Link>
          <div className="flex items-center flex-wrap" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px 16px' }}>
            <Link
              to="/employer"
              className="text-sm font-medium text-teal-700 hover:text-teal-900"
            >
              {t('dash_dashboard')}
            </Link>
            <Link
              to="/employer/employees"
              className="text-sm font-medium text-teal-700 hover:text-teal-900"
            >
              {t('dash_employees')}
            </Link>
            <Link
              to="/employer/deductions"
              className="text-sm font-medium text-teal-700 hover:text-teal-900"
            >
              {t('dash_loans')}
            </Link>
            <button className="nav-lang" onClick={() => { const next = i18n.language === 'es' ? 'en' : 'es'; i18n.changeLanguage(next); localStorage.setItem('vida_lang', next); }}>
              {i18n.language === 'es' ? 'EN' : 'ES'}
            </button>
            <button
              onClick={handleSignOut}
              className="text-sm font-medium text-gray-500 hover:text-gray-700"
            >
              {t('dash_signout')}
            </button>
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8" style={{ maxWidth: '72rem', margin: '0 auto', padding: '32px 24px' }}>
        <Outlet />
      </main>
    </div>
  );
}
