import 'dotenv/config';
import express from 'express';

import { securityHeaders } from './middleware/security';
import { corsMiddleware } from './middleware/cors';
import { generalLimiter, webhookLimiter } from './middleware/rateLimit';
import healthRouter from './routes/health';
import curpRouter from './routes/curp';
import rfcRouter from './routes/rfc';
import bureauRouter from './routes/bureau';
import internalRouter from './routes/internal';

const app = express();
app.use(securityHeaders);
app.use(corsMiddleware);
app.options('*', corsMiddleware);
app.use(generalLimiter);
app.use('/webhooks', webhookLimiter);
app.use(express.json({ limit: '100kb' }));

// Routes
app.use(healthRouter);
app.use(curpRouter);
app.use(rfcRouter);
app.use(bureauRouter);
app.use(internalRouter);

const PORT = parseInt(process.env.PORT ?? '3002', 10);
app.listen(PORT, () => {
  console.log(`vida-softcredito-adapter listening on port ${PORT}`);
});

export default app;
