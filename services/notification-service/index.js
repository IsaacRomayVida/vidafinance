const express = require('express');
const helmet  = require('helmet');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
require('dotenv').config();

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
});
const app = express();
app.use(helmet());
app.use(express.json({ limit:'100kb' }));
const requireInternal = (req, res, next) => {
  if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
};
app.get('/health', async (req, res) => {
  const redisOk = await redis.ping().then(()=>true).catch(()=>false);
  res.json({ status: redisOk?'ok':'degraded', service:'vida-notification-service', redis: redisOk, ts: new Date().toISOString() });
});
// TODO: add service-specific routes in Part 2
app.listen(process.env.PORT || 3002, () => console.log('vida-notification-service on port', process.env.PORT || 3002));
