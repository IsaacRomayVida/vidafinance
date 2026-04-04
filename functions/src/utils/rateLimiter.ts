import { getRedis } from './redis';

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<boolean> {
  const redis = getRedis();
  const current = await redis.incr(key);
  if (current === 1) await redis.expire(key, windowSeconds);
  return current <= maxRequests;
}
