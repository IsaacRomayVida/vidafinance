import { useState, useEffect } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';

export type UserRole = 'employee' | 'employer_admin' | 'ops' | 'admin' | 'super_admin' | null;

interface AuthState {
  user: User | null;
  role: UserRole;
  loading: boolean;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    user: null,
    role: null,
    loading: true,
  });

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
            const empSnap = await getDoc(doc(db, 'employers', user.uid));
            if (empSnap.exists()) {
              role = 'employer_admin';
            } else {
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

  return state;
}
