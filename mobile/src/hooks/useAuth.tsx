import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import React, { createContext, useContext, useEffect, useState } from 'react';

import { auth } from '../lib/firebase';

interface AuthState {
  user: User | null;
  /** false until the first onAuthStateChanged fires — render a splash, never
   * the login screen, during that window, or every cold start flashes login
   * at signed-in borrowers. */
  ready: boolean;
  logOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  ready: false,
  logOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setReady(true);
    });
    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider value={{ user, ready, logOut: () => signOut(auth) }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
