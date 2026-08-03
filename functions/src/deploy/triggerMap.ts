/**
 * Static trigger-kind map for the functions exported from `functions/src/index.ts`.
 *
 * Why this exists (#376): Firebase cannot converge a change of trigger TYPE in
 * place. Turning an HTTPS function into an event-triggered one (or vice versa)
 * requires deleting the deployed function first and redeploying it. When that
 * is done without the delete, every subsequent deploy of that function fails —
 * which is exactly what happened to `onContactCreated`, silently, on every
 * `main` run from 2026-05-29 onward.
 *
 * The existing "Deploy Readiness Check" in ci.yml compares export NAMES against
 * deploy.yml's FUNCTIONS list. `onContactCreated` is present in both, so a
 * name-only check cannot see this class of break.
 *
 * SCOPE — read this before trusting the check:
 *
 *   This resolves trigger kinds from SOURCE at two git revisions and diffs
 *   them. It therefore catches a trigger-kind change *introduced by a PR*, at
 *   the PR that introduces it. It does NOT detect drift against what is
 *   currently deployed in Firebase — that genuinely needs the Firebase API and
 *   staging-scoped CI credentials, which is the "fuller option" in #376 and
 *   remains parked pending an IAM decision.
 *
 *   Concretely: this would have caught `onContactCreated` at the PR that
 *   converted it, but it does NOT retroactively flag it now, because that
 *   change is already in the base revision. The already-deployed
 *   `onContactCreated` still needs an operator delete-then-recreate.
 *
 * No credentials, no network, no Firebase auth — pure text analysis, which is
 * why it is safe to run pre-merge under the same reasoning that admitted the
 * existing credential-free job.
 */

/** A file reader over a single git revision. Returns null when absent. */
export type FileReader = (path: string) => string | null;

export interface TriggerDiff {
  changed: Array<{ name: string; from: string; to: string }>;
  added: Array<{ name: string; kind: string }>;
  removed: Array<{ name: string; kind: string }>;
}

const INDEX_PATH = 'functions/src/index.ts';

/**
 * Trigger factories we recognise, longest-first so that `onDocumentCreated`
 * is never shadowed by a prefix match. Anything not on this list resolves to
 * `unknown`, which is reported but never treated as a change on its own.
 */
const TRIGGER_KINDS = [
  'onDocumentCreated',
  'onDocumentUpdated',
  'onDocumentDeleted',
  'onDocumentWritten',
  'onMessagePublished',
  'onObjectFinalized',
  'onValueCreated',
  'onValueUpdated',
  'onValueWritten',
  'onSchedule',
  'onRequest',
  'onCall',
];

/**
 * HTTPS-family kinds. A move between this family and the event family is the
 * non-convergeable case; it is worth calling out separately from, say,
 * onDocumentCreated -> onDocumentUpdated (which Firebase also cannot converge,
 * but which is a far more obvious edit).
 */
const HTTPS_KINDS = new Set(['onCall', 'onRequest']);

export function isHttpsKind(kind: string): boolean {
  return HTTPS_KINDS.has(kind);
}

/** Strip line and block comments so commented-out code never matches. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Resolve a called expression to a trigger kind.
 *
 * The callee is matched as a whole dotted chain and reduced to its last
 * segment, so `onCall`, `https.onCall` and `functions.https.onRequest` all
 * resolve, while a substring never accidentally matches. Matching the callee
 * rather than scanning a window of the initializer body matters: a windowed
 * scan runs past the end of one declaration and picks up the trigger of the
 * NEXT one.
 */
function kindFromCallee(callee: string): string | null {
  const last = callee.split('.').pop();
  if (!last) return null;
  return TRIGGER_KINDS.includes(last) ? last : null;
}

/** `<name> = <callee>(` — the callee chain is capture group 1. */
function calleeOf(src: string, name: string): string | null {
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+?)?=\\s*([A-Za-z0-9_$.]+)\\s*(?:<[^>]*>)?\\s*\\(`
  );
  const m = src.match(re);
  return m?.[1] ?? null;
}

/**
 * Resolve the trigger kind of `name` as declared in `src`.
 * Handles `export const name = onCall(...)` and a bare `const name = onCall(...)`
 * (the shape found in a re-exported module).
 */
export function resolveKindInSource(src: string, name: string): string | null {
  const callee = calleeOf(stripComments(src), name);
  return callee === null ? null : kindFromCallee(callee);
}

/** Resolve a relative module specifier from index.ts into a repo path. */
export function resolveModulePath(spec: string): string {
  const bare = spec.replace(/^\.\//, '').replace(/\.js$/, '').replace(/\.ts$/, '');
  return `functions/src/${bare}.ts`;
}

/**
 * Build { exportedName -> triggerKind } for one revision.
 *
 * Both declaration forms are handled, because the re-export form is precisely
 * the one that broke:
 *   - inline:     `export const requestLoan = onCall(...)`
 *   - re-export:  `export { onContactCreated } from './contact/onContactCreated'`
 *                 (real declaration lives in the module file)
 */
export function buildTriggerMap(readFile: FileReader): Record<string, string> {
  const indexSrc = readFile(INDEX_PATH);
  if (indexSrc === null) return {};
  const clean = stripComments(indexSrc);
  const map: Record<string, string> = {};

  // Inline declarations.
  for (const m of clean.matchAll(
    /export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+?)?=\s*([A-Za-z0-9_$.]+)\s*(?:<[^>]*>)?\s*\(/g
  )) {
    const name = m[1];
    const callee = m[2];
    if (!name || !callee) continue;
    const kind = kindFromCallee(callee);
    if (kind) map[name] = kind;
  }

  // Re-exports: follow into the module file and resolve there.
  for (const m of clean.matchAll(/export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1];
    const spec = m[2];
    if (!clause || !spec) continue;
    if (!spec.startsWith('.')) continue; // package re-export, not ours
    const modSrc = readFile(resolveModulePath(spec));
    if (modSrc === null) continue;
    for (let part of clause.split(',')) {
      part = part.trim();
      if (!part || part.startsWith('type ')) continue;
      // `foo as bar` — `foo` is the local name in the module, `bar` the export.
      const [localRaw, aliasRaw] = part.includes(' as ')
        ? part.split(' as ').map((s) => s.trim())
        : [part, part];
      const local = localRaw ?? part;
      const exported = aliasRaw ?? local;
      const kind = resolveKindInSource(modSrc, local);
      if (kind) map[exported] = kind;
    }
  }

  return map;
}

/** Diff two trigger maps. `changed` is the deploy-breaking set. */
export function diffTriggerMaps(
  base: Record<string, string>,
  head: Record<string, string>
): TriggerDiff {
  const diff: TriggerDiff = { changed: [], added: [], removed: [] };

  for (const [name, kind] of Object.entries(head)) {
    const before = base[name];
    if (before === undefined) {
      diff.added.push({ name, kind });
    } else if (before !== kind) {
      diff.changed.push({ name, from: before, to: kind });
    }
  }
  for (const [name, kind] of Object.entries(base)) {
    if (head[name] === undefined) diff.removed.push({ name, kind });
  }

  diff.changed.sort((a, b) => a.name.localeCompare(b.name));
  diff.added.sort((a, b) => a.name.localeCompare(b.name));
  diff.removed.sort((a, b) => a.name.localeCompare(b.name));
  return diff;
}

/** Human-readable report. Empty string when there is nothing to say. */
export function formatTriggerDiff(diff: TriggerDiff): string {
  const lines: string[] = [];

  for (const c of diff.changed) {
    const crossesFamily = isHttpsKind(c.from) !== isHttpsKind(c.to);
    lines.push(
      `- **${c.name}**: \`${c.from}\` → \`${c.to}\`` +
        (crossesFamily ? ' — HTTPS ↔ event trigger' : '')
    );
  }
  for (const r of diff.removed) {
    lines.push(`- **${r.name}**: removed (was \`${r.kind}\`)`);
  }

  if (lines.length === 0) return '';

  return [
    'Trigger-type changes detected. Firebase **cannot converge these in place**.',
    '',
    ...lines,
    '',
    'Before this reaches `main`, an operator must delete each function above in',
    'Firebase and let the next deploy recreate it:',
    '',
    '```',
    ...diff.changed.map((c) => `firebase functions:delete ${c.name} --force`),
    ...diff.removed.map((r) => `firebase functions:delete ${r.name} --force`),
    '```',
    '',
    'Skipping the delete is what left `onContactCreated` failing to deploy',
    'silently on every `main` run since 2026-05-29 (#376).',
  ].join('\n');
}
