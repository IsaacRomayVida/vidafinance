/**
 * E5c — the Stage 3 conditions panel is a bucketing rule with a screen attached.
 *
 * The assertions that matter are the ones about where a row lands, not about
 * how it reads. A row in the wrong group is a reviewer told the wrong thing
 * about a loan, and the two ways that happens are both covered here: an assumed
 * value filed as a benign gap, and a malformed bound dragging a row out of its
 * group on the way past.
 */
import { describe, expect, it } from 'vitest';

import {
  bucketConditions,
  classifyCondition,
  conditionHint,
  conditionMargin,
  formatConditionValue,
  hasReadableValue,
  isNearThreshold,
  sourceBadge,
  type UnderwritingConditionRow,
  type UnderwritingDetail,
} from './underwritingConditions';

/** A row with everything specified, so each test states only what it is about. */
function row(overrides: Partial<UnderwritingConditionRow> = {}): UnderwritingConditionRow {
  return {
    id: 1,
    name: 'Score de buró',
    pass: true,
    value: 650,
    required: '> 600',
    source: 'read',
    ...overrides,
  };
}

function detail(conditions: UnderwritingConditionRow[]): UnderwritingDetail {
  return {
    decision: 'manual_review',
    reason: null,
    allPass: false,
    conditions,
    evaluatedAt: null,
  };
}

describe('classifyCondition', () => {
  it('puts an explicitly failed condition in NO CUMPLEN', () => {
    expect(classifyCondition(row({ pass: false, value: 580 }))).toBe('failed');
  });

  // The regression this whole delta exists to prevent.
  it('puts pass:null + source:assumed in NO CUMPLEN, NOT sin evaluar', () => {
    // The ML block never ran: the gate substituted a default probability and
    // carried on. Filing this under "sin evaluar" would show a reviewer a
    // benign-looking gap where a loan was actually measured against a number
    // nobody read — un valor no leído no puede aprobar.
    const assumed = row({
      id: 12,
      name: 'Probabilidad de incumplimiento (ML)',
      pass: null,
      value: null,
      required: '< 0.15',
      source: 'assumed',
    });

    expect(classifyCondition(assumed)).toBe('failed');
    expect(classifyCondition(assumed)).not.toBe('unevaluated');

    // And it has to survive the trip through the grouping, not just the predicate.
    const buckets = bucketConditions(detail([assumed]));
    expect(buckets.failed).toEqual([assumed]);
    expect(buckets.unevaluated).toEqual([]);
  });

  it('puts pass:null + source:unknown in SIN EVALUAR', () => {
    expect(classifyCondition(row({ pass: null, value: null, source: 'unknown' }))).toBe(
      'unevaluated'
    );
  });

  it('puts a passing condition in cumplidas', () => {
    expect(classifyCondition(row({ pass: true }))).toBe('passed');
  });

  it('fails closed on pass:null from a read source', () => {
    // `read` provenance with no verdict is still no verdict.
    expect(classifyCondition(row({ pass: null, source: 'read' }))).toBe('failed');
  });

  it('fails closed on a source string this build does not recognize', () => {
    // Only `unknown` earns the softer reading; a new provenance added upstream
    // must not arrive here as "sin evaluar" by default.
    expect(classifyCondition(row({ pass: null, source: 'inferred' }))).toBe('failed');
  });

  it('passes a row whose value was assumed but whose verdict is true', () => {
    // Provenance colours the row (badge), it does not overturn an explicit pass.
    expect(classifyCondition(row({ pass: true, source: 'assumed' }))).toBe('passed');
  });
});

describe('bucketConditions', () => {
  it('treats a null underwritingDetail as an empty panel, never an error', () => {
    const buckets = bucketConditions(null);
    expect(buckets.total).toBe(0);
    expect(buckets.failed).toEqual([]);
    expect(buckets.near).toEqual([]);
    expect(buckets.unevaluated).toEqual([]);
    expect(buckets.met).toEqual([]);
    // Not an all-pass loan: nothing was evaluated at all.
    expect(buckets.allPass).toBe(false);
  });

  it('survives a detail document whose conditions array is missing', () => {
    const malformed = { conditions: undefined } as unknown as UnderwritingDetail;
    expect(bucketConditions(malformed).total).toBe(0);
  });

  it('derives the total from the array rather than assuming 12', () => {
    // The gate wrote 10 rows before #583. A panel that says "de 12" on a
    // 10-row document is stating a count it did not read.
    expect(bucketConditions(detail([row(), row(), row()])).total).toBe(3);
  });

  it('reports allPass only when nothing failed and nothing went unevaluated', () => {
    expect(bucketConditions(detail([row(), row()])).allPass).toBe(true);
    expect(bucketConditions(detail([row(), row({ pass: false })])).allPass).toBe(false);
    expect(
      bucketConditions(detail([row(), row({ pass: null, source: 'unknown' })])).allPass
    ).toBe(false);
  });

  it('counts a near-threshold row as passing as well as near', () => {
    // `near` is a caveat on an approval, not a fourth outcome: the row is in
    // both lists, and `met` is what collapses.
    const near = row({ pass: true, value: 63, required: '> 60' });
    const buckets = bucketConditions(detail([near]));
    expect(buckets.near).toEqual([near]);
    expect(buckets.passed).toEqual([near]);
    expect(buckets.met).toEqual([]);
    expect(buckets.allPass).toBe(true);
  });

  it('splits a mixed loan into four groups that add up to the total', () => {
    const conditions = [
      row({ id: 1, pass: false, value: 580, required: '> 600' }),
      row({ id: 2, pass: null, value: null, required: '< 0.15', source: 'assumed' }),
      row({ id: 3, pass: null, value: null, source: 'unknown' }),
      row({ id: 4, pass: true, value: 63, required: '> 60' }),
      row({ id: 5, pass: true, value: 900, required: '> 600' }),
    ];
    const buckets = bucketConditions(detail(conditions));

    expect(buckets.failed.map((r) => r.id)).toEqual([1, 2]);
    expect(buckets.unevaluated.map((r) => r.id)).toEqual([3]);
    expect(buckets.near.map((r) => r.id)).toEqual([4]);
    expect(buckets.met.map((r) => r.id)).toEqual([5]);
    expect(buckets.failed.length + buckets.unevaluated.length + buckets.passed.length).toBe(
      buckets.total
    );
  });
});

describe('the required parser never decides a bucket', () => {
  it('leaves a failed row failed when its bound is unparseable', () => {
    // "18-65" is a range: an unanchored parser would read it as `18` and
    // invent a lower bound. Unparseable must cost the hint, not the group.
    const unparseable = row({ pass: false, value: 17, required: '18-65' });
    expect(classifyCondition(unparseable)).toBe('failed');
    expect(conditionMargin(unparseable)).toBeNull();
    expect(conditionHint(unparseable)).toBeNull();
    expect(bucketConditions(detail([unparseable])).failed).toEqual([unparseable]);
  });

  it('leaves a passing row passing, and merely un-tagged, when its bound is prose', () => {
    const prose = row({ pass: true, value: 'bajo', required: 'no alto' });
    expect(classifyCondition(prose)).toBe('passed');
    expect(isNearThreshold(prose)).toBe(false);
    expect(conditionHint(prose)).toBeNull();
    const buckets = bucketConditions(detail([prose]));
    expect(buckets.met).toEqual([prose]);
    expect(buckets.near).toEqual([]);
  });

  it('never marks a failed row as near the threshold', () => {
    // A failed row one point off its bound is still a failure. "Cerca del
    // límite" is a caveat on an approval and reads as one.
    expect(isNearThreshold(row({ pass: false, value: 599, required: '> 600' }))).toBe(false);
  });

  it('never marks an unevaluated row as near the threshold', () => {
    expect(
      isNearThreshold(row({ pass: null, value: 599, required: '> 600', source: 'unknown' }))
    ).toBe(false);
  });
});

describe('conditionMargin', () => {
  it('measures a plain numeric bound', () => {
    expect(conditionMargin(row({ value: 580, required: '> 600' }))).toEqual({
      distance: 20,
      overBound: false,
      unit: 'plain',
      relative: 20 / 600,
    });
  });

  it('measures a percentage against a percentage bound', () => {
    const margin = conditionMargin(row({ value: '31%', required: '≤ 25%' }));
    expect(margin?.distance).toBe(6);
    expect(margin?.unit).toBe('percent');
    expect(margin?.overBound).toBe(true);
  });

  it('measures months against a months bound', () => {
    const margin = conditionMargin(row({ value: '7 meses', required: '> 6 meses' }));
    expect(margin?.distance).toBe(1);
    expect(margin?.unit).toBe('months');
  });

  it('refuses to compare a percentage to a bare number', () => {
    // Same digits, different questions. A number here would be read as evidence.
    expect(conditionMargin(row({ value: '31%', required: '> 25' }))).toBeNull();
  });

  it('refuses to compare months to a percentage', () => {
    expect(conditionMargin(row({ value: '7 meses', required: '≤ 25%' }))).toBeNull();
  });

  it('returns null for a value that is not a quantity', () => {
    expect(conditionMargin(row({ value: true, required: '> 600' }))).toBeNull();
    expect(conditionMargin(row({ value: null, required: '< 0.15' }))).toBeNull();
    expect(conditionMargin(row({ value: '0 activos', required: '> 0' }))).toBeNull();
  });

  it('returns null for a bound with no comparator', () => {
    expect(conditionMargin(row({ value: 0, required: '0' }))).toBeNull();
    expect(conditionMargin(row({ value: 0, required: null }))).toBeNull();
  });

  it('does not divide by a zero bound', () => {
    const margin = conditionMargin(row({ value: 3, required: '> 0' }));
    expect(margin?.distance).toBe(3);
    expect(margin?.relative).toBe(Infinity);
    expect(isNearThreshold(row({ pass: true, value: 3, required: '> 0' }))).toBe(false);
  });
});

describe('isNearThreshold', () => {
  it('tags a passing row within 10% of its bound', () => {
    // 63 against > 60 — 5% clear.
    expect(isNearThreshold(row({ pass: true, value: 63, required: '> 60' }))).toBe(true);
  });

  it('leaves a comfortable pass untagged', () => {
    // 0.08 against < 0.15 — 47% clear.
    expect(isNearThreshold(row({ pass: true, value: 0.08, required: '< 0.15' }))).toBe(false);
  });

  it('includes the boundary itself', () => {
    // Exactly 10%: 66 against > 60.
    expect(isNearThreshold(row({ pass: true, value: 66, required: '> 60' }))).toBe(true);
    expect(isNearThreshold(row({ pass: true, value: 66.6, required: '> 60' }))).toBe(false);
  });
});

describe('conditionHint', () => {
  it('states the distance below a bound', () => {
    expect(conditionHint(row({ pass: false, value: 580, required: '> 600' }))).toBe(
      '20 puntos bajo el límite'
    );
  });

  it('states percentages in percentage points', () => {
    expect(conditionHint(row({ pass: false, value: '31%', required: '≤ 25%' }))).toBe(
      '6 puntos porcentuales sobre el límite'
    );
  });

  it('singularizes a one-month gap', () => {
    expect(conditionHint(row({ value: '7 meses', required: '> 6 meses' }))).toBe(
      '1 mes sobre el límite'
    );
  });

  it('singularizes a one-point gap', () => {
    expect(conditionHint(row({ value: 601, required: '> 600' }))).toBe('1 punto sobre el límite');
    expect(conditionHint(row({ value: '26%', required: '≤ 25%' }))).toBe(
      '1 punto porcentual sobre el límite'
    );
  });

  it('does not leave float noise in the number', () => {
    // 0.15 - 0.08 is 0.06999999999999999 in binary floating point.
    expect(conditionHint(row({ value: 0.08, required: '< 0.15' }))).toBe(
      '0.07 puntos bajo el límite'
    );
  });

  it('says nothing when the value sits exactly on the bound', () => {
    expect(conditionHint(row({ value: 600, required: '> 600' }))).toBeNull();
  });

  it('says nothing when the unit is not derivable', () => {
    expect(conditionHint(row({ value: '0 activos', required: '> 0' }))).toBeNull();
  });
});

describe('row display', () => {
  it('renders a missing value as an em dash, never as 0 or false', () => {
    expect(formatConditionValue(null)).toBe('—');
    expect(formatConditionValue(undefined)).toBe('—');
    expect(formatConditionValue('')).toBe('—');
    expect(formatConditionValue('   ')).toBe('—');
    expect(formatConditionValue(NaN)).toBe('—');
  });

  it('renders a real zero and a real false, because the gate did test them', () => {
    // "cartera vencida: no" is a finding. "nobody looked" is a different one.
    expect(formatConditionValue(0)).toBe('0');
    expect(formatConditionValue(false)).toBe('No');
    expect(formatConditionValue(true)).toBe('Sí');
  });

  it('distinguishes a row with a value from a row without one', () => {
    expect(hasReadableValue(row({ value: 580 }))).toBe(true);
    expect(hasReadableValue(row({ value: false }))).toBe(true);
    expect(hasReadableValue(row({ value: 0 }))).toBe(true);
    expect(hasReadableValue(row({ value: null }))).toBe(false);
  });

  it('badges only the provenances that mean "this is not a measurement"', () => {
    expect(sourceBadge(row({ source: 'read' }))).toBeNull();
    expect(sourceBadge(row({ source: 'assumed' }))).toBe('asumido');
    expect(sourceBadge(row({ source: 'unknown' }))).toBe('desconocido');
  });
});
