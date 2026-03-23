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
        let role = (tokenResult.claims.role as UserRole) ?? null;

        // Fallback: if claims don't have a role yet (e.g. right after
        // signup before the Cloud Function propagates custom claims),
        // check Firestore to determine the role.
        if (!role) {
          const employerSnap = await getDoc(doc(db, 'employers', user.uid));
          role = employerSnap.exists() ? 'employer_admin' : 'employee';
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
