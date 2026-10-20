<!-- © Suena AG / FunPay Technologies. All rights reserved. -->
# Security and supply-chain pipeline

Everything here is GitHub Actions under `.github/`. No security job deploys
anything. Every action is pinned to a full commit SHA with the version in a
comment; Dependabot keeps the pins current. Each job starts with
`step-security/harden-runner` in audit mode, declares its own least-privilege
`permissions:`, has a timeout, and sits in a concurrency group. Values from
`github.event.*` reach shell steps only through `env:`.

## Layout covered

Root, `functions/`, `public-v2/`, `mobile/` (including `mobile/qa-demo/functions`),
`db/registry/`, the Node services under `services/*` and the Python service
`services/ml-service`, plus every `services/*/Dockerfile`.

## What blocks a merge

A check blocks only if it is a **required status check** on `main`. Register
the ones you want in the branch protection settings; a workflow that is not
listed can fail and still merge.

| Check | Workflow | Fails when |
|---|---|---|
| Semgrep CE (PRs) | `security.yml` | the PR introduces a new ERROR-severity finding (baseline against the PR base) |
| Gitleaks (full history) | `security.yml` | any secret pattern in any commit in the full history that is not allowlisted |
| TruffleHog (verified only) | `security.yml` | a secret that the provider confirms is **live** |
| OSV-Scanner | `security.yml` | a dependency with a critical or high vulnerability (CVSS 7.0 or more) |
| Trivy filesystem | `security.yml` | a critical/high vulnerability with a fix available, a secret, or a critical/high misconfiguration |
| Trivy Dockerfile (one per service) | `security.yml` | a critical/high Dockerfile misconfiguration |
| CodeQL | `codeql.yml` | runs only when the repo variable `CODEQL_ENABLED` is `true` |

Report-only (never fail a run): Semgrep on `main` and the weekly run, OpenSSF
Scorecard.

## The tools

**Semgrep CE.** Rule sets: OWASP Top Ten, TypeScript, nodejsscan, React,
secrets, Dockerfile, GitHub Actions. Test files are skipped. Metrics are off.
On PRs it compares against the base commit, so existing findings do not block
unrelated work; on `main` and the weekly run it reports everything.

**Gitleaks.** Regex and entropy scan of the full git history (checkout depth
0), redacted output, binary downloaded with a pinned SHA-256. Config:
`.gitleaks.toml`.

**TruffleHog.** Detects credentials and tests them against the provider.
Verified-only means a hit is a working credential, so it is safe to block on.
PRs scan the commits they add; `main` and the weekly run scan everything.

**OSV-Scanner.** Scans every lockfile and `requirements*.txt` recursively and
matches them against the OSV database. It has no severity flag, so
`.github/scripts/osv-gate.py` applies the critical/high rule to the JSON report.
Reviewed exceptions come from `osv-scanner.toml` when that file exists.

**Trivy.** One filesystem scan of the repository (vulnerabilities, secrets,
misconfiguration), plus a config scan of each service Dockerfile
(`ml-service`, `notification-service`, `payment-server`, `pdf-generator`,
`registry-service`, `softcredito-adapter`, `underwriting-service`). A new
service needs adding to the matrix in `security.yml`.

**CodeQL.** `javascript-typescript` and `python`, security-extended queries.
Needs GitHub Advanced Security on a private repo, so the job is skipped unless
the repository variable `CODEQL_ENABLED` is `true`. The same variable switches
on the SARIF uploads to the Security tab.

**OpenSSF Scorecard.** Scores repo practice (branch protection, pinned
dependencies, token permissions, review). `publish_results` is `false`: nothing
is sent to the public OpenSSF API.

**Dependabot.** Weekly, Monday 06:00 Mexico City: npm for each package
directory, pip for `services/ml-service`, GitHub Actions and the service
Dockerfiles. Minor and patch updates are grouped into one PR per area; majors
are separate PRs. Node runtime majors (the `node` image, `@types/node`) are
ignored: the Node line moves only in a deliberate, reviewed change.

**Hardened CI.** `ci.yml`, `mobile-ci.yml` and `e2e-smoke.yml` follow the same
rules as the security jobs (pinned SHAs, harden-runner, read-only token,
timeouts, concurrency).

## Reading results

- **Actions tab**: each job is one tool. Failed Semgrep, OSV and Gitleaks jobs
  print the finding in the log with file and rule or advisory id.
- **Artifacts**: every scanner keeps its SARIF or JSON for 30 days. SARIF opens
  in VS Code with the SARIF Viewer extension.
- **Security tab**: populated only when `CODEQL_ENABLED=true`.

Typical failures and what to do:

| Failure | First step |
|---|---|
| OSV: `package@version` with an advisory id | Upgrade the package (or its parent) in the named lockfile. If no fix exists, add a reviewed exception. |
| Trivy filesystem: CVE | Same as OSV; Trivy ignores unfixed issues. |
| Trivy Dockerfile: DS-0002 | Add a non-root `USER` to the Dockerfile. |
| Semgrep: rule id and line | Fix the code. If it is a false positive, suppress at the source (below). |
| Gitleaks: rule and commit | Rotate the credential first, then allowlist only if it was never a real secret. A real secret in history needs rotation, not an ignore. |
| TruffleHog verified | The credential is live. Rotate it immediately. |

## Adding an ignore (reason and expiry required)

Never silence a verified secret: rotate it. For anything else, an ignore must
carry a reason and, where the tool supports it, an expiry date, and must be
reviewed in the PR.

- **OSV** (`osv-scanner.toml`): add an entry; once the date passes the finding
  blocks again.

  ```toml
  [[IgnoredVulns]]
  id = "GHSA-xxxx-xxxx-xxxx"
  ignoreUntil = 2026-12-18
  reason = "Why it is not exploitable here, who reviewed it, what to re-check."
  ```

- **Gitleaks** (`.gitleaks.toml`): add a narrow `[[allowlists]]` entry (one
  exact path or one exact value, with `targetRules`) and a comment saying why
  it is not a credential and when it was reviewed.
- **Semgrep**: put `// nosemgrep: rule-id` on the line, with a comment giving
  the reason.
- **Trivy**: add the id to a `.trivyignore` entry with a comment holding the
  reason and an `exp:YYYY-MM-DD` expiry.

## Repository settings and paid features

| Need | For |
|---|---|
| GitHub Advanced Security (private repos) | CodeQL, and the Security tab for SARIF uploads |
| Repo variable `CODEQL_ENABLED=true` | turns on CodeQL and the SARIF uploads |
| Required status checks on `main` | making any of the above block a merge |
| Public repo | publishing the Scorecard result |
| Dependabot alerts and security updates (Settings > Code security) | CVE-driven PRs |
