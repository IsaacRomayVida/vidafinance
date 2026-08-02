import * as admin from 'firebase-admin';
import { HttpsError } from 'firebase-functions/v2/https';

export interface AuthContext {
  uid: string;
  email: string;
  role: 'employee' | 'employer_admin' | 'ops' | 'admin' | 'super_admin';
  employerId?: string;
}

/**
 * The single role the historical `admin: true` boolean claim maps to.
 *
 * Between 2026-03-12 (7864c4d) and 2026-03-16 (a23963f) `setAdminClaim` minted
 * bare `{ admin: true }` with no `role` field. Since setCustomUserClaims replaces
 * the whole claims object, any principal granted admin in that window and never
 * re-granted still carries the boolean and no role. No backfill migration exists,
 * so the shim cannot be deleted outright.
 *
 * It maps to `admin` and nothing else. The legacy grant conferred plain admin, so
 * this is the least-privileged mapping that preserves existing access: every
 * admin-gated function today lists 'admin' among its required roles, and no gate
 * is ops-only or super_admin-only. Crucially it is NOT super_admin, so a
 * ['super_admin'] gate is now genuinely stronger than an ['admin'] one.
 */
const LEGACY_ADMIN_ROLE: AuthContext['role'] = 'admin';

/**
 * Collapses a token's claims to exactly one effective role.
 *
 * An explicit `role` claim always wins over the legacy boolean, so a principal
 * demoted to `employee` cannot ride a stale `admin: true` back into admin gates.
 * The returned value is both what the gate is checked against and what is
 * recorded as `actorRole` in the audit log — one value, no divergence between
 * what was authorized and what was written down.
 */
function resolveEffectiveRole(token: Record<string, unknown>): AuthContext['role'] {
  const role = token['role'] as AuthContext['role'] | undefined;
  if (role) {
    return role;
  }
  if (token['admin'] === true) {
    return LEGACY_ADMIN_ROLE;
  }
  return 'employee';
}

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

  // The effective role is resolved BEFORE the check, and the check no longer
  // short-circuits on a missing role. Previously the `role &&` guard meant a token
  // with no role claim skipped the gate entirely and was admitted as 'employee' —
  // a role-less token passed every requiredRoles list.
  const effectiveRole = resolveEffectiveRole(decodedToken as unknown as Record<string, unknown>);

  if (requiredRoles && requiredRoles.length > 0 && !requiredRoles.includes(effectiveRole)) {
    throw new HttpsError('permission-denied', `Role '${effectiveRole}' not authorized`);
  }

  return {
    uid: decodedToken.uid,
    email: decodedToken.email!,
    role: effectiveRole,
    employerId: decodedToken['employerId'] as string | undefined,
  };
}

/**
 * Wraps an onCall handler with role-based auth enforcement.
 * For onCall functions, Firebase populates request.auth automatically;
 * this wrapper enforces that auth exists and the role matches.
 *
 * The legacy `admin: true` boolean is honoured only as a stand-in for a missing
 * `role` claim (see LEGACY_ADMIN_ROLE), after which the ordinary role check runs.
 * It no longer satisfies a gate by virtue of that gate merely mentioning some
 * admin-ish role.
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
    const effectiveRole = resolveEffectiveRole(token);

    if (requiredRoles.length > 0 && !requiredRoles.includes(effectiveRole)) {
      throw new HttpsError(
        'permission-denied',
        `Insufficient permissions. Required: ${requiredRoles.join(' | ')}`
      );
    }

    return handler(request.data as T, {
      uid: request.auth.uid,
      email: token['email'] as string,
      role: effectiveRole,
      employerId: token['employerId'] as string | undefined,
    });
  };
}
