import 'dotenv/config';

// Firebase must be initialized before importing any module that uses it
import './lib/firebase';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { redis } from './lib/redis';
import { notificationWorker } from './workers/notificationWorker';
import { db } from './lib/firebase';
import { Queue } from 'bullmq';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const START_TIME = Date.now();

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

const PORT = Number(process.env.PORT ?? 3003);
app.listen(PORT, () =>
  console.log(`[notification-service] Listening on port ${PORT}`),
);
