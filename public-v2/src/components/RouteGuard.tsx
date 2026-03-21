import { Navigate, Outlet } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import type { UserRole } from '../hooks/useAuth';

interface RouteGuardProps {
  allowedRoles: UserRole[];
}

export function RouteGuard({ allowedRoles }: RouteGuardProps) {
  const [state, setState] = useState<{
    user: User | null;
    role: UserRole;
    loading: boolean;
  }>({ user: null, role: null, loading: true });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const tokenResult = await user.getIdTokenResult();
        const claims = tokenResult.claims;
        let role = (claims.role as UserRole) ?? null;

        // If no custom claim role, check Firestore to determine role
        if (!role) {
          if (claims.admin) {
            role = 'admin';
          } else {
            // Check if user is an employer
            const empSnap = await getDoc(doc(db, 'employers', user.uid));
            if (empSnap.exists()) {
              role = 'employer_admin';
            } else {
              // Check if user is an employee
              const eeSnap = await getDoc(doc(db, 'employees', user.uid));
              if (eeSnap.exists()) {
                role = 'employee';
              }
            }
          }
        }
        setState({ user, role, loading: false });
      } else {
        setState({ user: null, role: null, loading: false });
      }
    });
    return unsubscribe;
  }, []);

  if (state.loading) {
    return (
      <div className="loading-page">
        <div className="spinner" />
      </div>
    );
  }

  if (!state.user) {
    return <Navigate to="/login" replace />;
  }

  if (!allowedRoles.includes(state.role)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
