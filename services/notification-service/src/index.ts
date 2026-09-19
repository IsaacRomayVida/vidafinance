import 'dotenv/config';

// Firebase must be initialized before importing any module that uses it
import './lib/firebase';

import express, { ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import { redis } from './lib/redis';
import { notificationWorker } from './workers/notificationWorker';
import { db } from './lib/firebase';
import { Queue } from 'bullmq';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const START_TIME = Date.now();

const log = pino({ name: 'vida-notification-service', level: process.env.LOG_LEVEL || 'info', formatters: { level: (label) => ({ level: label }) } });

const app = express();
app.use(helmet());
app.use(cors({ origin: ['https://vida-finance.web.app', 'https://employer.vida.finance'] }));
app.use(express.json({ limit: '100kb' }));

app.get('/health', async (_req, res) => {
  let redisOk = false;
  try {
    await redis.ping();
    redisOk = true;
  } catch (_) {
    // Redis down — degraded but still running
  }

  let firestoreOk = false;
  try { await db.collection('_health').limit(1).get(); firestoreOk = true; } catch (_) {}

  // Queue depth
  const queueDepth: Record<string, number> = {};
  try {
    const q = new Queue('vida-notifications', { connection: redis });
    queueDepth.notifications = await q.getWaitingCount();
    await q.close();
  } catch (_) { queueDepth.notifications = -1; }

  const down = !redisOk && !firestoreOk;
  const degraded = !redisOk || !firestoreOk;
  res.json({
    status: down ? 'down' : degraded ? 'degraded' : 'ok',
    service: 'vida-notification-service',
    version: pkg.version,
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    redis: redisOk,
    firestore: firestoreOk,
    worker: notificationWorker.isRunning(),
    queue_depth: queueDepth,
    ts: new Date().toISOString(),
  });
});

// ── Global error handler (crash safety net) ──────────────────────────
// Catches anything thrown/rejected inside a route handler that wasn't
// already caught by its own try/catch. Must be registered after every
// route above. Never leak err.message/stack to the client.
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  log.error(
    { error: err instanceof Error ? err.message : String(err), service: 'notification-service' },
    'Unhandled request error',
  );
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

// ── Process-level crash safety net ───────────────────────────────────
// Anything thrown or rejected outside of Express's request/response cycle
// (the BullMQ worker, a stray promise, a timer callback, etc.) would
// otherwise kill the process with no log line at all.
process.on('unhandledRejection', (reason) => {
  log.error(
    { error: reason instanceof Error ? reason.message : String(reason), service: 'notification-service' },
    'Unhandled rejection',
  );
});

process.on('uncaughtException', (err) => {
  log.error({ error: err.message, service: 'notification-service' }, 'Uncaught exception');
  // Railway restarts the container -- continuing after a truly uncaught
  // exception risks running in a corrupted state, so exit rather than
  // trying to carry on.
  process.exit(1);
});

const PORT = Number(process.env.PORT ?? 3003);
app.listen(PORT, () =>
  log.info({ port: PORT }, 'vida-notification-service started'),
);
