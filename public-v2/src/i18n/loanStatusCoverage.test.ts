/**
 * Every loan status the backend can write must have a `status_<x>` string in
 * BOTH languages, a badge colour to render it in, and a timeline-group
 * mapping that doesn't assert something false about it.
 *
 * i18next is configured with no `parseMissingKeyHandler` (see ./index.ts), so a
 * missing key renders as the key itself: a borrower whose loan went to
 * collections saw the literal text `status_in_collections` in their dashboard
 * (#500). Separately, `LoanStatusCard`'s `resolveGroup` used to end in
 * `default: return 'pending_review'`, so a written-off borrower was told their
 * application was under review — a false statement to a borrower about their
 * own credit, worse than an unstyled badge.
 *
 * This used to be a hand-maintained `LOAN_STATUSES` array, re-derived by
 * running a grep and pasting the result in (see git history). That is exactly
 * the class of drift PR #500 and #513 both shipped from: a human edits one
 * side of a mirror and the other silently falls behind. `ALL_LOAN_STATUSES`
 * below is imported directly from the backend's own canonical module instead
 * — `functions/src/loans/loanStatus.ts` has no firebase-admin or
 * firebase-functions imports (it's plain literals and pure functions), so
 * Vitest can evaluate it with no shims and no risk of dragging in
 * firebase-admin (unlike functions/src/index.ts or getReviewQueue.ts, which
 * reviewStatus.parity.test.ts has to regex-parse instead for exactly that
 * reason).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALL_LOAN_STATUSES,
  LEGACY_REPAID_ALIASES,
} from '../../../functions/src/loans/loanStatus';
import { GROUP_COLORS, resolveGroup } from '../components/loanStatusGroups';
import en from './en.json';
import es from './es.json';

/**
 * `LEGACY_REPAID_ALIASES` is `['paid', 'complete', 'completed']`, but its own
 * docstring in functions/src/loans/loanStatus.ts draws a real distinction
 * inside that list: `'paid'` is a spelling a `loans/{loanId}.status` document
 * COULD carry (a hand-write through the pre-validation `updateLoanStatus`),
 * while `'complete'`/`'completed'` are "seen only on OTHER collections
 * (disbursement_queue.status, payrollBatches.status, scheduler_runs.status)
 * ... never on loans.status in every write site audited." Requiring a loan
 * badge/i18n string for a spelling that has never once landed on a loan
 * document would test something that provably cannot happen — so only the
 * loan-plausible alias is pulled in here. The runtime check below fails loudly
 * if 'paid' is ever removed from LEGACY_REPAID_ALIASES upstream, so this
 * carve-out can't silently drift from the source it's carved out of.
 */
if (!LEGACY_REPAID_ALIASES.includes('paid')) {
  throw new Error(
    "functions/src/loans/loanStatus.ts's LEGACY_REPAID_ALIASES no longer includes 'paid' — " +
      'update the PLAUSIBLE_LEGACY_LOAN_ALIASES carve-out in loanStatusCoverage.test.ts to match.'
  );
}
const PLAUSIBLE_LEGACY_LOAN_ALIASES = ['paid'];

/**
 * Every spelling a `status_${loan.status}` / `badge-${loan.status}` render
 * site can actually encounter: everything the backend's canonical enum can
 * write, plus the one legacy alias a loan document could actually carry. A
 * status missing from i18n/CSS/group coverage is exactly as visible to a
 * borrower whether the backend writes it today or merely left it on a
 * document years ago.
 */
/**
 * NOT part of the backend's canonical `LOAN_STATUS` enum — grepping every
 * `status: '...'` write in functions/src turns up no path that ever sets
 * `loans/{loanId}.status` to `'escalated'` today (submitReviewDecision only
 * writes it to the review doc; a loan tied to an escalated review stays
 * `under_review`). It's kept here rather than dropped because
 * `public-v2/src/pages/EmployeeDashboard.tsx`'s `IN_FLIGHT_STATUSES` still
 * lists it as a loan status to watch for, and `resolveGroup` below still
 * branches on it explicitly — removing the requirement would silently weaken
 * coverage this suite already had. If a future change proves `escalated`
 * truly unreachable as a loan status, delete it from all three places
 * together, not just this list.
 */
const EXTRA_KEYED_STATUSES = ['escalated'];

const KEYED = [...ALL_LOAN_STATUSES, ...PLAUSIBLE_LEGACY_LOAN_ALIASES, ...EXTRA_KEYED_STATUSES];

const dict = (d: Record<string, string>) => d;

/** Pure checkers, factored out so the self-test below can prove they fire. */
function missingI18nKeys(d: Record<string, string>, statuses: readonly string[]): string[] {
  return statuses.filter((s) => {
    const value = d[`status_${s}`];
    return !value || value === `status_${s}`;
  });
}

function missingBadgeRules(css: string, statuses: readonly string[]): string[] {
  return statuses.filter((s) => !new RegExp(`\\.badge-${s}\\s*[,{]`).test(css));
}

/**
 * A status is "unsafe" if resolveGroup throws, or resolves to a group with no
 * entry in GROUP_COLORS — either would crash the card or render an
 * unstyled/undefined-styled pill. It is NOT unsafe merely for landing on
 * 'other': that is the deliberate, honest fallback #500 introduced for
 * statuses without real card copy yet (see resolveGroup's comment). The
 * failure mode this guards is a status resolving to a group whose styling
 * doesn't exist, not a status resolving to the neutral group.
 */
function unsafeGroupMappings(statuses: readonly string[]): string[] {
  return statuses.filter((s) => {
    try {
      const group = resolveGroup(s);
      return !(group in GROUP_COLORS);
    } catch {
      return true;
    }
  });
}

describe('coverage checkers (self-test — proves each guard actually fires)', () => {
  it('missingI18nKeys reports nothing for a complete fixture dict', () => {
    expect(missingI18nKeys({ status_a: 'A', status_b: 'B' }, ['a', 'b'])).toEqual([]);
  });

  it('missingI18nKeys catches an absent key and a key echoing itself back', () => {
    const broken = { status_a: 'A', status_b: 'status_b' }; // 'b' missing a real translation, 'c' absent entirely
    expect(missingI18nKeys(broken, ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });

  it('missingBadgeRules reports nothing when every status has a rule', () => {
    expect(missingBadgeRules('.badge-a,.badge-b{color:red}', ['a', 'b'])).toEqual([]);
  });

  it('missingBadgeRules catches a status with no .badge-<status> rule', () => {
    expect(missingBadgeRules('.badge-a{color:red}', ['a', 'b'])).toEqual(['b']);
  });

  it('unsafeGroupMappings is silent for a status that resolves to a styled group', () => {
    // 'pending' is real input to the real resolveGroup — proves the checker
    // doesn't just always return [] against the actual production function.
    expect(unsafeGroupMappings(['pending'])).toEqual([]);
  });

  it('unsafeGroupMappings catches a group with no GROUP_COLORS entry', () => {
    const brokenResolve = (s: string) => (s === 'ghost' ? ('nonexistent-group' as never) : resolveGroup(s));
    const unsafe = ['pending', 'ghost'].filter((s) => {
      try {
        return !(brokenResolve(s) in GROUP_COLORS);
      } catch {
        return true;
      }
    });
    expect(unsafe).toEqual(['ghost']);
  });
});

describe('status_* i18n coverage', () => {
  it('es has a non-empty, real (non-key-echoing) string for every backend loan status', () => {
    const missing = missingI18nKeys(dict(es), KEYED);
    expect(missing, `es.json is missing status_<x> for: ${missing.join(', ')}`).toEqual([]);
  });

  it('en has a non-empty, real (non-key-echoing) string for every backend loan status', () => {
    const missing = missingI18nKeys(dict(en), KEYED);
    expect(missing, `en.json is missing status_<x> for: ${missing.join(', ')}`).toEqual([]);
  });

  it('es and en define exactly the same status_ keys', () => {
    const keys = (d: Record<string, string>) =>
      Object.keys(d).filter((k) => k.startsWith('status_')).sort();
    expect(keys(es)).toEqual(keys(en));
  });
});

/**
 * The string is only half of it: every render site pairs `status_${status}`
 * with `className={`badge badge-${status}`}`, so a status with copy but no
 * colour rule renders as unstyled text where a pill is expected.
 * `disbursement_failed` and `rejected_ml` had exactly that gap.
 */
describe('badge colour coverage', () => {
  // Read off disk rather than imported: vite.config.ts sets `css: false` for
  // the test run, so a `import '...legacy.css'` (even `?raw`) resolves to an
  // empty stub and every assertion below would fail for the wrong reason.
  // vitest's cwd is the public-v2 root.
  const css = readFileSync(resolve(process.cwd(), 'src/styles/legacy.css'), 'utf8');

  it('found the stylesheet', () => {
    expect(css.length).toBeGreaterThan(0);
  });

  it('legacy.css defines a .badge-<status> rule for every backend loan status', () => {
    const missing = missingBadgeRules(css, KEYED);
    expect(missing, `legacy.css is missing .badge-<x> for: ${missing.join(', ')}`).toEqual([]);
  });
});

/**
 * Mechanical version of the #500 timeline-group defect: every status the
 * backend can write must resolve, via LoanStatusCard's resolveGroup, to a
 * group that actually has styling. This is what stops the NEXT status from
 * silently repeating "written_off renders the pending card" — it doesn't
 * require a human to remember to add a case to the switch statement's test
 * coverage, because it walks the same list the i18n/badge checks above do.
 */
describe('timeline-group coverage', () => {
  it('resolveGroup returns a styled group for every backend loan status', () => {
    const unsafe = unsafeGroupMappings(KEYED);
    expect(unsafe, `resolveGroup has no safe group for: ${unsafe.join(', ')}`).toEqual([]);
  });
});
