import { Queue } from 'bullmq';

const redisUrl = process.env.REDIS_URL ?? '';
const bullConnection = {
  url: redisUrl,
  ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
};

/**
 * BullMQ `disbursements` queue with 3 retries and exponential backoff.
 */
export const disbursementsQueue = new Queue('vida-disbursements', {
  connection: bullConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
  },
});
