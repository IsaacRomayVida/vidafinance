import { Router } from 'express';
import redis from '../lib/redis';

const router = Router();

router.get('/health', async (_req, res) => {
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  res.status(redisOk ? 200 : 503).json({
    status: redisOk ? 'ok' : 'degraded',
    service: 'vida-softcredito-adapter',
    redis: redisOk ? 'ok' : 'error',
    timestamp: new Date().toISOString(),
  });
});

export default router;
