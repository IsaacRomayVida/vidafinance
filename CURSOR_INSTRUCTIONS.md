# Cursor Agent Git Instructions

Every Cursor agent working in this repo MUST follow this flow for every task, without exception.

---

## The Full Flow

```
1. Create a branch
2. Make changes
3. Commit and push
4. Open a PR targeting develop
5. CI runs and auto-merge fires (for cursor/* branches)
6. develop auto-deploys to Firebase staging
```

---

## Step-by-Step

### 1. Create a feature branch

```bash
git checkout develop && git pull origin develop
git checkout -b cursor/VID-XX-short-description
```

Replace `XX` with the Linear issue number and `short-description` with a 2-5 word kebab-case summary.

### 2. Make your changes

Work on the task. Keep changes focused and scoped to the issue.

### 3. Stage, commit, and push

```bash
git add -A
git commit -m "feat: description of what was done [VID-XX]"
git push -u origin cursor/VID-XX-short-description
```

Commit message prefix conventions:
- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — tooling, config, dependencies
- `test:` — adding or updating tests
- `refactor:` — code restructure without feature change
- `docs:` — documentation only

### 4. Open a Pull Request

```bash
gh pr create \
  --base develop \
  --title "VID-XX: Short description of change" \
  --body "Closes VID-XX

## Changes
- List key changes here

## Testing
- [ ] Unit tests pass
- [ ] TypeScript builds clean"
```

### 5. Let CI handle the rest

- CI runs lint + typecheck + unit tests automatically
- If the branch starts with `cursor/`, the PR is auto-approved and auto-merged into `develop` once tests pass
- After merge, `develop` auto-deploys to Firebase staging

### 6. After merge, sync your local develop

```bash
git checkout develop && git pull origin develop
```

---

## Hard Rules

| Rule | Detail |
|------|--------|
| Never push directly to `develop` | Always use a `cursor/` branch + PR |
| Never push directly to `main` | `main` is only updated via PR from `develop` |
| Always reference the Linear ticket | Include `[VID-XX]` in every commit message |
| One issue = one branch | Don't mix multiple issues on one branch |
| Keep commits small and focused | Easier to review and revert if needed |

---

## Branch Naming

```
cursor/VID-{number}-{short-description}
```

Examples:
- `cursor/VID-28-git-flow-setup`
- `cursor/VID-12-loan-request-function`
- `cursor/VID-34-fix-auth-middleware`

---

## Secrets Reference

All secrets are stored in GitHub Actions and Cursor Secrets. Never hardcode secrets.
See `.env.example` for required environment variables for local development.

| Secret | Used For |
|--------|----------|
| `FIREBASE_TOKEN` | Firebase CLI deployments |
| `FIREBASE_PROJECT_ID_STAGING` | Staging Firebase project |
| `FIREBASE_PROJECT_ID_PRODUCTION` | Production Firebase project |
| `RAILWAY_TOKEN_STAGING` | Railway staging deploys |
| `RAILWAY_TOKEN` | Railway production deploys |
| `REDIS_URL` | Redis connection |
| `CONEKTA_API_KEY` | Conekta payment processing |
| `INTERNAL_SECRET` | Internal service auth |
| `SLACK_WEBHOOK_URL` | Slack deploy notifications |
