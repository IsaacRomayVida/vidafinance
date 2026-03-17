import 'dotenv/config';

import './lib/firebase';

import express from 'express';
import { redis } from './lib/redis';
import { payrollWorker } from './workers/payrollWorker';
import { securityHeaders } from './middleware/security';
import { generalLimiter } from './middleware/rateLimit';
import { internalRouter } from './routes/internal';
import cors from 'cors';

const app = express();
app.use(securityHeaders);
app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }));
app.options('*', cors());
app.use(generalLimiter);
app.use(express.json({ limit: '1mb' }));

app.use('/internal', internalRouter);

app.get('/health', async (_req, res) => {
  let redisOk = false;
  try {
    await redis.ping();
    redisOk = true;
  } catch (_) {
    // Redis down — degraded
  }
  res.json({
    status: redisOk ? 'ok' : 'degraded',
    service: 'vida-payroll-service',
    redis: redisOk,
    worker: payrollWorker.isRunning(),
  });
});

const PORT = Number(process.env.PORT ?? 3006);
app.listen(PORT, () =>
  console.log(`[payroll-service] Listening on port ${PORT}`),
);
