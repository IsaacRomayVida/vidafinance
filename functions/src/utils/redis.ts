import IORedis from 'ioredis';

let _redis: IORedis | null = null;

export function getRedis(): IORedis {
  if (!_redis) {
    const url = process.env['REDIS_URL'] ?? '';
    _redis = new IORedis(url, {
      maxRetriesPerRequest: 3,
      tls: url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    });
  }
  return _redis;
}
