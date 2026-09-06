/**
 * Turn a thrown callable/auth error into a borrower-facing Spanish message.
 *
 * The server's HttpsError messages are already written for borrowers in
 * Spanish (functions/src/index.ts throws e.g. 'Plazo inválido'), so a
 * functions/* error's own message is shown verbatim. Auth errors arrive as
 * codes and are mapped; anything unrecognized gets the generic retry line —
 * never a raw stack or an English internals string.
 */
const AUTH_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/invalid-email': 'El correo no es válido.',
  'auth/user-disabled': 'Esta cuenta está deshabilitada. Escríbenos a soporte.',
  'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
  'auth/network-request-failed': 'Sin conexión. Revisa tu internet e inténtalo de nuevo.',
};

export const GENERIC_ERROR = 'Algo salió mal. Inténtalo de nuevo en unos minutos.';

export function friendlyError(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (AUTH_MESSAGES[code]) return AUTH_MESSAGES[code];
      // Callable errors: code like 'functions/invalid-argument', message
      // authored server-side for the borrower. 'functions/internal' means the
      // server did NOT author the message — show the generic line instead of
      // an internals string.
      if (code.startsWith('functions/') && code !== 'functions/internal') {
        const message = (err as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim() && !/internal/i.test(message)) {
          return message;
        }
      }
    }
  }
  return GENERIC_ERROR;
}
