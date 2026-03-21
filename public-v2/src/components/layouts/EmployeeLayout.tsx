import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';
import { VidaLogo } from '../shared/VidaLogo';

export function EmployeeLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  return (
    <div className="dash">
      <aside className="dash-side">
        <Link to="/" className="nav-logo">
          <VidaLogo />
        </Link>
        <nav className="dash-nav">
          <Link
            to="/employee"
            className={location.pathname === '/employee' ? 'active' : ''}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            {t('dash_dashboard')}
          </Link>
          <Link
            to="/employee/loans"
            className={location.pathname === '/employee/loans' ? 'active' : ''}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
            </svg>
            {t('dash_my_loans')}
          </Link>
        </nav>
        <button className="dash-logout" onClick={handleSignOut}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 18, height: 18, opacity: 0.4 }}>
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
          {t('dash_signout')}
        </button>
      </aside>
      <main className="dash-main">
        <Outlet />
      </main>
    </div>
  );
}
