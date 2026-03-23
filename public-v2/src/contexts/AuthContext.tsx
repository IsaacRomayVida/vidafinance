import { createContext, useState, useEffect, type ReactNode } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';

export type UserRole = 'employee' | 'employer_admin' | 'ops' | 'admin' | 'super_admin' | null;

export interface AuthState {
  user: User | null;
  role: UserRole;
  loading: boolean;
}

export const AuthContext = createContext<AuthState>({
  user: null,
  role: null,
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    role: null,
    loading: true,
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          const tokenResult = await user.getIdTokenResult();
          let role = (tokenResult.claims.role as UserRole) ?? null;

          if (!role) {
            const employerSnap = await getDoc(doc(db, 'employers', user.uid));
            role = employerSnap.exists() ? 'employer_admin' : 'employee';
          }

          setState({ user, role, loading: false });
        } catch (err) {
          console.error('AuthProvider role resolution failed:', err);
          setState({ user, role: null, loading: false });
        }
      } else {
        setState({ user: null, role: null, loading: false });
      }
    });

    return unsubscribe;
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
