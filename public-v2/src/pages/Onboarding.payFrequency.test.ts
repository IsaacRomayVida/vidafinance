import { describe, expect, it } from 'vitest';
import { PAY_FREQUENCIES } from '../lib/payFrequencies';

// Mirrors PAY_FREQUENCY_VALUES in
// functions/src/loans/calculateNextPayrollDate.ts — the set of cadences that
// calculateNextPayrollDate has a real branch for. public-v2 and functions are
// separate TypeScript projects with no shared package, so this list can't
// import that one; this test is what keeps the two in agreement instead.
//
// This is the regression guard for #435: 'semimonthly' was a value
// calculateNextPayrollDate already understood, but no onboarding tile could
// ever produce it, so the branch sat unreachable while borrowers were quoted
// dates from the wrong cadence instead. If PAY_FREQUENCIES ever grows a value
// this list doesn't contain, that same class of bug is back.
//
// The comparison below is a set-equality check, not the one-directional
// `toContain` it used to be. A one-directional check only catches PAY_
// FREQUENCIES offering something calculateNextPayrollDate can't compute — it
// says nothing if PAY_FREQUENCIES is missing a cadence calculateNextPayrollDate
// already handles, which is the exact asymmetry #435 identified in
// resolvePayFrequency's old VALID_FREQUENCIES array (dropping a real member
// compiled clean because only the "no garbage in" direction was ever checked).
const FREQUENCIES_CALCULATE_NEXT_PAYROLL_DATE_HANDLES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

describe('onboarding pay frequency options', () => {
  it('matches, in both directions, the cadences calculateNextPayrollDate can compute a real date for', () => {
    expect([...PAY_FREQUENCIES].sort()).toEqual(
      [...FREQUENCIES_CALCULATE_NEXT_PAYROLL_DATE_HANDLES].sort()
    );
  });

  it('includes semimonthly, so the "Quincenal" tile stores the correct cadence', () => {
    expect(PAY_FREQUENCIES).toContain('semimonthly');
  });
});

/**
 * #446 — the labels a borrower actually reads.
 *
 * Storing the right cadence only helps if the borrower picks the right tile.
 * `biweekly` reads "Cada 14 días" rather than "Catorcenal" on Funpay Design's
 * ruling: technical correctness is not the risk here, familiarity is. A
 * borrower who does not recognise "Catorcenal" falls back to whatever sounds
 * closest to a word they know — which recreates #435's confusion from the
 * other direction. "Cada dos semanas" was rejected for the same reason: that
 * phrase is the colloquial habit that conflates 14-day and semi-monthly
 * cadences in Mexican Spanish in the first place.
 */
describe('pay frequency labels', () => {
  const es = () => import('../i18n/es.json').then((m) => m.default as Record<string, string>);

  const LABEL_KEYS = ['onb_e_freq_biweekly', 'onb_m_step4_freq_biweekly'];

  it('labels biweekly by its interval, on both the employer and employee steps', async () => {
    const strings = await es();
    for (const key of LABEL_KEYS) {
      expect(strings[key]).toBe('Cada 14 días');
    }
  });

  it('shares no rhyme between the biweekly and semimonthly labels', async () => {
    // The failure this guards is not a wrong label, it is two labels a reader
    // can round into each other by sound. "Catorcenal" and "Quincenal" share
    // the ending "cenal"; "Cada 14 días" and "Quincenal" cannot be confused
    // that way. Compared on word ENDINGS, not beginnings, because the risk is
    // the rhyme — a prefix comparison passes both labels and proves nothing.
    const strings = await es();
    const endings = (label: string) =>
      new Set(
        label
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .split(/\s+/)
          .filter((word) => word.length >= 5)
          .map((word) => word.slice(-5))
      );

    for (const [biweeklyKey, semimonthlyKey] of [
      ['onb_e_freq_biweekly', 'onb_e_freq_semimonthly'],
      ['onb_m_step4_freq_biweekly', 'onb_m_step4_freq_semimonthly'],
    ]) {
      const shared = [...endings(strings[biweeklyKey])].filter((s) =>
        endings(strings[semimonthlyKey]).has(s)
      );
      expect(shared).toEqual([]);
    }
  });
});
