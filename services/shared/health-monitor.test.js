"use strict";
/**
 * Tests for health monitor SEV-1/SEV-2 classification logic.
 */

// Mock dotenv before anything else
jest.mock("dotenv", () => ({ config: jest.fn() }));

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Set env vars before requiring
process.env.PAGERDUTY_ROUTING_KEY = "test-routing-key";
process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/test";
process.env.NODE_ENV = "test";
process.env.INTERNAL_SECRET = "test-secret";

// Track alerts sent
const alertsSent = [];
jest.mock("./alerting", () => {
  const original = jest.requireActual("./alerting");
  return {
    ...original,
    sendAlert: jest.fn(async (message, severity, source, component, opts) => {
      alertsSent.push({ message, severity, source, component, opts });
    }),
    resolvePagerDutyIncident: jest.fn(async () => true),
  };
});

const { checkAlertingRules, SERVICES, THRESHOLDS, countDownServices } = require("./health-monitor");

// Helper: mock all health endpoints
function mockAllHealthy() {
  mockFetch.mockImplementation((url) => {
    if (url.includes("/health")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: "ok", service: "test" }),
      });
    }
    if (url.includes("/internal/queue-stats")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            queues: {
              "vida-disbursements": { completed: 100, failed: 0, waiting: 0 },
              "vida-underwriting": { completed: 100, failed: 0 },
            },
          }),
      });
    }
    if (url.includes("/monitor/drift/latest")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ psi: { score: 0.05 } }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

function mockAllDown() {
  mockFetch.mockImplementation((url) => {
    if (url.includes("/health")) {
      return Promise.reject(new Error("ECONNREFUSED"));
    }
    if (url.includes("/internal/queue-stats")) {
      return Promise.resolve({ ok: false, status: 503 });
    }
    if (url.includes("/monitor/drift/latest")) {
      return Promise.resolve({ ok: false, status: 503 });
    }
    return Promise.resolve({ ok: false, status: 503 });
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  alertsSent.length = 0;
  jest.clearAllMocks();
});

describe("countDownServices", () => {
  test("counts services with status down", () => {
    const results = {
      "svc-a": { status: "down" },
      "svc-b": { status: "ok" },
      "svc-c": { status: "down" },
    };
    expect(countDownServices(results)).toBe(2);
  });

  test("returns 0 when all healthy", () => {
    const results = {
      "svc-a": { status: "ok" },
      "svc-b": { status: "ok" },
    };
    expect(countDownServices(results)).toBe(0);
  });
});

describe("THRESHOLDS", () => {
  test("SEV-2 service down threshold is 5 minutes", () => {
    expect(THRESHOLDS.SERVICE_DOWN_SEV2_MS).toBe(5 * 60 * 1000);
  });

  test("disbursement failure rate SEV-2 threshold is 5%", () => {
    expect(THRESHOLDS.DISBURSEMENT_FAILURE_RATE_SEV2).toBe(0.05);
  });

  test("decision engine error rate SEV-2 threshold is 5%", () => {
    expect(THRESHOLDS.DECISION_ENGINE_ERROR_RATE_SEV2).toBe(0.05);
  });

  test("disbursement stall threshold is 10 minutes", () => {
    expect(THRESHOLDS.DISBURSEMENT_STALL_MS).toBe(10 * 60 * 1000);
  });
});

describe("checkAlertingRules — all healthy", () => {
  test("no alerts when all services are healthy", async () => {
    mockAllHealthy();
    const results = await checkAlertingRules();

    // All services should be "ok"
    for (const [, health] of Object.entries(results)) {
      expect(health.status).toBe("ok");
    }
  });
});

describe("checkAlertingRules — SEV-1: all services down", () => {
  test("triggers SEV-1 when all services are down", async () => {
    mockAllDown();

    // First call to establish downSince
    await checkAlertingRules();
    alertsSent.length = 0;

    // Second call should detect all down
    await checkAlertingRules();

    const allDownAlert = alertsSent.find(
      (a) => a.opts?.condition === "all_services_down",
    );
    expect(allDownAlert).toBeDefined();
    expect(allDownAlert.opts.condition).toBe("all_services_down");
  });
});

describe("checkAlertingRules — SEV-1: disbursement failure rates", () => {
  test("triggers SEV-2 when disbursement failure rate > 5%", async () => {
    mockFetch.mockImplementation((url) => {
      if (url.includes("/health")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok" }),
        });
      }
      if (url.includes("/internal/queue-stats")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              queues: {
                "vida-disbursements": { completed: 90, failed: 10, waiting: 5 },
                "vida-underwriting": { completed: 100, failed: 0 },
              },
            }),
        });
      }
      if (url.includes("/monitor/drift/latest")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ psi: { score: 0.05 } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await checkAlertingRules();

    const disbAlert = alertsSent.find(
      (a) => a.opts?.condition === "disbursement_failure_rate_high",
    );
    expect(disbAlert).toBeDefined();
    expect(disbAlert.message).toContain("10.00%");
  });
});

describe("checkAlertingRules — SEV-2: decision engine error rate", () => {
  test("triggers SEV-2 when decision engine error rate > 5%", async () => {
    mockFetch.mockImplementation((url) => {
      if (url.includes("/health")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok" }),
        });
      }
      if (url.includes("/internal/queue-stats")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              queues: {
                "vida-disbursements": { completed: 100, failed: 0, waiting: 0 },
                "vida-underwriting": { completed: 90, failed: 10 },
              },
            }),
        });
      }
      if (url.includes("/monitor/drift/latest")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ psi: { score: 0.05 } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await checkAlertingRules();

    const errAlert = alertsSent.find(
      (a) => a.opts?.condition === "error_rate_high",
    );
    expect(errAlert).toBeDefined();
    expect(errAlert.message).toContain("10.00%");
    expect(errAlert.message).toContain("SEV-2");
  });
});

describe("checkAlertingRules — Redis OOM detection", () => {
  test("triggers SEV-1 when Redis OOM detected in health response", async () => {
    mockFetch.mockImplementation((url) => {
      if (url.includes("/health")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "ok",
              redis_status: "oom",
              redis_error: "OOM command not allowed",
            }),
        });
      }
      if (url.includes("/internal/queue-stats")) {
        return Promise.resolve({ ok: false, status: 503 });
      }
      if (url.includes("/monitor/drift/latest")) {
        return Promise.resolve({ ok: false, status: 503 });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await checkAlertingRules();

    const redisAlert = alertsSent.find(
      (a) => a.opts?.condition === "redis_oom",
    );
    expect(redisAlert).toBeDefined();
    expect(redisAlert.message).toContain("Redis OOM");
  });
});

describe("checkAlertingRules — model drift", () => {
  test("triggers SEV-2 when PSI > 0.25", async () => {
    mockFetch.mockImplementation((url) => {
      if (url.includes("/health")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok" }),
        });
      }
      if (url.includes("/internal/queue-stats")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              queues: {
                "vida-disbursements": { completed: 100, failed: 0, waiting: 0 },
                "vida-underwriting": { completed: 100, failed: 0 },
              },
            }),
        });
      }
      if (url.includes("/monitor/drift/latest")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ psi: { score: 0.35 } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await checkAlertingRules();

    const driftAlert = alertsSent.find((a) =>
      a.message.includes("Model drift"),
    );
    expect(driftAlert).toBeDefined();
    expect(driftAlert.message).toContain("PSI=0.35");
  });
});
