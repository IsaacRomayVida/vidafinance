import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';

export function AdminLayout() {
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
    color: isActive(path) ? '#fff' : 'rgba(168,213,208,0.7)',
    textDecoration: 'none',
    padding: '8px 0',
    borderBottom: isActive(path) ? '2px solid #a8d5d0' : '2px solid transparent',
    transition: 'all 0.2s',
    whiteSpace: 'nowrap' as const,
  });

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9f8' }}>
      <header style={{ background: '#0c1e1f' }}>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '16px 20px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Link to="/ops" style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 22, fontWeight: 400, color: '#fff', textDecoration: 'none' }}>
              VIDA <span style={{ fontSize: 10, fontWeight: 600, color: '#a8d5d0', letterSpacing: 2, textTransform: 'uppercase' as const, marginLeft: 4 }}>OPS</span>
            </Link>
            <button
              onClick={handleSignOut}
              style={{ fontSize: 12, fontWeight: 500, color: 'rgba(168,213,208,0.5)', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              Sign out
            </button>
          </div>
          <nav style={{ display: 'flex', gap: 24, overflowX: 'auto' }}>
            <Link to="/ops" style={linkStyle('/ops')}>Dashboard</Link>
            <Link to="/ops/employers" style={linkStyle('/ops/employers')}>Employers</Link>
            <Link to="/ops/loans" style={linkStyle('/ops/loans')}>Loans</Link>
          </nav>
        </div>
      </header>
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 20px' }}>
        <Outlet />
      </main>
    </div>
  );
}
