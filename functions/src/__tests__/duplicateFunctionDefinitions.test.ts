/**
 * Six Cloud Functions are defined twice: once inline in index.ts, and once
 * again in a module file under src/. Only the inline copy deploys — index.ts
 * is the entry point, and none of these module files is re-exported from it,
 * so the module copy is dead with respect to production.
 *
 * That matters more than ordinary dead code. A reader who opens
 * src/loans/updateLoanStatus.ts is looking at logic that decides loan state
 * transitions and will reasonably assume it runs. Four of the six say "NOT
 * DEPLOYED" in a header comment; two do not say anything at all. Tests written
 * against a module copy measure coverage on code that never executes, which
 * makes the coverage ratchet report protection that does not exist.
 *
 * This test does not fix the duplication — collapsing it means editing
 * money-handling functions and belongs in its own reviewed change. It freezes
 * it: the set below is what exists today, and a new duplicate fails here
 * rather than being discovered later by someone editing the copy that does not
 * run. Removing a duplicate also fails, which is the point — delete the entry
 * in the same commit that collapses it.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');
const INDEX = join(SRC, 'index.ts');

/**
 * Known duplicates, as of 2026-09-19. Each name is defined inline in index.ts
 * (the copy that deploys) AND in the listed module file (the copy that does
 * not). Shrink this list only by actually collapsing a duplicate.
 */
const KNOWN_DUPLICATES: Record<string, string> = {
  api: 'health/api.ts',
  updateLoanStatus: 'loans/updateLoanStatus.ts',
  onLoanStatusChange: 'loans/onLoanStatusChange.ts',
  approveEmployer: 'employers/approveEmployer.ts',
  queueHealthCheck: 'scheduled/queueHealthCheck.ts',
  systemHealthCheck: 'scheduled/systemHealthCheck.ts',
  weeklyPortfolioSnapshot: 'scheduled/weeklyPortfolioSnapshot.ts',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === '__mocks__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('duplicate Cloud Function definitions', () => {
  const indexSource = readFileSync(INDEX, 'utf8');

  /** Names index.ts defines inline — these are what actually deploy. */
  const inlineNames = new Set(
    [...indexSource.matchAll(/^export const (\w+) = on[A-Z]\w*\(/gm)].map((m) => m[1]),
  );

  /** Names index.ts re-exports from a module — the module copy deploys instead. */
  const reExported = new Set(
    [...indexSource.matchAll(/export\s*\{([^}]*)\}\s*from/g)]
      .flatMap((m) => m[1].split(','))
      .map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
      .filter(Boolean),
  );

  const found: Record<string, string> = {};
  for (const file of walk(SRC)) {
    if (file === INDEX) continue;
    const rel = file.slice(SRC.length + 1);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^export const (\w+) = on[A-Z]\w*\(/gm)) {
      const name = match[1];
      if (inlineNames.has(name) && !reExported.has(name)) {
        found[name] = rel;
      }
    }
  }

  it('index.ts still defines the deployed copy of every known duplicate', () => {
    for (const name of Object.keys(KNOWN_DUPLICATES)) {
      expect(inlineNames.has(name)).toBe(true);
    }
  });

  it('no module copy of a known duplicate is re-exported, so index.ts is what deploys', () => {
    for (const name of Object.keys(KNOWN_DUPLICATES)) {
      expect(reExported.has(name)).toBe(false);
    }
  });

  it('the set of duplicated definitions has not grown or changed', () => {
    expect(found).toEqual(KNOWN_DUPLICATES);
  });
});
