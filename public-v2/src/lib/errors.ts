/**
 * errors.ts — normalize unknown errors into user-facing Spanish/English
 * strings. Used wherever we surface errors to the UI so rate limits,
 * expired sessions, and network hiccups get a human-readable message
 * instead of a raw Firebase stack.
 *
 * Design:
 *   - Pure function. No React. No hooks. Safe to call from effects,
 *     event handlers, or the Sentry beforeSend hook.
 *   - Leans on i18next's singleton so the translated string matches
 *     the user's active language without threading `t` through props.
 *   - Recognises Firebase callable HttpsError shapes
 *     (`FirebaseError` with codes like `functions/resource-exhausted`
 *     or plain `{ code: 'resource-exhausted' }`) as well as the
 *     native `fetch` TypeError thrown on network failure.
 */
import i18n from '../i18n';

export type FriendlyErrorCode =
  | 'rate_limit'
  | 'unavailable'
  | 'unauthenticated'
  | 'permission_denied'
  | 'timeout'
  | 'network'
  | 'generic';

const CODE_TO_I18N: Record<FriendlyErrorCode, string> = {
  rate_limit: 'err_rate_limit',
  unavailable: 'err_unavailable',
  unauthenticated: 'err_unauthenticated',
  permission_denied: 'err_permission_denied',
  timeout: 'err_timeout',
  network: 'err_network',
  generic: 'err_generic',
};

/**
 * Classify an unknown error into a stable code the UI can act on.
 * Callers can use this when they want to branch on the category
 * (e.g. show a "wait a minute" countdown only on rate_limit).
 */
export function classifyError(err: unknown): FriendlyErrorCode {
  if (!err) return 'generic';

  const code = readCode(err);
  const message = readMessage(err);

  // Firebase callable functions — these are the most common path.
  // `HttpsError` surfaces as FirebaseError with prefixed codes like
  // `functions/resource-exhausted` on the client.
  if (code) {
    if (code.includes('resource-exhausted')) return 'rate_limit';
    if (code.includes('unavailable')) return 'unavailable';
    if (code.includes('unauthenticated')) return 'unauthenticated';
    if (code.includes('permission-denied')) return 'permission_denied';
    if (code.includes('deadline-exceeded')) return 'timeout';
  }

  // Plain fetch / network path — TypeError('Failed to fetch') is the
  // browser's universal "can't reach the server" signal.
  if (err instanceof TypeError && /fetch|network/i.test(message)) {
    return 'network';
  }

  // Best-effort message sniffing for rate-limit style messages bubbled
  // up without a proper code (e.g. from Railway microservice adapters).
  if (/rate.?limit|too many requests|429/i.test(message)) {
    return 'rate_limit';
  }

  return 'generic';
}

/**
 * Convert any thrown value into a localized user-facing message.
 * Never returns an empty string.
 */
export function friendlyError(err: unknown): string {
  const code = classifyError(err);
  return i18n.t(CODE_TO_I18N[code]);
}

function readCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const maybeCode = (err as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : null;
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}
