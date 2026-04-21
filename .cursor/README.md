# VIDA Finance — Cursor Config Kit + Handover Package

Everything a new operator (human or AI) needs to work on VIDA. Built from an actual repo scan — rules match the real codebase, not guesses.

## What the two layers do

**`rules/`, `skills/`, `subagents/`, `commands/`** → Cursor-active. Auto-engage when you open files in the repo. Day-to-day work.

**`handover/`** → Passive documentation. Read by humans picking up the project. Referenced by AI when deeper context is needed. Six documents, read in order.

Both layers install into `.cursor/` in your repo so the whole team sees them.

## What's inside

```
cursor-config/
├── README.md                                    ← you are here
├── install.sh                                   ← one-command installer
├── rules/                                       ← 6 rules
│   ├── 01-vida-project-context.md              always — what VIDA is + real file tree + route map
│   ├── 02-frontend-design-system.md            always — Tailwind v4 tokens + DM Sans/Serif + components
│   ├── 03-react-component-conventions.md       auto-attach to public-v2/src/** — React 19 patterns
│   ├── 04-firebase-integration.md              auto-attach — Auth, Firestore, Storage, CFs, App Check
│   ├── 05-never-break.md                        always — hard invariants (security, stability, etc.)
│   └── 06-mexican-spanish-copy.md              auto-attach to .tsx + i18n/** — Mexican Spanish voice
├── skills/                                      ← 3 workflows
│   ├── component-audit.md                       review a component against the rules
│   ├── mobile-first-polish.md                   responsive polish at 4 viewports
│   └── frontend-debug.md                        root-cause any visual/behavior bug
├── subagents/                                   ← 2 focused reviewers
│   ├── design-critic.md                         @design-critic — senior design lead
│   └── copy-editor.md                           @copy-editor — Mexican Spanish tone
├── commands/                                    ← 3 slash-commands
│   ├── ship-component.md                        /ship-component — full build-to-PR
│   ├── polish-page.md                           /polish-page — audit + polish pass
│   └── review-pr.md                             /review-pr — self-review before push
├── context/
│   └── CURRENT_STATE.md                         project snapshot (real routes, tokens, state)
└── handover/                                    ← handover documentation (human-readable)
    ├── README.md                                handover-folder index
    ├── HANDOVER.md                              5-minute orientation for any new operator
    ├── LAUNCH_CHECKLIST.md                      done / doing / left, source of truth for launch
    ├── PROVIDER_TRACKER.md                      every vendor, what to ask, current status
    ├── FIRST_WEEK.md                            day-by-day plan for next 7 days
    ├── DECISIONS.md                             architectural decisions with rationale
    └── GLOSSARY.md                              VIDA + fintech + Mexican regulatory terms
```

## Quickest install — run the script

```bash
# From where you unzipped this bundle:
cd cursor-config
REPO_ROOT="/Users/admin/Desktop/Vida Finance" ./install.sh
```

The script drops everything into `.cursor/` in your repo and tells you the git commands to commit. Cursor auto-picks up `.cursor/` directories — no manual paste required.

Then:
```bash
cd "/Users/admin/Desktop/Vida Finance"
git add .cursor/
git commit -m "chore(cursor): install VIDA config kit"
git push origin main
```

## Manual install (if the script fails or you want fine control)

Based on the screenshot you shared of Cursor Settings → Rules, Skills, Subagents:

### 1. Click the **Vida Finance** tab (not User)

User = your personal settings across all Cursor projects. Vida Finance = project-scoped, shared via the committed `.cursor/` directory.

### 2. Rules — click **+ New** for each file in `rules/`

Set the **Apply mode** per file:

| File | Apply mode |
|---|---|
| `01-vida-project-context.md` | Always |
| `02-frontend-design-system.md` | Always |
| `03-react-component-conventions.md` | Auto-attached, glob: `public-v2/src/**/*.{ts,tsx}` |
| `04-firebase-integration.md` | Auto-attached, glob: `public-v2/src/**/*.{ts,tsx}` |
| `05-never-break.md` | Always |
| `06-mexican-spanish-copy.md` | Auto-attached, glob: `public-v2/src/**/*.{ts,tsx},public-v2/src/i18n/**` |

The front-matter in each `.md` file already declares the apply mode; Cursor reads it automatically when you commit under `.cursor/rules/`.

### 3. Skills — click **+ New** for each file in `skills/`

Name them the filename (e.g. `component-audit`). Cursor auto-invokes when relevant; you can also trigger manually with `/component-audit` in chat.

### 4. Subagents — click **+ New** for each file in `subagents/`

Become callable via `@design-critic` or `@copy-editor` in chat.

### 5. Commands — click **+ New** for each file in `commands/`

Trigger in chat with `/ship-component`, `/polish-page`, `/review-pr`.

### 6. Context file

`context/CURRENT_STATE.md` lives in `.cursor/context/` — Cursor doesn't auto-read it, but you can:
- Reference it from rule 01 (already done)
- Manually include it in any chat with `@CURRENT_STATE.md`

## Verifying the install

After commit + push:

1. Open Cursor on `/Users/admin/Desktop/Vida Finance`
2. Open any `.tsx` file under `public-v2/src/`
3. The chat panel should show rules 01, 02, 03, 06 attached (and 04 if the file imports Firebase)
4. Type `/` in chat → `/ship-component`, `/polish-page`, `/review-pr` appear
5. Type `@` → `@design-critic` and `@copy-editor` appear

If any don't appear, check the Cursor Settings UI and toggle `Include third-party Plugins, Skills, and other configs` ON (visible in your screenshot).

## When to use what

| Task | Use |
|---|---|
| Building a new component | Rules auto-attach + `/ship-component` |
| Polishing existing UI | `/polish-page` or skill `mobile-first-polish` |
| Debugging visual bug | skill `frontend-debug` |
| Before pushing a PR | `/review-pr` + `@design-critic` |
| Writing Spanish copy | `@copy-editor` (rule 06 also auto-engages) |
| Auditing a component | skill `component-audit` |

## Maintenance

The rules capture the codebase state as of **2026-04-21** (main tip `d975bb0`, after PRs #342/#343/#344/#345/#346). If the stack changes (new deps, Tailwind v5, React 20, routes renamed, etc.), edit the relevant `.md` file in `.cursor/rules/` in place and commit. Cursor picks up changes on save.

Accuracy decay notes:
- Rule 01 lists the full file tree — if pages are added/removed, update
- Rule 02 lists design tokens — if `@theme` block changes, update
- Rule 03 mentions deps (no clsx, no test runner) — update when these land
- `CURRENT_STATE.md` has date + main tip — refresh after major sessions

## Notes on the kit

- **Built from real repo scan**, not guesses. Dev port is 3000 (not 5173), fonts are DM Sans + DM Serif (not Fraunces + Inter), design tokens use `teal-*` / `gold-*` scales (not custom `vida-*` names).
- **Named exports** on pages are required for the lazy-load pattern in `App.tsx`. Rule 03 enforces this.
- **No test runner, form library, clsx** acknowledged; don't pretend they're there.
- **Known tech debt flagged** (duplicate CSS, orphan `Home.tsx`, duplicate `MarketingLayout`) — so Cursor doesn't try to "clean up" known issues.
