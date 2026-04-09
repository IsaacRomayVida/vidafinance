import IORedis from 'ioredis';

let _redis: IORedis | null = null;

export function getRedis(): IORedis {
  if (!_redis) {
    const url = process.env['REDIS_URL'] ?? '';
    if (!url) throw new Error('REDIS_URL not configured — skipping Redis');
    _redis = new IORedis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      tls: url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    });
    _redis.on('error', () => {}); // suppress unhandled error events
  }
  return _redis;
}
