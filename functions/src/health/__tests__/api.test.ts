/**
 * `health/api.ts` is the plain HTTP health endpoint (distinct from the
 * scheduled system/queue health sweeps under `src/scheduled/`). It is a tiny
 * router with exactly two branches — `/api/health` and everything else — but
 * had zero coverage, so nothing pinned either branch or the response shape
 * monitoring depends on.
 *
 * `onRequest` is mocked via the shared `__mocks__/firebase-functions/v2/https.ts`
 * (wired through jest.config.js moduleNameMapper) to return the handler
 * as-is, so `api` here is the real async (req, res) => {} function.
 */
import { api } from '../api';

type FakeResponse = {
  status: jest.Mock;
  json: jest.Mock;
};

function makeRes(): FakeResponse {
  const res = {} as FakeResponse;
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

async function callApi(path: string, res: FakeResponse): Promise<void> {
  await (api as unknown as (req: { path: string }, res: FakeResponse) => Promise<void>)(
    { path },
    res
  );
}

describe('health/api', () => {
  it('reports ok with the service name and a real ISO timestamp on /api/health', async () => {
    const res = makeRes();

    await callApi('/api/health', res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0]?.[0] as { status: string; service: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('vida-finance');
    // Round-tripping through Date must reproduce the same string — proves
    // it's a real ISO-8601 timestamp, not just some string.
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('returns 404 with an error body for an unknown path', async () => {
    const res = makeRes();

    await callApi('/api/whatever', res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
  });

  it('returns 404 for the bare root path — it does not fall through to health data', async () => {
    const res = makeRes();

    await callApi('/', res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
  });

  it('treats the path as an exact match — a health-like prefix still 404s', async () => {
    const res = makeRes();

    await callApi('/api/health/extra', res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
