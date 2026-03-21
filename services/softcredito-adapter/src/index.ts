import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import pino from 'pino';

import healthRouter from './routes/health';
import curpRouter from './routes/curp';
import bureauRouter from './routes/bureau';
import internalRouter from './routes/internal';

const log = pino({ name: 'vida-softcredito-adapter', level: process.env.LOG_LEVEL || 'info', formatters: { level: (label) => ({ level: label }) } });

const ALLOWED_ORIGINS = ['https://vida-finance.web.app'];

const app = express();
app.use(helmet());

// CORS — only allow internal and known frontend origins
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-internal-secret');
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: '100kb' }));

// Routes
app.use(healthRouter);
app.use(curpRouter);
app.use(bureauRouter);
app.use(internalRouter);

const PORT = parseInt(process.env.PORT ?? '3002', 10);
app.listen(PORT, () => {
  log.info({ port: PORT }, 'vida-softcredito-adapter started');
});

export default app;
