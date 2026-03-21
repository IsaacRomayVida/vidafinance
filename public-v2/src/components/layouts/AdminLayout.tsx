import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';
import { VidaLogo } from '../shared/VidaLogo';

export function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  const navItems = [
    { path: '/ops', label: 'Dashboard', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
    { path: '/ops/review-queue', label: 'Reviews', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
    { path: '/ops/employers', label: 'Employers', icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16M3 21h18M9 7h1M9 11h1M14 7h1M14 11h1' },
    { path: '/ops/alerts', label: 'Alerts', icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9' },
  ];

  return (
    <div className="dash">
      <aside className="dash-side" style={{ background: 'var(--brand)', borderRight: 'none' }}>
        <Link to="/" className="nav-logo" style={{ marginBottom: 48 }}>
          <VidaLogo variant="footer" />
        </Link>
        <nav className="dash-nav">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={location.pathname === item.path ? 'active' : ''}
              style={{
                color: location.pathname === item.path ? '#fff' : 'rgba(255,255,255,0.5)',
                fontWeight: location.pathname === item.path ? 600 : 500,
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 18, height: 18, opacity: location.pathname === item.path ? 0.9 : 0.4 }}>
                <path d={item.icon} />
              </svg>
              {item.label}
            </Link>
          ))}
        </nav>
        <button
          className="dash-logout"
          onClick={handleSignOut}
          style={{ color: 'rgba(255,255,255,0.4)' }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 18, height: 18, opacity: 0.4 }}>
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
          Sign out
        </button>
      </aside>
      <main className="dash-main">
        <Outlet />
      </main>
    </div>
  );
}
