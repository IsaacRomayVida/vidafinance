import { Outlet, Link, useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';

export function AdminLayout() {
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-teal-950">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/ops" className="text-xl font-bold text-white">
            VIDA <span className="text-xs font-normal text-teal-400">OPS</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              to="/ops"
              className="text-sm font-medium text-teal-300 hover:text-white"
            >
              Dashboard
            </Link>
            <Link
              to="/ops/employers"
              className="text-sm font-medium text-teal-300 hover:text-white"
            >
              Employers
            </Link>
            <Link
              to="/ops/loans"
              className="text-sm font-medium text-teal-300 hover:text-white"
            >
              Loans
            </Link>
            <button
              onClick={handleSignOut}
              className="text-sm font-medium text-teal-500 hover:text-teal-300"
            >
              Sign out
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
