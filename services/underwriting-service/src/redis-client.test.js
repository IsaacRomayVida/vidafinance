"use strict";
/**
 * redis-client — behaviour when Redis is unreachable.
 *
 * The one property that matters here is that commands SETTLE. Every cache read
 * in this service is written as `await redis.get(k).catch(() => null)`, which
 * only degrades gracefully if the promise rejects; a promise that stays pending
 * hangs the caller, and employer-a.js:48 is on the `POST /underwrite` path.
 *
 * This file talks to a real ioredis against a port with nothing on it, because
 * the defect it guards lives entirely in the connection options — a mocked
 * ioredis cannot exhibit it.
 *
 * It loads the REAL src/redis-client.js (with REDIS_URL pointed at the dead
 * port) rather than re-declaring the options inline. That distinction is the
 * whole point: a test that constructs its own IORedis with the fixed options
 * passes even if redis-client.js is reverted to the broken ones, so it guards
 * nothing. Only the last case below builds a client directly, and it does so
 * deliberately, as a control that the old options really do hang.
 */
const IORedis = require("ioredis");

// Nothing listens here. 6399 is outside the usual 6379/6380 range so a Redis
// running on the dev box does not turn this into a false pass.
const DEAD_URL = "redis://127.0.0.1:6399";
const SETTLE_BUDGET_MS = 5000;

/**
 * Resolve to the outcome of `promise`, or to "pending" if it outlives the budget.
 *
 * The budget timer is always cleared. Leaving it armed would keep the event loop
 * alive for the full budget after a fast rejection, and jest would report this
 * file as an open handle.
 */
async function settleWithin(promise, ms) {
  const pending = Symbol("pending");
  let timerId;
  const timer = new Promise((res) => { timerId = setTimeout(() => res(pending), ms); });
  try {
    // Map to a value rather than letting the race reject, so a rejection arriving
    // after the race is still considered handled.
    const outcome = await Promise.race([promise.then(
      (v) => ({ state: "resolved", value: v }),
      (e) => ({ state: "rejected", error: e }),
    ), timer]);
    return outcome === pending ? { state: "pending" } : outcome;
  } finally {
    clearTimeout(timerId);
  }
}

/** Load a fresh src/redis-client.js bound to the dead port. */
function loadRealClient() {
  let mod;
  jest.isolateModules(() => {
    mod = require("./redis-client");
  });
  return mod;
}

describe("redis-client against an unreachable Redis", () => {
  const realUrl = process.env.REDIS_URL;
  let client;

  beforeEach(() => {
    process.env.REDIS_URL = DEAD_URL;
  });

  afterEach(() => {
    if (client) client.disconnect();
    client = null;
    if (realUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = realUrl;
  });

  it("rejects get() rather than leaving it pending", async () => {
    client = loadRealClient();
    const outcome = await settleWithin(client.get("employer-a:ABC123456XY0"), SETTLE_BUDGET_MS);
    expect(outcome.state).toBe("rejected");
  });

  it("rejects set() rather than leaving it pending", async () => {
    client = loadRealClient();
    const outcome = await settleWithin(
      client.set("employer-a:ABC123456XY0", "{}", "EX", 86400),
      SETTLE_BUDGET_MS,
    );
    expect(outcome.state).toBe("rejected");
  });

  it("lets the .catch(() => null) fallback at employer-a.js:48 actually run", async () => {
    client = loadRealClient();
    // Verbatim the call-site pattern. A pending promise makes this line hang.
    const cached = await settleWithin(
      client.get("employer-a:ABC123456XY0").catch(() => null),
      SETTLE_BUDGET_MS,
    );
    expect(cached).toEqual({ state: "resolved", value: null });
  });

  it("attaches an error listener, so a connection failure is not an unhandled event", () => {
    client = loadRealClient();
    // Without this ioredis escalates connection errors into an unhandled 'error'
    // event, which crashes the process on some Node versions.
    expect(client.listenerCount("error")).toBeGreaterThan(0);
  });

  it("is the options, not ioredis, that make this work — the old ones hang", async () => {
    // Control case, and the only one that builds a client directly. This is the
    // configuration the module shipped before: `maxRetriesPerRequest: null` (a
    // BullMQ setting) on top of ioredis's default `enableOfflineQueue: true`.
    // Commands are queued while the connection is down and, with the per-request
    // retry limit disabled, never flushed with an error. If this case ever starts
    // failing, ioredis changed its behaviour and the comment in redis-client.js
    // needs redoing.
    client = new IORedis(DEAD_URL, { maxRetriesPerRequest: null });
    client.on("error", () => {});

    const outcome = await settleWithin(client.get("employer-a:ABC123456XY0"), SETTLE_BUDGET_MS);
    expect(outcome.state).toBe("pending");
  });
});
