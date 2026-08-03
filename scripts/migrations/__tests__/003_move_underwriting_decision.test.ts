/**
 * Unit tests for migration 003's decision logic.
 *
 * These cover the two pure functions the migration's safety rests on:
 *
 *   - `classify` — which loan gets copied, which gets only its field deleted,
 *     and which is left completely alone. Getting this wrong either leaves a
 *     loan leaking or destroys the only copy of a decision breakdown.
 *   - `normaliseDetail` — the shape written into the ops-only subcollection.
 *     The migration deletes its source, so anything this function drops is
 *     gone for good.
 *
 * The module under test guards its `main()` behind `require.main === module`,
 * so importing it here does not touch Firestore.
 */

import {
  classify,
  isUsableDetail,
  normaliseDetail,
  type Action,
} from '../003_move_underwriting_decision';

/** A realistic inline value, in the shape requestLoan wrote before #509. */
function inlineValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'approve',
    reason: 'all conditions passed',
    allPass: true,
    conditions: [
      { name: 'bureau_score_min', pass: true, value: 712, bound: 640, source: 'read' },
      { name: 'lti_max', pass: true, value: 0.21, bound: 0.35, source: 'read' },
    ],
    evaluatedAt: { _seconds: 1750000000, _nanoseconds: 0 },
    ...overrides,
  };
}

describe('isUsableDetail', () => {
  it('accepts a detail doc carrying a non-empty conditions array', () => {
    expect(isUsableDetail({ conditions: [{ name: 'x', pass: true }] })).toBe(true);
  });

  it.each<[string, unknown]>([
    ['missing conditions', { decision: 'approve' }],
    ['empty conditions', { conditions: [] }],
    ['conditions not an array', { conditions: 'approve' }],
    ['null', null],
    ['an array', [{ name: 'x' }]],
    ['a string', 'approve'],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isUsableDetail(value)).toBe(false);
  });
});

describe('classify', () => {
  describe('idempotency', () => {
    it('skips a loan whose field is already gone, whatever the destination holds', () => {
      // This is the re-run path: the whole point is that a second run over an
      // already-migrated collection does nothing and errors on nothing.
      const cases: Array<[boolean, unknown]> = [
        [false, undefined],
        [true, { conditions: [{ name: 'x' }] }],
        [true, {}],
      ];
      for (const [exists, data] of cases) {
        expect(classify(undefined, exists, data)).toBe<Action>('absent');
      }
    });

    it('treats absence as absence before it looks at the destination at all', () => {
      // A destination that would otherwise be a conflict must not turn an
      // already-migrated loan into a reported failure.
      expect(classify(undefined, true, { conditions: [] })).toBe<Action>('absent');
    });
  });

  describe('the normal migration path', () => {
    it('copies and deletes when the destination does not exist', () => {
      expect(classify(inlineValue(), false)).toBe<Action>('copy-and-delete');
    });

    it('copies an object with an empty conditions array rather than reporting it', () => {
      // Still a faithful move: nothing is lost and the field stops leaking.
      expect(classify({ conditions: [] }, false)).toBe<Action>('copy-and-delete');
    });
  });

  describe('precedence: an existing destination wins', () => {
    it('deletes the field only, leaving a usable destination untouched', () => {
      const live = { decision: 'deny', conditions: [{ name: 'fraud_score_max', pass: false }] };
      expect(classify(inlineValue(), true, live)).toBe<Action>('delete-only');
    });

    it('does not clobber a destination that differs from the inline value', () => {
      // #509's live write path is authoritative; a stale inline remnant must
      // not overwrite it.
      const live = { decision: 'deny', conditions: [{ name: 'later_rescore', pass: false }] };
      expect(classify(inlineValue({ decision: 'approve' }), true, live)).toBe<Action>(
        'delete-only'
      );
    });

    it('reports a conflict rather than trading a real breakdown for an empty one', () => {
      expect(classify(inlineValue(), true, { conditions: [] })).toBe<Action>('conflict');
      expect(classify(inlineValue(), true, {})).toBe<Action>('conflict');
      expect(classify(inlineValue(), true, { decision: 'approve' })).toBe<Action>('conflict');
    });
  });

  describe('malformed inline values are never copied and never deleted', () => {
    it.each<[string, unknown]>([
      ['null', null],
      ['a string', 'approve'],
      ['a number', 42],
      ['a boolean', true],
      ['an array', [{ name: 'bureau_score_min' }]],
    ])('reports %s as malformed', (_label, value) => {
      expect(classify(value, false)).toBe<Action>('malformed');
    });

    it('reports malformed regardless of the destination state', () => {
      expect(classify(null, true, { conditions: [{ name: 'x' }] })).toBe<Action>('malformed');
      expect(classify(null, true, {})).toBe<Action>('malformed');
    });
  });
});

describe('normaliseDetail', () => {
  const STAMP = '<serverTimestamp>';

  it('carries the #509 detail shape across verbatim', () => {
    const raw = inlineValue();
    const out = normaliseDetail('loan_1', raw, STAMP);

    expect(out['decision']).toBe('approve');
    expect(out['reason']).toBe('all conditions passed');
    expect(out['allPass']).toBe(true);
    expect(out['conditions']).toEqual(raw['conditions']);
  });

  it('preserves the original evaluatedAt instead of stamping the migration time', () => {
    // Relabelling an old decision as evaluated today would make the ops record
    // actively misleading.
    const original = { _seconds: 1750000000, _nanoseconds: 0 };
    const out = normaliseDetail('loan_1', inlineValue({ evaluatedAt: original }), STAMP);

    expect(out['evaluatedAt']).toBe(original);
    expect(out['evaluatedAt']).not.toBe(STAMP);
  });

  it('records absent evaluatedAt as null rather than as "now"', () => {
    const raw = inlineValue();
    delete raw['evaluatedAt'];
    expect(normaliseDetail('loan_1', raw, STAMP)['evaluatedAt']).toBeNull();
  });

  it('stamps provenance so a later reader can tell a migrated doc from a native one', () => {
    const out = normaliseDetail('loan_abc', inlineValue(), STAMP);

    expect(out['_migrationTag']).toBe('003_move_underwriting_decision');
    expect(out['migratedFrom']).toBe('loans/loan_abc.underwritingDecision');
    expect(out['migratedAt']).toBe(STAMP);
  });

  it('preserves unrecognised keys under legacyFields', () => {
    // The migration deletes its source, so a dropped key is unrecoverable.
    const out = normaliseDetail(
      'loan_1',
      inlineValue({ modelVersion: 'v7', shadowScore: 0.04 }),
      STAMP
    );

    expect(out['legacyFields']).toEqual({ modelVersion: 'v7', shadowScore: 0.04 });
  });

  it('omits legacyFields entirely when there is nothing unrecognised', () => {
    expect(normaliseDetail('loan_1', inlineValue(), STAMP)).not.toHaveProperty('legacyFields');
  });

  it('degrades wrong-typed fields to null rather than writing them through', () => {
    const out = normaliseDetail(
      'loan_1',
      { decision: 12, reason: {}, allPass: 'yes', conditions: 'nope' },
      STAMP
    );

    expect(out['decision']).toBeNull();
    expect(out['reason']).toBeNull();
    expect(out['allPass']).toBeNull();
    expect(out['conditions']).toEqual([]);
  });

  it('keeps the originals of coerced known fields, since the source is deleted', () => {
    const out = normaliseDetail(
      'loan_1',
      { decision: 12, reason: {}, allPass: 'yes', conditions: 'nope' },
      STAMP
    );

    expect(out['legacyFields']).toEqual({
      decision: 12,
      reason: {},
      allPass: 'yes',
      conditions: 'nope',
    });
  });

  it('does not stash correctly-typed known fields as legacy', () => {
    expect(normaliseDetail('loan_1', inlineValue(), STAMP)).not.toHaveProperty('legacyFields');
  });

  it('does not stash a known field that was genuinely null', () => {
    // null → null is not a coercion, so there is nothing to recover.
    const out = normaliseDetail('loan_1', { decision: null, conditions: [] }, STAMP);
    expect(out).not.toHaveProperty('legacyFields');
  });

  it('never emits the field name it is migrating away from', () => {
    // A copied doc that itself contained `underwritingDecision` would just move
    // the confusion rather than resolve it.
    const out = normaliseDetail('loan_1', inlineValue(), STAMP);
    expect(out).not.toHaveProperty('underwritingDecision');
  });
});
