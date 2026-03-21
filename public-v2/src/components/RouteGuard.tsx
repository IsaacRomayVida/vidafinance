import { Navigate, Outlet } from 'react-router-dom';
import { useAuth, type UserRole } from '../hooks/useAuth';

interface RouteGuardProps {
  allowedRoles: UserRole[];
}

export function RouteGuard({ allowedRoles }: RouteGuardProps) {
  const { user, role, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-teal-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gold-500 border-t-transparent" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!allowedRoles.includes(role)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
