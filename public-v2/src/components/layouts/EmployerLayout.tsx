import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';

export function EmployerLayout() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  const isActive = (path: string) => location.pathname === path;

  const linkStyle = (path: string): React.CSSProperties => ({
    fontSize: 13,
    fontWeight: isActive(path) ? 700 : 500,
    color: isActive(path) ? '#194445' : '#93aaa9',
    textDecoration: 'none',
    padding: '8px 0',
    borderBottom: isActive(path) ? '2px solid #194445' : '2px solid transparent',
    transition: 'all 0.2s',
    whiteSpace: 'nowrap' as const,
  });

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9f8' }}>
      <header style={{ background: '#fff', borderBottom: '1px solid rgba(25,68,69,0.06)' }}>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '16px 20px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Link to="/employer" style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 22, fontWeight: 400, color: '#194445', textDecoration: 'none' }}>
              VIDA
            </Link>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                onClick={() => { const next = i18n.language === 'es' ? 'en' : 'es'; i18n.changeLanguage(next); localStorage.setItem('vida_lang', next); }}
                style={{ fontSize: 11, fontWeight: 600, color: '#93aaa9', background: 'none', border: '1px solid rgba(25,68,69,0.1)', borderRadius: 20, padding: '4px 12px', cursor: 'pointer' }}
              >
                {i18n.language === 'es' ? 'EN' : 'ES'}
              </button>
              <button
                onClick={handleSignOut}
                style={{ fontSize: 12, fontWeight: 500, color: '#93aaa9', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {t('dash_signout')}
              </button>
            </div>
          </div>
          <nav style={{ display: 'flex', gap: 24, overflowX: 'auto' }}>
            <Link to="/employer" style={linkStyle('/employer')}>{t('dash_dashboard')}</Link>
            <Link to="/employer/employees" style={linkStyle('/employer/employees')}>{t('dash_employees')}</Link>
            <Link to="/employer/deductions" style={linkStyle('/employer/deductions')}>{t('dash_loans')}</Link>
          </nav>
        </div>
      </header>
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 20px' }}>
        <Outlet />
      </main>
    </div>
  );
}
