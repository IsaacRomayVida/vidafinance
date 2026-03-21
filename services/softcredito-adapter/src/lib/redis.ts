import IORedis from 'ioredis';
import pino from 'pino';

const log = pino({ name: 'vida-softcredito-adapter', level: process.env.LOG_LEVEL || 'info', formatters: { level: (label) => ({ level: label }) } });

const redis = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith('rediss://')
    ? { rejectUnauthorized: false }
    : undefined,
  lazyConnect: true,
});

redis.on('error', (err: Error) => {
  log.error({ error: err.message, service: 'softcredito-adapter' }, 'Redis connection error');
});

export default redis;
