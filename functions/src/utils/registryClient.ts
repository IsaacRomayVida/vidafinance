import fetch from 'node-fetch';

// Shadow-write only (Phase A): best-effort call to registry-service. The
// caller decides whether a failure here should be swallowed -- this module
// just makes the call and throws on non-2xx, same contract as callML().
//
// Timeout is 3s, not 8s: this is a same-Railway-project, co-located
// service call that should complete in well under a second in the healthy
// case. 8s per call meant a caller doing a resolve + a separate addRef
// (the old pattern) could add up to 16s of latency to an admin action
// before either shadow-write timed out -- 3s per call is still generous
// slack for a fast-fail, not a real budget for a slow network hop.
const REQUEST_TIMEOUT_MS = 3000;

export interface ResolveEntityInput {
  system: string;
  externalId: string;
  kind: string;
  displayName?: string | null;
  attrs?: Record<string, unknown>;
  // Additional external refs to attach to the same entity in the SAME
  // registry-service transaction as the resolve -- one round trip instead
  // of a resolve followed by N separate addEntityRef calls.
  refs?: Array<{ system: string; externalId: string }>;
}

export async function resolveEntity(input: ResolveEntityInput): Promise<string> {
  const url = process.env['REGISTRY_SERVICE_URL'];
  if (!url) throw new Error('REGISTRY_SERVICE_URL not configured');

  const r = await fetch(`${url}/internal/entities/resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`registry resolve ${input.system}:${input.externalId}: ${r.status}`);
  const body = (await r.json()) as { entityId: string };
  return body.entityId;
}

// Standalone ref attachment for cases that need to add a ref to an entity
// resolved in an earlier, separate call (e.g. a later Cloud Function
// attaching a new ref to an entity that already exists). Prefer
// `resolveEntity({ ..., refs: [...] })` when the entity and its refs are
// known together -- it's one round trip instead of two.
export async function addEntityRef(entityId: string, system: string, externalId: string): Promise<void> {
  const url = process.env['REGISTRY_SERVICE_URL'];
  if (!url) throw new Error('REGISTRY_SERVICE_URL not configured');

  const r = await fetch(`${url}/internal/entities/${entityId}/refs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '',
    },
    body: JSON.stringify({ system, externalId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`registry addRef ${system}:${externalId}: ${r.status}`);
}
