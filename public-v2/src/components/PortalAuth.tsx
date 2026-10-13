import { Outlet } from 'react-router-dom';
import { AuthProvider } from '../hooks/useAuth';

/**
 * Auth for the role-guarded portals only. App.tsx lazy-loads this as the
 * pathless parent of the employee / employer / ops routes, so Firebase (SDK,
 * auth iframe, App Check) never ships on the marketing pages, which do not
 * read auth state. The provider stays mounted while moving between portals.
 */
export function PortalAuth() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}
