# VIDA Finance — Handover Documents

Drop these in `.cursor/handover/` when you install the kit. Anyone picking up the project (human or AI) reads these to get oriented.

## Read order

1. **HANDOVER.md** — 5-minute orientation. Start here.
2. **LAUNCH_CHECKLIST.md** — done, doing, left. Source of truth for launch state.
3. **PROVIDER_TRACKER.md** — every third-party, what to ask them, current status.
4. **FIRST_WEEK.md** — day-by-day plan for the next 7 days.
5. **DECISIONS.md** — architectural decisions already made. Don't re-open these.
6. **GLOSSARY.md** — VIDA-specific terms, acronyms, Mexican regulatory vocabulary.

## How to keep these current

All six docs are snapshots as of **2026-04-21**. They'll decay as work ships.

**After each significant change:**
- PR merged → update `LAUNCH_CHECKLIST.md` "Recent commits" and move the relevant checklist item
- Vendor response received → update `PROVIDER_TRACKER.md` status
- Architectural decision made → add entry to `DECISIONS.md` (use the template at the bottom of that file)
- Main tip bumped → update `HANDOVER.md` header + `cursor-config/rules/01-vida-project-context.md` + `cursor-config/context/CURRENT_STATE.md`

**Weekly:** re-read `FIRST_WEEK.md` (or whatever week you're in). If it's more than one week old, overwrite it with your current week's plan.

**At launch:** retire `FIRST_WEEK.md` and `LAUNCH_CHECKLIST.md` (archive to `handover/archive/`). Replace with a `POST_LAUNCH.md` with ongoing ops and a `v1.9_ROADMAP.md`.

## Who reads these

- **New human engineer joining the team:** start at HANDOVER.md, read all six in order
- **Cursor starting a new session on the repo:** `.cursor/rules/01-vida-project-context.md` references these; the rules direct Cursor to check here for specific topics
- **Cyrus picking up a ticket:** Linear ticket descriptions reference specific files here when context is needed
- **Counsel or vendor doing diligence:** give them HANDOVER.md + relevant sections of DECISIONS.md
- **Future-you after a 2-week vacation:** LAUNCH_CHECKLIST.md first, then FIRST_WEEK.md of the current week
