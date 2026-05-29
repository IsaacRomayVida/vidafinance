import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { PageTransition } from '../ui/PageTransition';
import { useTranslation } from 'react-i18next';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';
import { safeSetItem } from '../../lib/safeStorage';

export function EmployeeLayout() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  const isActive = (path: string) => location.pathname === path;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg2, var(--bg2))' }}>
      <header style={{ background: '#fff', borderBottom: '1px solid rgba(25,68,69,0.04)' }}>
        <div style={{ maxWidth: 920, margin: '0 auto', padding: '0 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 56 }}>
            <Link to="/employee" style={{ fontFamily: 'var(--db)', fontSize: 14, fontWeight: 700, color: 'var(--brand)', textDecoration: 'none', letterSpacing: '6px', textTransform: 'uppercase' as const }}>
              Funpay
            </Link>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <button
                aria-label={t('a11y_lang_toggle')}
                onClick={() => { const next = i18n.language === 'es' ? 'en' : 'es'; i18n.changeLanguage(next); safeSetItem('vida_lang', next); }}
                style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', background: 'none', border: '1px solid rgba(25,68,69,0.08)', borderRadius: 20, padding: '5px 14px', cursor: 'pointer', letterSpacing: '0.5px' }}
              >
                {i18n.language === 'es' ? 'EN' : 'ES'}
              </button>
              <button
                onClick={handleSignOut}
                style={{ fontSize: 12, fontWeight: 500, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {t('dash_signout')}
              </button>
            </div>
          </div>
          <nav style={{ display: 'flex', gap: 32, borderTop: '1px solid rgba(25,68,69,0.04)', marginTop: -1 }}>
            {[
              { path: '/employee', label: t('dash_dashboard') },
              { path: '/employee/loans', label: t('dash_my_loans') },
            ].map(({ path, label }) => (
              <Link
                key={path}
                to={path}
                style={{
                  fontSize: 12,
                  fontWeight: isActive(path) ? 700 : 500,
                  color: isActive(path) ? 'var(--brand)' : 'var(--t3)',
                  textDecoration: 'none',
                  padding: '14px 0',
                  borderBottom: isActive(path) ? '2px solid var(--gold)' : '2px solid transparent',
                  letterSpacing: '0.5px',
                  textTransform: 'uppercase',
                  transition: 'all 0.2s',
                }}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main style={{ maxWidth: 920, margin: '0 auto', padding: '36px 24px 60px' }}>
        <PageTransition><Outlet /></PageTransition>
      </main>
    </div>
  );
}
