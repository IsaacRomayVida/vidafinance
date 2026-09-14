import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { auth } from '../lib/firebase';

interface AuthState {
  user: User | null;
  /** false until the first onAuthStateChanged fires — render a splash, never
   * the login screen, during that window, or every cold start flashes login
   * at signed-in borrowers. */
  ready: boolean;
  /**
   * true while the onboarding wizard owns the screen. Registration signs the
   * new borrower in mid-wizard; without this hold the auth flip would yank
   * the success screen away before it renders. Root keeps the signed-out
   * stack mounted while the hold is up.
   */
  onboardingHold: boolean;
  setHold: (value: boolean) => void;
  logOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  ready: false,
  onboardingHold: false,
  setHold: () => {},
  logOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [onboardingHold, setHold] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setReady(true);
    });
    return unsubscribe;
  }, []);

  const value = useMemo(
    () => ({ user, ready, onboardingHold, setHold, logOut: () => signOut(auth) }),
    [user, ready, onboardingHold]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function useOnboardingHold(): Pick<AuthState, 'onboardingHold' | 'setHold'> {
  const { onboardingHold, setHold } = useContext(AuthContext);
  return { onboardingHold, setHold };
}
