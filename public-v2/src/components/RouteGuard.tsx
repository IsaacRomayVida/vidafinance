import { Navigate, Outlet } from 'react-router-dom';
import { useAuth, type UserRole } from '../hooks/useAuth';

interface RouteGuardProps {
  allowedRoles: UserRole[];
}

export function RouteGuard({ allowedRoles }: RouteGuardProps) {
  const { user, role, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-page">
        <div className="spinner" />
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
