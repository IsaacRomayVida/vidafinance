/**
 * Stage 3 auto-approve conditions — bucketing, threshold proximity, hints.
 *
 * `getReviewDetail` (#583) returns the full 12-row Stage 3 breakdown. This
 * module decides which of the four groups each row belongs to, and nothing
 * about how it looks; the panel imports the answer rather than re-deriving it.
 *
 * The whole reason it is a module and not a `.filter()` in the component is
 * `classifyCondition`. Two properties have to hold together and neither is
 * visible from a call site:
 *
 *   1. A row that is not provably `true` and not provably unevaluated FAILS.
 *      In particular `pass: null` + `source: 'assumed'` is a failure, not a
 *      gap — see the comment on `classifyCondition`.
 *   2. The `required`-string parser can never move a row between groups. It
 *      annotates; it does not classify. A malformed bound must cost a hint,
 *      never a bucket.
 *
 * Backend source of truth — `UnderwritingConditionRow` in functions/src/index.ts,
 * written by services/underwriting-service/src/stages/stage3-autoapprove.js.
 */

/** Provenance of the value the gate tested. See functions/src/admin/underwritingProvenance. */
export type ConditionSource = 'read' | 'assumed' | 'unknown';

/**
 * One row of the auto-approve gate, exactly as the callable returns it.
 *
 * `source` is `string`, not `ConditionSource`, on purpose: it is widened at the
 * wire boundary, and `classifyCondition` treats an unrecognized value the same
 * way it treats `'assumed'` — as not-unevaluated, therefore failing.
 */
export interface UnderwritingConditionRow {
  id: number | null;
  name: string | null;
  pass: boolean | null;
  value: unknown;
  required: string | null;
  source: string;
}

/** `loans/{loanId}/underwritingDetail/detail`, as projected by the callable. */
export interface UnderwritingDetail {
  decision: string | null;
  reason: string | null;
  allPass: boolean | null;
  conditions: UnderwritingConditionRow[];
  evaluatedAt: unknown;
}

/**
 * Where a row lands. `'passed'` covers near-threshold rows too — proximity is a
 * sub-split of passing, applied after this, and deliberately not a fourth value
 * here so that no caller can produce a bucket the parser had a vote in.
 */
export type ConditionOutcome = 'failed' | 'unevaluated' | 'passed';

/**
 * The group a row belongs to, from `pass` and `source` alone.
 *
 * The case that matters, and the reason this function is tested by name:
 * `pass: null` + `source: 'assumed'` is **failed**, not unevaluated. An assumed
 * value is one the model never produced — the gate substituted a default and
 * carried on. Filing that under "sin evaluar" tells a reviewer a check is
 * merely missing, when what actually happened is that a loan was measured
 * against a number nobody read. Un valor no leído no puede aprobar.
 *
 * So the default direction is failure: only `pass === true` passes, and only an
 * explicitly `unknown` source earns the softer "sin evaluar" reading. Anything
 * else — `pass: false`, `pass: null` from a `read` or `assumed` source, a
 * source string this build has never heard of — fails closed.
 */
export function classifyCondition(row: UnderwritingConditionRow): ConditionOutcome {
  if (row.pass === true) return 'passed';
  if (row.pass === null && row.source === 'unknown') return 'unevaluated';
  return 'failed';
}

/* ── the `required` parser ─────────────────────────────────────────────────
 *
 * Everything below is annotation. It runs on rows that are already bucketed and
 * it is allowed to fail: `null` out of any of it means the row renders plain.
 */

/**
 * The dimensions a delta can be stated in.
 *
 * Deliberately short. A unit that is not on this list makes the row
 * unparseable rather than producing a hint in units nobody chose — "0 activos"
 * against "0" is a comparison the reviewer can read unaided, and phrasing it as
 * "0 puntos sobre el límite" would be worse than silence.
 */
type BoundUnit = 'plain' | 'percent' | 'months';

interface Bound {
  amount: number;
  unit: BoundUnit;
}

interface Quantity {
  amount: number;
  unit: BoundUnit;
}

/** How far a value sits from its bound, once both sides parse in the same unit. */
export interface ConditionMargin {
  /** Absolute gap, in the shared unit. */
  distance: number;
  /** True when the value sits above the bound. */
  overBound: boolean;
  unit: BoundUnit;
  /** `distance / |bound|` — what the near-threshold test measures. `Infinity` at a zero bound. */
  relative: number;
}

/** Passing rows within this much of their bound are "cerca del límite". */
const NEAR_THRESHOLD_RATIO = 0.1;

/**
 * Anchored on purpose, here and in `parseQuantity`.
 *
 * An unanchored match would read "18-65" as `18` and call an age range a lower
 * bound, which is how a parser starts deciding buckets. Trailing text means
 * unparseable, which means plain.
 */
const BOUND_PATTERN = /^\s*(?:>=|<=|≥|≤|>|<)\s*(-?\d+(?:[.,]\d+)?)\s*(%|meses|mes)?\s*$/i;
const QUANTITY_PATTERN = /^\s*(-?\d+(?:[.,]\d+)?)\s*(%|meses|mes)?\s*$/i;

function unitOf(suffix: string | undefined): BoundUnit {
  if (!suffix) return 'plain';
  return suffix === '%' ? 'percent' : 'months';
}

function toAmount(digits: string): number | null {
  const parsed = Number(digits.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** `"> 600"`, `"≤ 25%"`, `"> 6 meses"`. Ranges, prose and bare numbers yield null. */
function parseBound(required: string | null): Bound | null {
  if (typeof required !== 'string') return null;
  const match = BOUND_PATTERN.exec(required);
  if (!match) return null;
  const amount = toAmount(match[1]);
  return amount === null ? null : { amount, unit: unitOf(match[2]) };
}

/** `580`, `"31%"`, `"7 meses"`. Booleans, prose and `"0 activos"` yield null. */
function parseQuantity(value: unknown): Quantity | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { amount: value, unit: 'plain' } : null;
  }
  if (typeof value !== 'string') return null;
  const match = QUANTITY_PATTERN.exec(value);
  if (!match) return null;
  const amount = toAmount(match[1]);
  return amount === null ? null : { amount, unit: unitOf(match[2]) };
}

/**
 * The gap between a row's value and its bound, or null if it cannot be stated.
 *
 * Null whenever either side fails to parse OR the two sides are in different
 * units — comparing `31%` to `> 6 meses` produces a number, and a number here
 * would be read as evidence. Both sides must agree on what is being measured.
 */
export function conditionMargin(row: UnderwritingConditionRow): ConditionMargin | null {
  const bound = parseBound(row.required);
  const value = parseQuantity(row.value);
  if (!bound || !value || bound.unit !== value.unit) return null;

  const distance = Math.abs(value.amount - bound.amount);
  return {
    distance,
    overBound: value.amount > bound.amount,
    unit: bound.unit,
    relative: bound.amount === 0 ? Infinity : distance / Math.abs(bound.amount),
  };
}

/**
 * Whether a row passed, but only just.
 *
 * Gated on `classifyCondition` rather than on `row.pass` so that the near test
 * can never be reached for a row that is not already in the passing group —
 * "cerca del límite" is a caveat on an approval, and putting a failed row there
 * would soften exactly what the panel exists to show.
 */
export function isNearThreshold(row: UnderwritingConditionRow): boolean {
  if (classifyCondition(row) !== 'passed') return false;
  const margin = conditionMargin(row);
  return margin !== null && margin.relative <= NEAR_THRESHOLD_RATIO;
}

function pluralize(amount: number, unit: BoundUnit): string {
  const one = Math.abs(amount) === 1;
  if (unit === 'percent') return one ? 'punto porcentual' : 'puntos porcentuales';
  if (unit === 'months') return one ? 'mes' : 'meses';
  return one ? 'punto' : 'puntos';
}

/** Trims the float noise a subtraction leaves behind: 0.15 - 0.08 is not 0.07. */
function formatAmount(amount: number): string {
  return String(Number(amount.toFixed(4)));
}

/**
 * `"20 puntos bajo el límite"` — how far off the bound this row is.
 *
 * Null when the row does not parse, which is the same silence a row with a
 * prose bound gets. The hint never carries the reason a row failed, only the
 * distance; the bound itself is rendered verbatim beside it.
 */
export function conditionHint(row: UnderwritingConditionRow): string | null {
  const margin = conditionMargin(row);
  if (!margin || margin.distance === 0) return null;
  const direction = margin.overBound ? 'sobre' : 'bajo';
  return `${formatAmount(margin.distance)} ${pluralize(margin.distance, margin.unit)} ${direction} el límite`;
}

/* ── grouping ──────────────────────────────────────────────────────────────── */

export interface ConditionBuckets {
  /** NO CUMPLEN. Includes every row that is not provably passing or unevaluated. */
  failed: UnderwritingConditionRow[];
  /** CERCA DEL LÍMITE — passing, within `NEAR_THRESHOLD_RATIO` of the bound. */
  near: UnderwritingConditionRow[];
  /** SIN EVALUAR. */
  unevaluated: UnderwritingConditionRow[];
  /** Passing and not near: the rows that collapse. */
  met: UnderwritingConditionRow[];
  /** Every passing row, near ones included. */
  passed: UnderwritingConditionRow[];
  /** Derived from the array — the panel must never state a literal 12. */
  total: number;
  /** Nothing failed and nothing went unevaluated. Drives the all-pass view. */
  allPass: boolean;
}

/**
 * Split the rows into the groups the panel renders.
 *
 * Takes the whole `underwritingDetail` (or null) rather than the array so the
 * empty state has one shape: a loan that never reached Stage 3 and a loan whose
 * detail document holds no rows both arrive here as zero conditions, and both
 * are legitimate — never an error.
 *
 * `allPass` is recomputed rather than read from `detail.allPass`. The stored
 * flag is the gate's own verdict on its own run; this panel exists because that
 * verdict has been wrong about rows it never read.
 */
export function bucketConditions(detail: UnderwritingDetail | null): ConditionBuckets {
  const conditions = Array.isArray(detail?.conditions) ? detail.conditions : [];

  const failed: UnderwritingConditionRow[] = [];
  const near: UnderwritingConditionRow[] = [];
  const unevaluated: UnderwritingConditionRow[] = [];
  const met: UnderwritingConditionRow[] = [];
  const passed: UnderwritingConditionRow[] = [];

  for (const row of conditions) {
    switch (classifyCondition(row)) {
      case 'failed':
        failed.push(row);
        break;
      case 'unevaluated':
        unevaluated.push(row);
        break;
      case 'passed':
        passed.push(row);
        (isNearThreshold(row) ? near : met).push(row);
        break;
    }
  }

  return {
    failed,
    near,
    unevaluated,
    met,
    passed,
    total: conditions.length,
    allPass: conditions.length > 0 && failed.length === 0 && unevaluated.length === 0,
  };
}

/* ── row display ───────────────────────────────────────────────────────────── */

/**
 * The value as the reviewer should read it.
 *
 * A missing value is `—` and never `0`, `false` or blank: those are findings.
 * A real `false` still renders "No", because the gate genuinely tested it —
 * that is the difference between "cartera vencida: no" and "nobody looked".
 */
export function formatConditionValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (typeof value === 'string') return value.trim() || '—';
  return '—';
}

/** Whether the row carries a value at all — decides `✕` against `–`. */
export function hasReadableValue(row: UnderwritingConditionRow): boolean {
  return formatConditionValue(row.value) !== '—';
}

/**
 * The provenance badge, or null.
 *
 * `read` is ~11 of 12 rows; badging it would put a label on every row and leave
 * the reviewer to notice which one is missing. Only the two provenances that
 * mean "this number is not a measurement" get a badge.
 */
export function sourceBadge(row: UnderwritingConditionRow): string | null {
  if (row.source === 'assumed') return 'asumido';
  if (row.source === 'unknown') return 'desconocido';
  return null;
}
