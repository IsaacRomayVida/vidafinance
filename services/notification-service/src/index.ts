import 'dotenv/config';

// Firebase must be initialized before importing any module that uses it
import './lib/firebase';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import { redis } from './lib/redis';
import { notificationWorker } from './workers/notificationWorker';

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
  res.json({
    status: redisOk ? 'ok' : 'degraded',
    service: 'vida-notification-service',
    redis: redisOk,
    worker: notificationWorker.isRunning(),
  });
});

const PORT = Number(process.env.PORT ?? 3003);
app.listen(PORT, () =>
  log.info({ port: PORT }, 'vida-notification-service started'),
);
