/**
 * #376 — trigger-kind guard.
 *
 * The existing Deploy Readiness Check compares export NAMES only, so it cannot
 * see a trigger-TYPE change. That is the class of break that took
 * `onContactCreated` down silently for two months.
 */

import {
  buildTriggerMap,
  diffTriggerMaps,
  formatTriggerDiff,
  resolveKindInSource,
  resolveModulePath,
  type FileReader,
} from '../deploy/triggerMap';

/** In-memory revision. */
function reader(files: Record<string, string>): FileReader {
  return (path: string) => files[path] ?? null;
}

const INDEX = 'functions/src/index.ts';

describe('resolveModulePath', () => {
  it('maps a relative specifier to a repo path', () => {
    expect(resolveModulePath('./contact/onContactCreated')).toBe(
      'functions/src/contact/onContactCreated.ts'
    );
  });
});

describe('resolveKindInSource', () => {
  it('reads an exported inline declaration', () => {
    expect(
      resolveKindInSource(`export const foo = onCall({ cors: true }, async () => {});`, 'foo')
    ).toBe('onCall');
  });

  it('reads a bare (non-exported) declaration, as found in a re-exported module', () => {
    expect(
      resolveKindInSource(`const foo = onDocumentCreated('c/{id}', async () => {});`, 'foo')
    ).toBe('onDocumentCreated');
  });

  it('does not match a commented-out declaration', () => {
    expect(resolveKindInSource(`// const foo = onCall(async () => {});`, 'foo')).toBeNull();
  });

  it('does not confuse a prefix of another kind', () => {
    expect(
      resolveKindInSource(`export const foo = onDocumentCreated('c/{id}', async () => {});`, 'foo')
    ).toBe('onDocumentCreated');
  });
});

describe('buildTriggerMap', () => {
  it('resolves inline declarations across every trigger family', () => {
    const map = buildTriggerMap(
      reader({
        [INDEX]: `
          export const api = onRequest({ cors: true }, async (req, res) => {});
          export const requestLoan = onCall(async (req) => {});
          export const onLoanApproved = onDocumentUpdated('loans/{loanId}', async () => {});
          export const dailyLoanCheck = onSchedule('every 24 hours', async () => {});
        `,
      })
    );
    expect(map).toEqual({
      api: 'onRequest',
      requestLoan: 'onCall',
      onLoanApproved: 'onDocumentUpdated',
      dailyLoanCheck: 'onSchedule',
    });
  });

  it('follows a re-export into its module file', () => {
    const map = buildTriggerMap(
      reader({
        [INDEX]: `export { onContactCreated } from './contact/onContactCreated';`,
        'functions/src/contact/onContactCreated.ts': `
          export const onContactCreated = onDocumentCreated('contact/{docId}', async (event) => {});
        `,
      })
    );
    expect(map).toEqual({ onContactCreated: 'onDocumentCreated' });
  });

  it('follows a renamed re-export using the local name in the module', () => {
    const map = buildTriggerMap(
      reader({
        [INDEX]: `export { handler as onContactCreated } from './contact/onContactCreated';`,
        'functions/src/contact/onContactCreated.ts': `
          const handler = onDocumentCreated('contact/{docId}', async () => {});
        `,
      })
    );
    expect(map).toEqual({ onContactCreated: 'onDocumentCreated' });
  });

  it('ignores exports that are not trigger declarations', () => {
    const map = buildTriggerMap(
      reader({ [INDEX]: `export const EMPLOYEE_CREDIT_CEILING = 5000;` })
    );
    expect(map).toEqual({});
  });
});

describe('diffTriggerMaps', () => {
  it('stays silent when a function changes but keeps its kind', () => {
    const diff = diffTriggerMaps({ requestLoan: 'onCall' }, { requestLoan: 'onCall' });
    expect(diff).toEqual({ changed: [], added: [], removed: [] });
    expect(formatTriggerDiff(diff)).toBe('');
  });

  it('flags an inline trigger-kind change', () => {
    const diff = diffTriggerMaps({ api: 'onRequest' }, { api: 'onCall' });
    expect(diff.changed).toEqual([{ name: 'api', from: 'onRequest', to: 'onCall' }]);
  });

  it('reports an added function without calling it deploy-breaking', () => {
    const diff = diffTriggerMaps({}, { brandNew: 'onCall' });
    expect(diff.added).toEqual([{ name: 'brandNew', kind: 'onCall' }]);
    expect(diff.changed).toEqual([]);
  });

  it('reports a removed function', () => {
    const diff = diffTriggerMaps({ gone: 'onSchedule' }, {});
    expect(diff.removed).toEqual([{ name: 'gone', kind: 'onSchedule' }]);
  });
});

describe('the real onContactCreated regression (#376)', () => {
  // The function was an HTTPS trigger and became an event trigger. Firebase
  // refuses that in place; the deploy has failed on every `main` run since
  // 2026-05-29. The name is unchanged, so the name-only export-drift check
  // passes and saw nothing.
  const base = reader({
    [INDEX]: `export { onContactCreated } from './contact/onContactCreated';`,
    'functions/src/contact/onContactCreated.ts': `
      export const onContactCreated = onRequest(async (req, res) => {});
    `,
  });
  const head = reader({
    [INDEX]: `export { onContactCreated } from './contact/onContactCreated';`,
    'functions/src/contact/onContactCreated.ts': `
      export const onContactCreated = onDocumentCreated('contact/{docId}', async (event) => {});
    `,
  });

  it('is invisible to a name-only comparison', () => {
    expect(Object.keys(buildTriggerMap(base))).toEqual(Object.keys(buildTriggerMap(head)));
  });

  it('is caught by the trigger-kind comparison', () => {
    const diff = diffTriggerMaps(buildTriggerMap(base), buildTriggerMap(head));
    expect(diff.changed).toEqual([
      { name: 'onContactCreated', from: 'onRequest', to: 'onDocumentCreated' },
    ]);
  });

  it('tells the operator to delete before redeploying, and names the HTTPS↔event crossing', () => {
    const report = formatTriggerDiff(
      diffTriggerMaps(buildTriggerMap(base), buildTriggerMap(head))
    );
    expect(report).toContain('cannot converge these in place');
    expect(report).toContain('HTTPS ↔ event trigger');
    expect(report).toContain('firebase functions:delete onContactCreated --force');
  });
});
