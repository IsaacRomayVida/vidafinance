import 'dotenv/config';

// Firebase must be initialized before any module that uses it
import './lib/firebase';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import axios from 'axios';

import { redis } from './lib/redis';
import { internalRouter } from './routes/internal';
import { webhooksRouter } from './routes/webhooks';
import { paymentLinksRouter } from './routes/paymentLinks';
import { disbursementWorker, startRawQueuePoller } from './workers/disbursementWorker';

const app = express();

app.use(helmet());

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'https://vida-finance.web.app').split(',').map((s) => s.trim());
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow internal calls (no origin) and explicitly allowed origins
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'x-internal-secret'],
  }),
);

// Webhooks need raw body for signature verification
app.use('/webhooks', express.raw({ type: 'application/json', limit: '10kb' }));
app.use(express.json({ limit: '100kb' }));

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/internal', internalRouter);
app.use('/webhooks', webhooksRouter);
app.use('/payment-links', paymentLinksRouter);

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  let redisOk = false;
  let stpOk = false;

  try {
    await redis.ping();
    redisOk = true;
  } catch {
    // degraded but still running
  }

  try {
    const stpUrl = process.env.STP_API_URL ?? 'https://demo.stpmex.com:7002';
    await axios.get(`${stpUrl}/`, { timeout: 5_000 });
    stpOk = true;
  } catch {
    // STP may be unreachable in sandbox; not fatal
  }

  const status = redisOk ? 'ok' : 'degraded';
  res.status(redisOk ? 200 : 503).json({
    status,
    service: 'vida-payment-server',
    redis: redisOk,
    stp: stpOk,
    worker: disbursementWorker.isRunning(),
    ts: new Date().toISOString(),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);

app.listen(PORT, () => {
  console.log(`[payment-server] Listening on port ${PORT}`);
  // Start the raw Redis list poller for jobs:disbursements
  startRawQueuePoller().catch((err) =>
    console.error('[payment-server] Failed to start raw queue poller:', err),
  );
});
