import IORedis from 'ioredis';

const redis = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith('rediss://')
    ? { rejectUnauthorized: false }
    : undefined,
  lazyConnect: true,
});

redis.on('error', (err: Error) => {
  console.error('[redis] connection error:', err.message);
});

export default redis;
