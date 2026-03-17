import { Queue } from 'bullmq';

// ── Shared BullMQ connection config ────────────────────────────────────────

function bullConnection() {
  const redisUrl = process.env.REDIS_URL ?? '';
  return {
    url: redisUrl,
    ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
  };
}

// ── Queue instances (lazy singletons) ──────────────────────────────────────

let _reconciliationQueue: Queue | null = null;

export function getReconciliationQueue(): Queue {
  if (_reconciliationQueue) return _reconciliationQueue;

  _reconciliationQueue = new Queue('vida-reconciliation', {
    connection: bullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
      attempts: 5,
      backoff: { type: 'fixed', delay: 2_000 },
    },
  });
  return _reconciliationQueue;
}
