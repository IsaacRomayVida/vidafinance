import { Worker, Job } from 'bullmq';
import { reconcilePayment, IncomingPayment } from '../services/reconciliation';
import { db } from '../lib/firebase';

const redisUrl = process.env.REDIS_URL ?? '';
const bullConnection = {
  url: redisUrl,
  ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
};

export const reconciliationWorker = new Worker<IncomingPayment>(
  'vida-reconciliation',
  async (job: Job<IncomingPayment>) => {
    console.log(`[payment-server] Processing reconciliation job ${job.id} for payment ${job.data.id}`);

    const result = await reconcilePayment(job.data);

    console.log(
      `[payment-server] Reconciliation job ${job.id} done: strategy=${result.strategy}, matched=${result.matched}` +
        (result.loanId ? `, loanId=${result.loanId}` : ''),
    );

    return result;
  },
  {
    connection: bullConnection,
    concurrency: 3,
  },
);

reconciliationWorker.on('completed', (job) => {
  console.log(`[payment-server] Reconciliation job ${job.id} completed`);
});

reconciliationWorker.on('failed', async (job, err) => {
  console.error(`[payment-server] Reconciliation job ${job?.id} failed: ${err.message}`);

  if (job && job.attemptsMade >= (job.opts?.attempts ?? 5)) {
    try {
      const { admin: adminSdk } = await import('../lib/firebase');
      await db.collection('incident_log').add({
        source: 'reconciliation-worker',
        paymentId: job.data.id,
        error: err.message,
        ts: adminSdk.firestore.FieldValue.serverTimestamp(),
      });
    } catch (firestoreErr) {
      console.error('[payment-server] Failed to log reconciliation failure to Firestore:', firestoreErr);
    }
  }
});
