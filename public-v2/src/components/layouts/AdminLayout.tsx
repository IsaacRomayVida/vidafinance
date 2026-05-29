import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';

export function AdminLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  const isActive = (path: string) => location.pathname === path || (path === '/ops/review-queue' && location.pathname.startsWith('/ops/review-queue/'));

  return (
    <div style={{ minHeight: '100vh', background: 'var(--canvas)' }}>
      <header style={{ background: 'var(--t1)' }}>
        <div style={{ maxWidth: 920, margin: '0 auto', padding: '0 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 56 }}>
            <Link to="/ops" style={{ fontFamily: 'var(--df)', fontSize: 24, fontWeight: 400, color: '#fff', textDecoration: 'none', letterSpacing: '-0.02em' }}>
              Funpay <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--gold)', letterSpacing: 3, textTransform: 'uppercase' as const, marginLeft: 6, verticalAlign: 'middle' }}>OPS</span>
            </Link>
            <button
              onClick={handleSignOut}
              style={{ fontSize: 12, fontWeight: 500, color: 'rgba(168,213,208,0.4)', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              Sign out
            </button>
          </div>
          <nav style={{ display: 'flex', gap: 32, borderTop: '1px solid rgba(168,213,208,0.08)', marginTop: -1 }}>
            {[
              { path: '/ops', label: t('admin_tab_dashboard', 'Panel') },
              { path: '/ops/review-queue', label: t('admin_tab_review', 'Revisión') },
              { path: '/ops/employers', label: t('admin_tab_employers', 'Empleadores') },
              { path: '/ops/portfolio', label: t('admin_tab_loans', 'Préstamos') },
              { path: '/ops/health', label: t('admin_tab_health', 'Salud') },
            ].map(({ path, label }) => (
              <Link
                key={path}
                to={path}
                style={{
                  fontSize: 12,
                  fontWeight: isActive(path) ? 700 : 500,
                  color: isActive(path) ? '#fff' : 'rgba(168,213,208,0.4)',
                  textDecoration: 'none',
                  padding: '14px 0',
                  borderBottom: isActive(path) ? '2px solid var(--gold)' : '2px solid transparent',
                  letterSpacing: '0.5px',
                  textTransform: 'uppercase' as const,
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
        <Outlet />
      </main>
    </div>
  );
}
