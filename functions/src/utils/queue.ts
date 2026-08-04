import { Queue } from 'bullmq';

// Every call used to construct a brand-new Queue — and therefore a brand-new
// ioredis connection — with nothing ever closing it. getQueue() runs
// per-request inside long-lived warm Cloud Functions containers, so each
// request leaked one more open Redis connection for the container's life.
// A BullMQ Queue is a thin client safe to share across concurrent
// invocations of the same process, so memoize one per queue name instead.
const queues = new Map<string, Queue>();

// Must match services/shared/queues.js's worker-side defaults: without this,
// every job shipped as attempts:1, no backoff, never removed from Redis — a
// single transient send failure (Twilio 5xx, SendGrid 429) permanently
// dropped the notification with no retry.
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export function getQueue(name: string): Queue {
  const cached = queues.get(name);
  if (cached) return cached;

  const redisUrl = process.env['REDIS_URL'] ?? '';
  if (!redisUrl) throw new Error('REDIS_URL not configured — queue unavailable');

  const queue = new Queue(name, {
    connection: {
      url: redisUrl,
      ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    },
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  queues.set(name, queue);
  return queue;
}
