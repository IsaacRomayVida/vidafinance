import * as admin from 'firebase-admin';
import { HttpsError } from 'firebase-functions/v2/https';

export interface AuthContext {
  uid: string;
  email: string;
  role: 'employee' | 'employer_admin' | 'ops' | 'admin' | 'super_admin';
  employerId?: string;
}

const ADMIN_ROLES = ['admin', 'super_admin', 'ops'] as const;

/**
 * Validates a Firebase ID token from an HTTP Authorization header.
 * Checks token revocation. Use this for onRequest (REST) endpoints.
 * Throws HttpsError on failure (maps to 401/403 for the client).
 */
export async function validateAuth(
  request: { headers?: Record<string, string | string[] | undefined> },
  requiredRoles?: string[]
): Promise<AuthContext> {
  const authHeader = (request.headers as Record<string, string | undefined>)?.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    throw new HttpsError('unauthenticated', 'Missing authorization header');
  }

  const token = authHeader.split('Bearer ')[1];

  let decodedToken: admin.auth.DecodedIdToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(token, true); // checkRevoked=true
  } catch (err: unknown) {
    const firebaseErr = err as { code?: string };
    if (firebaseErr.code === 'auth/id-token-revoked') {
      throw new HttpsError('unauthenticated', 'Token revoked');
    }
    throw new HttpsError('unauthenticated', 'Invalid token');
  }

  const role = decodedToken['role'] as string | undefined;

  if (requiredRoles && requiredRoles.length > 0) {
    if (!role || !requiredRoles.includes(role)) {
      throw new HttpsError('permission-denied', 'Insufficient permissions');
    }
  }

  return {
    uid: decodedToken.uid,
    email: decodedToken.email!,
    role: (role ?? 'employee') as AuthContext['role'],
    employerId: decodedToken['employerId'] as string | undefined,
  };
}

/**
 * Wraps an onCall handler with role-based auth enforcement.
 * For onCall functions, Firebase populates request.auth automatically;
 * this wrapper enforces that auth exists and the role matches.
 * Supports legacy token.admin boolean alongside new role-based claims.
 */
export function withAuth<T, R>(
  requiredRoles: string[],
  handler: (data: T, auth: AuthContext) => Promise<R>
) {
  return async (request: {
    auth?: { uid: string; token: Record<string, unknown> };
    data: unknown;
  }): Promise<R> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication required');
    }

    const token = request.auth.token;
    const role = token['role'] as string | undefined;
    const isLegacyAdmin = token['admin'] === true;

    if (requiredRoles.length > 0) {
      const hasRequiredRole =
        (role && requiredRoles.includes(role)) ||
        (isLegacyAdmin && requiredRoles.some((r) => (ADMIN_ROLES as readonly string[]).includes(r)));

      if (!hasRequiredRole) {
        throw new HttpsError(
          'permission-denied',
          `Insufficient permissions. Required: ${requiredRoles.join(' | ')}`
        );
      }
    }

    const resolvedRole: AuthContext['role'] =
      (role as AuthContext['role']) ?? (isLegacyAdmin ? 'admin' : 'employee');

    return handler(request.data as T, {
      uid: request.auth.uid,
      email: token['email'] as string,
      role: resolvedRole,
      employerId: token['employerId'] as string | undefined,
    });
  };
}
