"use strict";
const IORedis = require("ioredis");

// This client is the *cache* in front of the SAT/DENUE/REPSE lookups
// (employer-a.js, sat-blacklist-client.js, sw-client.js, gov-apis.js). Every
// read treats it as optional — the pattern is always
// `await redis.get(k).catch(() => null)` — so a Redis outage is supposed to
// degrade into an uncached lookup.
//
// It could not. The options below used to read:
//
//     new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, ... })
//
// `maxRetriesPerRequest: null` is the setting BullMQ requires for its blocking
// commands, and it was copied onto this general-purpose cache client. Combined
// with ioredis's default `enableOfflineQueue: true` it means: while the
// connection is down, commands are queued, and because the per-request retry
// limit is disabled they are never flushed with an error. `redis.get()` returns
// a promise that neither resolves nor rejects, for as long as Redis stays
// unreachable. The `.catch(() => null)` fallback can never run.
//
// The consequence in production is not a slow cache, it is a hung service:
// `POST /underwrite` awaits employer-a.js:48, which awaits a promise that will
// not settle, so the request never gets a response and the worker is consumed.
// index.js registers `alertRedisLost` on this connection, so losing Redis was
// understood to be survivable — with these options it was not.
//
// The three settings below make an unreachable Redis fail fast instead:
//   - enableOfflineQueue: false  — reject immediately rather than queue while down
//   - maxRetriesPerRequest: 2    — a finite limit, so queued commands get flushed
//   - commandTimeout: 2000       — a backstop for a connected-but-wedged server
// All three produce a rejected promise instead of a pending one.
//
// Every `get` already has `.catch(() => null)` and is unaffected. The cache
// *writes* are not uniformly guarded: employer-a.js:166 catches, but
// gov-apis.js:45/99/122/149 and sw-client.js:46/82/115 `await redis.set(...)`
// bare, so during an outage those now reject where they previously hung. That
// is still the better failure — employer-a.js wraps every gov-apis call in
// `Promise.allSettled` (employer-a.js:73), so a rejected cache write surfaces as
// that check being recorded skipped and escalated to manual review, which is the
// documented "on provider error: escalate, never default to pass" behaviour.
// A hung write had no such path; it stalled the request. Tightening those bare
// writes into explicit `.catch(() => {})` is worth doing on its own, but it is a
// change to four other modules and is deliberately not bundled here.
//
// Do NOT reuse this client for BullMQ; a queue connection needs
// `maxRetriesPerRequest: null` and must construct its own. Nothing does today —
// index.js:29 builds a separate connection for that.
const redis = new IORedis(process.env.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 2,
  commandTimeout: 2000,
  tls: process.env.REDIS_URL?.startsWith("rediss://")
    ? { rejectUnauthorized: false }
    : undefined,
});

// Without a listener ioredis escalates connection errors to an unhandled 'error'
// event. The call sites already treat cache failure as non-fatal, so swallow it
// here — index.js attaches its own `alertRedisLost` reporter to its connection.
redis.on("error", () => {});

module.exports = redis;
