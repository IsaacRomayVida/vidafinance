# Cursor Agent Git Instructions

## ALWAYS follow this flow for every task:

1. **Create a branch**: `git checkout -b cursor/VID-XX-short-description`
2. **Make changes**
3. **Stage and commit**: `git add -A && git commit -m "feat: description [VID-XX]"`
4. **Push**: `git push -u origin cursor/VID-XX-short-description`
5. **Open PR**: `gh pr create --base develop --title "VID-XX: description" --body "Closes VID-XX"`
6. **Never push directly to `develop` or `main`**
7. **After PR is merged**: pull latest develop — `git checkout develop && git pull`

## Commit message format:
- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — tooling, config, deps
- `test:` — adding tests
- `refactor:` — code restructure without feature change
- `docs:` — documentation only changes

## Branch naming:
- `cursor/VID-XX-short-description` — all Cursor agent branches
- `feature/short-description` — manual feature branches
- `fix/short-description` — manual bugfix branches

## Hard rules:
- **NEVER** push directly to `develop` or `main`
- **ALWAYS** create a PR, even for small changes
- **ALWAYS** include the Linear issue ID (e.g. `VID-28`) in the commit message and PR title
- **NEVER** include secrets, API keys, or credentials in commits
- Run `tsc --noEmit` before committing TypeScript changes

## Target branches:
- Feature work → `develop` (auto-deploys to Firebase staging + Railway staging on merge)
- Release → `main` (auto-deploys to Firebase production + Railway production on merge)
