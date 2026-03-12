const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, enableReadyCheck: false,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
});
const QUEUES = { DISBURSEMENTS:'vida-disbursements', NOTIFICATIONS:'vida-notifications', PDFS:'vida-pdfs', UNDERWRITING:'vida-underwriting' };
const getQueue = name => new Queue(name, { connection, defaultJobOptions:{ removeOnComplete:{count:1000}, removeOnFail:{count:5000}, attempts:5, backoff:{type:'exponential',delay:2000} }});
const getWorker = (name, processor) => new Worker(name, processor, { connection, concurrency: name===QUEUES.PDFS?2:5 });
async function rateLimitCheck(key, limit, windowSec) {
  const multi = connection.multi(); multi.incr(key); multi.expire(key, windowSec);
  const res = await multi.exec(); const count = res[0][1];
  return { allowed: count <= limit, count, limit };
}
const cacheGet = async key => { const v = await connection.get(key); return v ? JSON.parse(v) : null; };
const cacheSet = async (key, val, ttl) => connection.set(key, JSON.stringify(val), 'EX', ttl);
const cacheDel = async key => connection.del(key);
module.exports = { connection, QUEUES, getQueue, getWorker, rateLimitCheck, cacheGet, cacheSet, cacheDel };
