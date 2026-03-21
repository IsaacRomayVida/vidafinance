import { Queue } from 'bullmq';

export function getQueue(name: string): Queue {
  const redisUrl = process.env['REDIS_URL'] ?? '';
  return new Queue(name, {
    connection: {
      url: redisUrl,
      ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    },
  });
}
