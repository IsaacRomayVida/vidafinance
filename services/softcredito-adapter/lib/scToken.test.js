"use strict";

const { EventEmitter } = require('events');
const https = require('https');

const { scTokenRawFromUrl } = require('./scToken');

function mockHttpsRequest({ statusCode, body, error, timeout }) {
  const captured = { options: null, writeCalls: [], ended: false };

  const spy = jest.spyOn(https, 'request').mockImplementation((options, cb) => {
    captured.options = options;

    const req = new EventEmitter();
    req.write = (chunk) => { captured.writeCalls.push(chunk); };
    req.end = () => { captured.ended = true; };
    req.destroy = (err) => { req.emit('error', err); };

    process.nextTick(() => {
      if (error) {
        req.emit('error', error);
        return;
      }
      if (timeout) {
        req.emit('timeout');
        return;
      }
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = {};
      cb(res);
      process.nextTick(() => {
        if (body) res.emit('data', body);
        res.emit('end');
      });
    });

    return req;
  });

  return { captured, spy };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('scTokenRawFromUrl', () => {
  const TOKEN_URL = 'https://softcredito.example/produccion/ALIADOSDECRED/app/api/oauth/token';
  const PRODUCT = 'prod-abc';
  const APP = 'app-xyz';

  test('preserves exact header casing on the wire', async () => {
    const { captured } = mockHttpsRequest({
      statusCode: 200,
      body: '{"success":true,"token":"jwt.eyJ","expires_in":900}',
    });

    await scTokenRawFromUrl(TOKEN_URL, { product: PRODUCT, application: APP });

    const headerKeys = Object.keys(captured.options.headers);
    expect(headerKeys).toContain('X-REST-PRODUCT');
    expect(headerKeys).toContain('X-REST-APPLICATION');
    expect(headerKeys).toContain('Content-Type');
    expect(headerKeys).toContain('Accept');
    expect(headerKeys).toContain('Content-Length');

    expect(captured.options.headers['X-REST-PRODUCT']).toBe(PRODUCT);
    expect(captured.options.headers['X-REST-APPLICATION']).toBe(APP);
    expect(captured.options.headers['Content-Type']).toBe('application/json');
    expect(captured.options.headers['Accept']).toBe('application/json');
    expect(captured.options.headers['Content-Length']).toBe('0');

    expect(captured.options.host).toBe('softcredito.example');
    expect(captured.options.method).toBe('POST');
    expect(captured.options.path).toBe('/produccion/ALIADOSDECRED/app/api/oauth/token');
  });

  test('2xx JSON response resolves parsed body', async () => {
    mockHttpsRequest({
      statusCode: 200,
      body: '{"success":true,"token":"jwt.eyJ","expires_in":900}',
    });

    const d = await scTokenRawFromUrl(TOKEN_URL, { product: PRODUCT, application: APP });
    expect(d).toEqual({ success: true, token: 'jwt.eyJ', expires_in: 900 });
  });

  test('non-2xx rejects with status + body preview', async () => {
    mockHttpsRequest({
      statusCode: 404,
      body: '<!DOCTYPE html><html><body>Apache 404 Not Found</body></html>',
    });

    await expect(
      scTokenRawFromUrl(TOKEN_URL, { product: PRODUCT, application: APP }),
    ).rejects.toThrow(/SC auth failed: 404 .*Apache 404 Not Found/);
  });

  test('2xx non-JSON body rejects with descriptive error', async () => {
    mockHttpsRequest({
      statusCode: 200,
      body: 'oops not json',
    });

    await expect(
      scTokenRawFromUrl(TOKEN_URL, { product: PRODUCT, application: APP }),
    ).rejects.toThrow(/SC auth non-JSON response: oops not json/);
  });

  test('missing tokenUrl rejects', async () => {
    await expect(
      scTokenRawFromUrl(undefined, { product: PRODUCT, application: APP }),
    ).rejects.toThrow(/SOFTCREDITO_TOKEN_URL not set/);
  });

  test('invalid tokenUrl rejects', async () => {
    await expect(
      scTokenRawFromUrl('not-a-url', { product: PRODUCT, application: APP }),
    ).rejects.toThrow(/SOFTCREDITO_TOKEN_URL invalid/);
  });

  test('socket error propagates as rejection', async () => {
    mockHttpsRequest({ error: new Error('ECONNRESET') });

    await expect(
      scTokenRawFromUrl(TOKEN_URL, { product: PRODUCT, application: APP }),
    ).rejects.toThrow(/ECONNRESET/);
  });

  test('timeout rejects with SC auth timeout', async () => {
    mockHttpsRequest({ timeout: true });

    await expect(
      scTokenRawFromUrl(TOKEN_URL, { product: PRODUCT, application: APP }),
    ).rejects.toThrow(/SC auth timeout/);
  });
});
