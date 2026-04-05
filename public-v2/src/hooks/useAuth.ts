import { createElement, createContext, useContext, useState, useEffect } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';

export type UserRole = 'employee' | 'employer_admin' | 'ops' | 'admin' | 'super_admin' | null;

interface AuthState {
  user: User | null;
  role: UserRole;
  loading: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    role: null,
    loading: true,
  });

  useEffect(() => {
    let mounted = true;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!mounted) return;

      if (!user) {
        setState({ user: null, role: null, loading: false });
        return;
      }

      try {
        // 1. Try cached token first
        let tokenResult = await user.getIdTokenResult();
        if (!mounted) return;
        let role = (tokenResult.claims.role as UserRole) ?? null;

        // 2. If no role in cached token, force-refresh to pick up
        //    recently-set custom claims (e.g. admin set role after signup).
        if (!role) {
          tokenResult = await user.getIdTokenResult(true);
          if (!mounted) return;
          role = (tokenResult.claims.role as UserRole) ?? null;
        }

        // 3. Firestore fallback: check employers/{uid} then users/{uid}
        if (!role) {
          try {
            const employerSnap = await getDoc(doc(db, 'employers', user.uid));
            if (!mounted) return;
            if (employerSnap.exists()) {
              role = 'employer_admin';
            } else {
              const userSnap = await getDoc(doc(db, 'users', user.uid));
              if (!mounted) return;
              role = (userSnap.exists() ? (userSnap.data()?.role as UserRole) : null) || 'employee';
            }
          } catch {
            if (!mounted) return;
            // Firestore fallback failed — retry once
            try {
              await new Promise(r => setTimeout(r, 500));
              if (!mounted) return;
              const retrySnap = await getDoc(doc(db, 'employers', user.uid));
              if (!mounted) return;
              if (retrySnap.exists()) {
                role = 'employer_admin';
              } else {
                const retryUserSnap = await getDoc(doc(db, 'users', user.uid));
                if (!mounted) return;
                role = (retryUserSnap.exists() ? (retryUserSnap.data()?.role as UserRole) : null) || 'employee';
              }
            } catch {
              if (!mounted) return;
              role = 'employee';
            }
          }
        }

        if (mounted) setState({ user, role, loading: false });
      } catch {
        // Token resolution failed — treat as unauthenticated so the
        // RouteGuard redirects to /login instead of spinning forever.
        if (mounted) setState({ user: null, role: null, loading: false });
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return createElement(AuthContext.Provider, { value: state }, children);
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
