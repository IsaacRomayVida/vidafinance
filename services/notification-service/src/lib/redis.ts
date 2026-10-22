import IORedis from 'ioredis';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is required');

export const redis = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: process.env['REDIS_TLS_ALLOW_UNVERIFIED'] !== 'true' } : undefined,
});
