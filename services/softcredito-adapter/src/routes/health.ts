import { Router } from 'express';
import redis from '../lib/redis';
import { db } from '../lib/firestore';
import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';

const router = Router();

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const START_TIME = Date.now();

router.get('/health', async (_req, res) => {
  const redisOk = await redis.ping().then(() => true).catch(() => false);

  let firestoreOk = false;
  try { await db.collection('_health').limit(1).get(); firestoreOk = true; } catch (_) {}

  let softcreditoApi = false;
  try {
    const url = process.env.SOFTCREDITO_API_URL;
    if (url) {
      const resp = await axios.get(`${url}/health`, { timeout: 5000 }).catch(() => null);
      softcreditoApi = resp !== null && resp.status < 500;
    }
  } catch (_) {}

  const down = !redisOk && !firestoreOk;
  const degraded = !redisOk || !firestoreOk || !softcreditoApi;
  res.status(down ? 503 : 200).json({
    status: down ? 'down' : degraded ? 'degraded' : 'ok',
    service: 'vida-softcredito-adapter',
    version: pkg.version,
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    redis: redisOk,
    firestore: firestoreOk,
    softcredito_api: softcreditoApi,
    ts: new Date().toISOString(),
  });
});

export default router;
