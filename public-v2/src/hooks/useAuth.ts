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
        // 1. Try cached token first
        let tokenResult = await user.getIdTokenResult();
        let role = (tokenResult.claims.role as UserRole) ?? null;

        // 2. If no role in cached token, force-refresh to pick up
        //    recently-set custom claims (e.g. admin set role after signup).
        if (!role) {
          tokenResult = await user.getIdTokenResult(true);
          role = (tokenResult.claims.role as UserRole) ?? null;
        }

        // 3. Firestore fallback: check employers/{uid} then users/{uid}
        if (!role) {
          try {
            const employerSnap = await getDoc(doc(db, 'employers', user.uid));
            if (employerSnap.exists()) {
              role = 'employer_admin';
            } else {
              // Check users collection for role set by admin
              const userSnap = await getDoc(doc(db, 'users', user.uid));
              role = (userSnap.exists() ? (userSnap.data()?.role as UserRole) : null) || 'employee';
            }
          } catch (err) {
            console.warn('[useAuth] Firestore fallback failed, retrying...', err);
            try {
              await new Promise(r => setTimeout(r, 500));
              const retrySnap = await getDoc(doc(db, 'employers', user.uid));
              if (retrySnap.exists()) {
                role = 'employer_admin';
              } else {
                const retryUserSnap = await getDoc(doc(db, 'users', user.uid));
                role = (retryUserSnap.exists() ? (retryUserSnap.data()?.role as UserRole) : null) || 'employee';
              }
            } catch (retryErr) {
              console.error('[useAuth] Firestore fallback retry failed', retryErr);
              role = 'employee';
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
