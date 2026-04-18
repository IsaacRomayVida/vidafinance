'use strict';

// The shared metrics module pulls in prom-client from a location that isn't
// on the repo-root module resolution path during jest runs. Stub it out with
// a minimal registry-shaped object — the fallback module only calls
// getSingleMetric() and passes the register to prom-client.Counter's
// registers[] array, which tolerates any EventEmitter-ish object.
jest.mock('../../shared/metrics', () => {
  const registry = {
    _metrics: new Map(),
    getSingleMetric(name) { return this._metrics.get(name); },
    registerMetric(metric) { this._metrics.set(metric.name, metric); },
    getMetricsAsArray() { return Array.from(this._metrics.values()); },
  };
  return { register: registry };
});

const {
  parseBureauMode,
  synthesizeBureauResponse,
  classifyError,
  withBureauFallback,
  VALID_MODES,
  fallbackCounter,
} = require('./bureauFallback');

describe('parseBureauMode', () => {
  test('defaults to live when env var is missing', () => {
    expect(parseBureauMode(undefined)).toBe('live');
    expect(parseBureauMode('')).toBe('live');
    expect(parseBureauMode(null)).toBe('live');
  });

  test('accepts each valid mode, case-insensitive and trimmed', () => {
    expect(parseBureauMode('live')).toBe('live');
    expect(parseBureauMode('OPTIMISTIC')).toBe('optimistic');
    expect(parseBureauMode(' pessimistic ')).toBe('pessimistic');
    expect(parseBureauMode('Offline')).toBe('offline');
  });

  test('fails fast on unknown values', () => {
    expect(() => parseBureauMode('banana')).toThrow(/Invalid BUREAU_MODE="banana"/);
    expect(() => parseBureauMode('liveish')).toThrow(/Must be one of:/);
  });

  test('VALID_MODES lists the four documented modes', () => {
    expect(VALID_MODES).toEqual(['live', 'optimistic', 'pessimistic', 'offline']);
  });
});

describe('synthesizeBureauResponse', () => {
  test('optimistic synthesizes a clean record with manual-review flag', () => {
    const r = synthesizeBureauResponse('optimistic', 'network_error');
    expect(r.hasBureauRecord).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(700);
    expect(r.activeDefaults).toBe(0);
    expect(r.manualReviewRequired).toBe(true);
    expect(r._fallback.mode).toBe('optimistic');
    expect(r._fallback.reason).toBe('network_error');
    expect(r._fallback.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('pessimistic synthesizes a high-risk record', () => {
    const r = synthesizeBureauResponse('pessimistic', 'upstream_error_code');
    expect(r.hasBureauRecord).toBe(true);
    expect(r.score).toBeLessThan(500);
    expect(r.activeDefaults).toBeGreaterThan(0);
    expect(r._fallback.mode).toBe('pessimistic');
  });

  test('offline synthesizes a neutral record', () => {
    const r = synthesizeBureauResponse('offline', 'disabled_by_config');
    expect(r.hasBureauRecord).toBe(false);
    expect(r.score).toBe(500);
    expect(r._fallback.mode).toBe('offline');
    expect(r._fallback.reason).toBe('disabled_by_config');
  });
});

describe('classifyError', () => {
  test('network-level codes classify as network_error', () => {
    expect(classifyError({ code: 'ECONNREFUSED' })).toBe('network_error');
    expect(classifyError({ code: 'ENOTFOUND' })).toBe('network_error');
    expect(classifyError({ code: 'ECONNRESET' })).toBe('network_error');
  });

  test('timeouts classify as timeout', () => {
    expect(classifyError({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyError({ message: 'SC auth timeout after 10000ms' })).toBe('timeout');
  });

  test('SC API errors classify as upstream_error_code', () => {
    expect(classifyError({ message: 'SC API /bureau/query: {"error":"bad"}' })).toBe('upstream_error_code');
    expect(classifyError({ message: 'HTTP 502 Bad Gateway' })).toBe('upstream_error_code');
  });
});

describe('withBureauFallback', () => {
  test('live mode passes through the live response unchanged', async () => {
    const liveFn = jest.fn().mockResolvedValue({ score: 720, hasBureauRecord: true });
    const result = await withBureauFallback({ mode: 'live', liveFn });
    expect(liveFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ score: 720, hasBureauRecord: true });
    expect(result._fallback).toBeUndefined();
  });

  test('live mode propagates errors to the caller', async () => {
    const liveFn = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(withBureauFallback({ mode: 'live', liveFn })).rejects.toThrow('boom');
  });

  test('optimistic synthesizes a clean response on network failure', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const liveFn = jest.fn().mockRejectedValue(err);
    const warn = jest.fn();
    const result = await withBureauFallback({ mode: 'optimistic', liveFn, log: { warn } });
    expect(liveFn).toHaveBeenCalledTimes(1);
    expect(result._fallback.mode).toBe('optimistic');
    expect(result._fallback.reason).toBe('network_error');
    expect(result.hasBureauRecord).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('pessimistic synthesizes a high-risk response on upstream error_code', async () => {
    const liveFn = jest.fn().mockRejectedValue(new Error('SC API /bureau/query: {"error_code":"SC-42"}'));
    const result = await withBureauFallback({ mode: 'pessimistic', liveFn });
    expect(result._fallback.mode).toBe('pessimistic');
    expect(result._fallback.reason).toBe('upstream_error_code');
    expect(result.hasBureauRecord).toBe(true);
    expect(result.score).toBeLessThan(500);
  });

  test('offline never calls the live function', async () => {
    const liveFn = jest.fn();
    const result = await withBureauFallback({ mode: 'offline', liveFn });
    expect(liveFn).not.toHaveBeenCalled();
    expect(result._fallback.mode).toBe('offline');
    expect(result._fallback.reason).toBe('disabled_by_config');
  });

  test('optimistic returns the live response when the call succeeds', async () => {
    const liveFn = jest.fn().mockResolvedValue({ score: 680, hasBureauRecord: false });
    const result = await withBureauFallback({ mode: 'optimistic', liveFn });
    expect(result).toEqual({ score: 680, hasBureauRecord: false });
    expect(result._fallback).toBeUndefined();
  });
});
