# Railway project audit — `vida-backend` vs `observant-miracle`

Last reviewed: 2026-04-24 · Owner: Isaac

## TL;DR

Do **not** archive `vida-backend` yet. It looks like a partially-completed migration from `observant-miracle` (the active production project) that stalled on a failed deploy on 2026-04-22. Resolve that first.

## Current state

You have two Railway projects that overlap in service names:

| Service | `observant-miracle` (current prod) | `vida-backend` |
|---|---|---|
| `underwriting-service` | live, healthy, receives traffic | does not exist |
| `ml-service` | live, `ML_MODE=manual_review_all`, configured | stub: 0 non-Railway env vars, public domain exists (`ml-service-production-6ef1.up.railway.app`) but unconfigured |
| `softcredito-adapter` | live | stub: 1 non-Railway var, public domain exists |
| `payment-server` | live | **16 env vars set, domain `payment-server-production-91c7.up.railway.app`, last deploy FAILED 2026-04-22 00:58:43** |
| `pdf-generator` | live | **14 env vars set, domain `pdf-generator-production-d112.up.railway.app`, last deploy FAILED 2026-04-22 00:58:43** |
| `notification-service` | live | **19 env vars set, domain `notification-service-production-ca2a.up.railway.app`, last deploy FAILED 2026-04-22 00:58:42** |
| `reconciler` | does not exist | **16 env vars, last deploy FAILED 2026-04-22 00:58:42** |
| `booking-engine` | does not exist | **15 env vars, domain exists, last deploy FAILED 2026-04-22 00:58:43** |

Note the timestamps — all six FAILED deploys in `vida-backend` happened inside the same 2-second window on 2026-04-22. That is a pattern characteristic of a scripted / workflow-driven redeploy-all, not independent accidental usage.

## Interpretation

Three possibilities:

1. **Stalled migration**: someone (human or CI) was attempting to move production from `observant-miracle` to `vida-backend`, the deploy failed, and nothing has been touched since. Archiving `vida-backend` here destroys the staging state of that migration.
2. **Parallel product**: `booking-engine` + `reconciler` don't exist in `observant-miracle` at all. `vida-backend` may be hosting a different product (or a superset). Archiving deletes product code.
3. **Abandoned experiment**: the 2026-04-22 deploy was intentional but failed, and you've since decided not to migrate. In that case archive is safe — but you should confirm.

Until you (Isaac) identify which of the three is true, do not archive.

## Suggested next step (on your end, not engineering)

Check with yourself or whoever attempted the 2026-04-22 deploy:

- Was it a planned migration that should be resumed?
- Or an abandoned experiment that's safe to archive?

Once answered, either:
- **Resume the migration** — debug the FAILED deploys (`railway logs --service <name>` from inside vida-backend) and cut over services one at a time.
- **Archive** — Railway dashboard → vida-backend → Settings → Danger → Delete Project. Do this from the UI; the Railway CLI/MCP don't expose a delete-project action today.

## Related

- `observant-miracle` is the source of truth for production today. All env vars and the current deploys live there.
- No code in this repository explicitly references `vida-backend`; all deploy workflows (`.github/workflows/*.yml`) target services by name, so they would pick whichever project the Railway GitHub App is linked to.
