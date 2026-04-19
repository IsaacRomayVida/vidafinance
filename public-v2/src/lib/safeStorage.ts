/**
 * safeStorage.ts — localStorage with try/catch guards.
 * Handles Safari private mode, Firefox resist-fingerprinting, storage quota errors,
 * and any environment where localStorage is disabled or unavailable.
 *
 * Returns null / false on failure instead of throwing.
 */

export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemoveItem(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
