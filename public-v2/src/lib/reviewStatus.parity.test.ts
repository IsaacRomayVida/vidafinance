/**
 * Mechanical drift guard for the review-status vocabulary.
 *
 * reviewStatus.ts documents itself as a mirror of three backend literals and
 * names the files to change together. That comment is a promise nobody
 * mechanically checks — PR #513 shipped BECAUSE the console's copy of this
 * vocabulary had already drifted narrower than the backend's, and nothing
 * failed. This test reads the actual backend source text and fails with the
 * exact differing members if the two ever disagree again.
 *
 * Backend regex-parsed rather than imported: getReviewQueue.ts and index.ts
 * both pull in firebase-functions/firebase-admin, which public-v2 does not
 * depend on and cannot safely evaluate at module-load time in a Vitest/jsdom
 * process (see the "Be careful with firebase-admin" note in the parity guard
 * task brief — a second copy of firebase-admin at the repo root has broken
 * the E2E gate before). The array literals themselves have no such baggage,
 * so parsing the source text is the safe way to see what a human actually
 * wrote, which is exactly what this guard needs to catch.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DECIDABLE_REVIEW_STATUSES,
  ESCALATED_DECIDER_ROLES,
  OPEN_REVIEW_STATUSES,
} from './reviewStatus';

const REPO_ROOT = resolve(process.cwd(), '..');

function readBackendSource(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

/**
 * Pulls a `const NAME = ['a', 'b', ...];` string-array literal out of raw
 * TypeScript source. Throws (rather than returning `[]`) when the pattern
 * isn't found, so a rename or reformat on the backend fails this guard loudly
 * instead of silently comparing against an empty array and reporting
 * "drift" for every member — or worse, comparing two empty arrays and
 * reporting no drift at all.
 */
function parseStringArrayConst(source: string, constName: string, fileLabel: string): string[] {
  const match = source.match(new RegExp(`const ${constName}[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!match) {
    throw new Error(
      `reviewStatus.parity.test.ts could not find "const ${constName} = [...]" in ${fileLabel}. ` +
        `Either the constant was renamed/reformatted (update this guard's regex) or it was removed ` +
        `(update reviewStatus.ts too, since it mirrors this exact constant).`
    );
  }
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^['"]|['"]$/g, ''));
}

/**
 * The comparison itself, factored out so the negative self-test below can
 * prove it actually detects a mismatch before we trust it against real
 * files. Returns a human-readable report naming both sides' exclusive
 * members, or null when the two sets agree.
 */
function diffVocabularies(
  backendLabel: string,
  backendValues: string[],
  frontendLabel: string,
  frontendValues: string[]
): string | null {
  const backendSet = new Set(backendValues);
  const frontendSet = new Set(frontendValues);
  const onlyBackend = backendValues.filter((v) => !frontendSet.has(v)).sort();
  const onlyFrontend = frontendValues.filter((v) => !backendSet.has(v)).sort();
  if (onlyBackend.length === 0 && onlyFrontend.length === 0) return null;

  const lines = [`Drift between ${backendLabel} and ${frontendLabel}:`];
  if (onlyBackend.length) lines.push(`  only in ${backendLabel}: ${onlyBackend.join(', ')}`);
  if (onlyFrontend.length) lines.push(`  only in ${frontendLabel}: ${onlyFrontend.join(', ')}`);
  return lines.join('\n');
}

describe('diffVocabularies (self-test — proves the guard actually fires)', () => {
  it('reports no drift when both sides agree', () => {
    expect(diffVocabularies('backend', ['pending', 'escalated'], 'frontend', ['escalated', 'pending'])).toBeNull();
  });

  it('names the exact differing members on a deliberately mismatched fixture', () => {
    const report = diffVocabularies(
      'functions/fixture.ts OPEN_STATUSES',
      ['pending', 'pending_review', 'info_requested', 'escalated'],
      'reviewStatus.fixture.ts OPEN_REVIEW_STATUSES',
      ['pending', 'pending_review']
    );
    expect(report).not.toBeNull();
    expect(report).toContain('only in functions/fixture.ts OPEN_STATUSES: escalated, info_requested');
    expect(report).not.toContain('only in reviewStatus.fixture.ts OPEN_REVIEW_STATUSES');
  });

  it('names members unique to the frontend side too', () => {
    const report = diffVocabularies('backend', ['a', 'b'], 'frontend', ['a', 'b', 'c']);
    expect(report).toContain('only in frontend: c');
  });
});

describe('review-status vocabulary parity (functions vs public-v2/src/lib/reviewStatus.ts)', () => {
  const getReviewQueueSrc = readBackendSource('functions/src/admin/getReviewQueue.ts');
  const indexSrc = readBackendSource('functions/src/index.ts');

  it('OPEN_STATUSES (getReviewQueue.ts) matches OPEN_REVIEW_STATUSES (reviewStatus.ts)', () => {
    const backend = parseStringArrayConst(getReviewQueueSrc, 'OPEN_STATUSES', 'functions/src/admin/getReviewQueue.ts');
    const report = diffVocabularies(
      'functions/src/admin/getReviewQueue.ts OPEN_STATUSES',
      backend,
      'public-v2/src/lib/reviewStatus.ts OPEN_REVIEW_STATUSES',
      [...OPEN_REVIEW_STATUSES]
    );
    expect(report, report ?? undefined).toBeNull();
  });

  it('DECIDABLE_REVIEW_STATUSES (index.ts) matches DECIDABLE_REVIEW_STATUSES (reviewStatus.ts)', () => {
    const backend = parseStringArrayConst(indexSrc, 'DECIDABLE_REVIEW_STATUSES', 'functions/src/index.ts');
    const report = diffVocabularies(
      'functions/src/index.ts DECIDABLE_REVIEW_STATUSES',
      backend,
      'public-v2/src/lib/reviewStatus.ts DECIDABLE_REVIEW_STATUSES',
      [...DECIDABLE_REVIEW_STATUSES]
    );
    expect(report, report ?? undefined).toBeNull();
  });

  it('ESCALATED_DECIDER_ROLES (index.ts) matches ESCALATED_DECIDER_ROLES (reviewStatus.ts)', () => {
    const backend = parseStringArrayConst(indexSrc, 'ESCALATED_DECIDER_ROLES', 'functions/src/index.ts');
    const report = diffVocabularies(
      'functions/src/index.ts ESCALATED_DECIDER_ROLES',
      backend,
      'public-v2/src/lib/reviewStatus.ts ESCALATED_DECIDER_ROLES',
      [...ESCALATED_DECIDER_ROLES]
    );
    expect(report, report ?? undefined).toBeNull();
  });
});
