import fetch from 'node-fetch';

// Shadow-write only (Phase A): best-effort call to registry-service. The
// caller decides whether a failure here should be swallowed -- this module
// just makes the call and throws on non-2xx, same contract as callML().

export interface ResolveEntityInput {
  system: string;
  externalId: string;
  kind: string;
  displayName?: string | null;
  attrs?: Record<string, unknown>;
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
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`registry resolve ${input.system}:${input.externalId}: ${r.status}`);
  const body = (await r.json()) as { entityId: string };
  return body.entityId;
}

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
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`registry addRef ${system}:${externalId}: ${r.status}`);
}
