/**
 * money.ts — integer centavos in, display string out (and back).
 *
 * Money crosses the callable boundary as integer centavos. Nothing here goes
 * through a float on the way in: `parsePesosToCents` works on the digits the
 * user typed, so 1234.56 is 123456 centavos and never 123455.99999.
 */

/** `123456` → `1,234.56` (es-MX grouping, always two decimals, no symbol). */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * A typed peso amount → integer centavos, or null if it is not an amount.
 * Accepts `1234`, `1234.5`, `1234.56`, `1,234.56` and a leading `$`. Rejects
 * anything else — three decimals, a decimal comma, a sign, stray text —
 * rather than guessing what was meant.
 */
export function parsePesosToCents(raw: string): number | null {
  const s = raw.trim().replace(/^\$\s*/, '');
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/.test(s)) return null;
  const [whole, fraction = ''] = s.replace(/,/g, '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
