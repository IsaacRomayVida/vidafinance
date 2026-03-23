import { useContext } from 'react';
import { AuthContext, type UserRole, type AuthState } from '../contexts/AuthContext';

export type { UserRole };

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
