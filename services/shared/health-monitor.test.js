'use strict';

// Launch checklist v1.8:
//   D2 — underwriting-service (the credit decision) and registry-service (the
//        ledger) were absent from launch monitoring.
//   D4 — this long-running poller logged through console.*, so its output had
//        no service name or level and was not queryable during an incident.

const fs = require('fs');
const path = require('path');

const ORIGINAL_ENV = { ...process.env };

function freshMonitor() {
  jest.resetModules();
  jest.doMock('./alerting', () => ({ sendAlert: jest.fn(async () => {}) }));
  return require('./health-monitor');
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: 'ok' }) }));
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.restoreAllMocks();
});

describe('health-monitor coverage (D2)', () => {
  test('polls underwriting-service and registry-service /health alongside the other five', async () => {
    process.env.NODE_ENV = 'test';
    process.env.UNDERWRITING_SERVICE_URL = 'https://underwriting.example.test';
    process.env.REGISTRY_SERVICE_URL = 'https://registry.example.test';
    const { checkAlertingRules, SERVICE_DEFS } = freshMonitor();

    expect(SERVICE_DEFS).toHaveLength(7);
    const results = await checkAlertingRules();

    const urls = global.fetch.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://underwriting.example.test/health');
    expect(urls).toContain('https://registry.example.test/health');
    expect(results['vida-underwriting-service']).toMatchObject({ status: 'ok' });
    expect(results['vida-registry-service']).toMatchObject({ status: 'ok' });
  });
});

describe('health-monitor logging (D4)', () => {
  test('routes all output through the structured logger, never console.*', () => {
    const src = fs.readFileSync(path.join(__dirname, 'health-monitor.js'), 'utf8')
      .replace(/^\s*(\/\/|\*).*$/gm, '');
    expect(src).not.toMatch(/\bconsole\.\w+\(/);
  });
});
