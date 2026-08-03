/**
 * Amount-slider geometry for the loan wizard.
 *
 * Lives in `lib/` rather than beside the component because a component module
 * may only export components — exporting a helper from `LoanWizard.tsx` breaks
 * fast refresh and trips `react-refresh/only-export-components`, a CI-blocking
 * lint error. Keeping it here also means it can be unit-tested directly, which
 * is the only reliable way to assert this particular calculation (see below).
 */

/** The smallest loan the product will originate, in MXN. */
export const MIN_AMOUNT = 500;

/**
 * The slider's fill percentage, 0–100.
 *
 * `cappedMax` collapses to `MIN_AMOUNT` when the borrower's available credit
 * is at or below the minimum (the call site clamps with
 * `Math.max(effectiveMax, MIN_AMOUNT)`). The amount range is then a single
 * point rather than a span, so the usual `(amount - MIN) / (max - MIN)` is
 * `0/0 = NaN` — which reached the DOM as `width: "NaN%"`, invalid CSS that
 * browsers silently drop, leaving the bar rendered empty at what is actually
 * 100% of everything the borrower can draw.
 *
 * That single reachable point IS the borrower's full available credit, so the
 * fill reads 100%.
 */
export function sliderFillPercent(amount: number, cappedMax: number): number {
  if (cappedMax <= MIN_AMOUNT) return 100;
  return ((amount - MIN_AMOUNT) / (cappedMax - MIN_AMOUNT)) * 100;
}
