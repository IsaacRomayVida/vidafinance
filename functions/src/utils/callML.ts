import fetch from 'node-fetch';

export async function callML(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = process.env['ML_SERVICE_URL'];
  if (!url) throw new Error('ML_SERVICE_URL not configured');
  const r = await fetch(url + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '',
    },
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signal: (AbortSignal as any).timeout(8000),
  });
  if (!r.ok) throw new Error(`ML ${path}: ${r.status}`);
  return r.json() as Promise<Record<string, unknown>>;
}
