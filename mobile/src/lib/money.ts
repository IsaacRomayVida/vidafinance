/**
 * Money display for MXN amounts. Server amounts are whole pesos (the loan
 * product originates 500–5,000 MXN in 100-peso steps), so display rounds to
 * whole pesos; nothing here is ever used for computation the server relies
 * on — pricing truth is server-side (ADR-002: feeRate frozen at creation).
 */
export function formatMxn(amount: unknown): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  return `$${Math.round(amount).toLocaleString('es-MX')}`;
}

/**
 * The client-side preview of a quote: amount * (1 + feeRate), rounded to
 * whole pesos the same way functions/src/index.ts rounds it. Preview only —
 * the number the borrower owes is the one requestLoan returns and freezes.
 */
export function previewTotal(amount: number, feeRate: number): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!Number.isFinite(feeRate) || feeRate < 0) return null;
  return Math.round(amount * (1 + feeRate));
}

/** Firestore timestamp ({seconds}) → localized date, '—' when absent. */
export function formatDate(ts?: { seconds: number } | null): string {
  if (!ts || typeof ts.seconds !== 'number') return '—';
  return new Date(ts.seconds * 1000).toLocaleDateString('es-MX');
}
