import 'dotenv/config';

// Firebase must be initialized before importing any module that uses it
import './lib/firebase';

import express from 'express';
import { redis } from './lib/redis';
import { notificationWorker } from './workers/notificationWorker';
import { securityHeaders } from './middleware/security';
import { corsMiddleware } from './middleware/cors';
import { generalLimiter, webhookLimiter } from './middleware/rateLimit';
import { notificationsRouter } from './routes/notifications';
import { webhooksRouter } from './routes/webhooks';

const app = express();
app.use(securityHeaders);
app.use(corsMiddleware);
app.options('*', corsMiddleware);
app.use(generalLimiter);
app.use('/webhooks', webhookLimiter);
app.use(express.json({ limit: '100kb' }));

// Routes
app.use('/notifications', notificationsRouter);
app.use('/webhooks', webhooksRouter);

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
  console.log(`[notification-service] Listening on port ${PORT}`),
);
