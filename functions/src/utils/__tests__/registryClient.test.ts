/**
 * `utils/registryClient.ts` is the shadow-write client to registry-service.
 * It had near-zero coverage: nothing pinned the "unconfigured URL fails
 * loudly rather than silently skipping the write" behaviour, the request
 * shape (internal-secret header, JSON body), or the non-2xx error message
 * callers match against.
 *
 * `fetch` is auto-mocked via the shared `__mocks__/node-fetch.ts`, wired
 * through jest.config.js moduleNameMapper for the bare `node-fetch`
 * specifier — no local jest.mock needed.
 */
import fetch from 'node-fetch';
import { addEntityRef, resolveEntity } from '../registryClient';

const mockFetch = fetch as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  process.env['REGISTRY_SERVICE_URL'] = 'https://registry.example.test';
  process.env['INTERNAL_SECRET'] = 'shh';
});

afterEach(() => {
  delete process.env['REGISTRY_SERVICE_URL'];
  delete process.env['INTERNAL_SECRET'];
});

describe('resolveEntity', () => {
  it('throws — rather than silently skipping the shadow-write — when REGISTRY_SERVICE_URL is not configured', async () => {
    delete process.env['REGISTRY_SERVICE_URL'];

    await expect(
      resolveEntity({ system: 'funpay', externalId: 'emp-1', kind: 'employee' })
    ).rejects.toThrow('REGISTRY_SERVICE_URL not configured');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('posts the resolve request with the internal-secret header and the full input body, and returns the entityId', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ entityId: 'ent-123' }) });

    const id = await resolveEntity({
      system: 'funpay',
      externalId: 'emp-1',
      kind: 'employee',
      displayName: 'Juan',
      refs: [{ system: 'softcredito', externalId: 'sc-1' }],
    });

    expect(id).toBe('ent-123');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://registry.example.test/internal/entities/resolve');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json', 'x-internal-secret': 'shh' });
    expect(JSON.parse(opts.body)).toEqual({
      system: 'funpay',
      externalId: 'emp-1',
      kind: 'employee',
      displayName: 'Juan',
      refs: [{ system: 'softcredito', externalId: 'sc-1' }],
    });
  });

  it('throws a descriptive error naming the entity and the HTTP status on a non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    await expect(
      resolveEntity({ system: 'funpay', externalId: 'emp-9', kind: 'employee' })
    ).rejects.toThrow('registry resolve funpay:emp-9: 503');
  });
});

describe('addEntityRef', () => {
  it('throws when REGISTRY_SERVICE_URL is not configured', async () => {
    delete process.env['REGISTRY_SERVICE_URL'];

    await expect(addEntityRef('ent-1', 'softcredito', 'sc-1')).rejects.toThrow(
      'REGISTRY_SERVICE_URL not configured'
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('posts to the entity-specific refs endpoint with system/externalId', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await addEntityRef('ent-1', 'softcredito', 'sc-1');

    const [url, opts] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('https://registry.example.test/internal/entities/ent-1/refs');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ system: 'softcredito', externalId: 'sc-1' });
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(addEntityRef('ent-1', 'softcredito', 'sc-1')).rejects.toThrow(
      'registry addRef softcredito:sc-1: 500'
    );
  });
});
