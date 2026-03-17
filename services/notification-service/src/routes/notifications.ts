import { Router, Request, Response } from 'express';
import { Queue } from 'bullmq';
import { requireInternalSecret } from '../middleware/internalAuth';

const QUEUE_NAME = 'vida-notifications';
const redisUrl = process.env.REDIS_URL ?? '';
const bullConnection = {
  url: redisUrl,
  ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
};

const queue = new Queue(QUEUE_NAME, {
  connection: bullConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
  },
});

export const notificationsRouter = Router();

/**
 * POST /notifications/send
 * Enqueue a notification job via HTTP (for services without direct Redis access).
 * Protected by x-internal-secret header.
 *
 * Body: { type: string, ...jobData }
 */
notificationsRouter.post('/send', requireInternalSecret, async (req: Request, res: Response) => {
  const { type, ...rest } = req.body;
  if (!type || typeof type !== 'string') {
    res.status(400).json({ error: 'Missing required field: type' });
    return;
  }

  const job = await queue.add(type, { type, ...rest });
  res.status(202).json({ ok: true, jobId: job.id, type });
});
