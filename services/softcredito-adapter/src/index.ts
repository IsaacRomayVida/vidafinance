import 'dotenv/config';
import express from 'express';

import { securityHeaders } from './middleware/security';
import { corsMiddleware } from './middleware/cors';
import { generalLimiter, webhookLimiter, verificationLimiter, financialLimiter } from './middleware/rateLimit';
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

// Routes — external verification endpoints (paid API calls) use a stricter limiter
app.use('/curp', verificationLimiter);
app.use('/rfc', verificationLimiter);
app.use('/bureau', verificationLimiter);
app.use('/internal/disburse', financialLimiter);
app.use('/internal/register-deduction', financialLimiter);

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
