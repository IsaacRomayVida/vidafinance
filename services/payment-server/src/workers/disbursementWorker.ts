import { Worker, Job } from 'bullmq';
import { db } from '../lib/firebase';
import { disburseLoan } from '../routes/internal';

export interface DisbursementJobData {
  loanId: string;
  userId: string;
  amount: number;
  // If provided by producer, skip Firestore lookup
  clabe?: string;
  beneficiaryName?: string;
}

const redisUrl = process.env.REDIS_URL ?? '';
const bullConnection = {
  url: redisUrl,
  ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
};

/**
 * BullMQ Worker consuming the `vida-disbursements` queue.
 * Falls back to `jobs:disbursements` raw Redis list entries are
 * forwarded by the companion poller (see startRawQueuePoller).
 */
export const disbursementWorker = new Worker<DisbursementJobData>(
  'vida-disbursements',
  async (job: Job<DisbursementJobData>) => {
    const { loanId, userId, amount } = job.data;
    let { clabe, beneficiaryName } = job.data;

    console.log(`[payment-server] Processing disbursement job ${job.id} for loan ${loanId}`);

    // Fetch CLABE and borrower name from Firestore if not provided in job
    if (!clabe || !beneficiaryName) {
      const loanDoc = await db.collection('loans').doc(loanId).get();
      if (!loanDoc.exists) {
        throw new Error(`Loan ${loanId} not found in Firestore`);
      }
      const data = loanDoc.data()!;
      clabe = clabe ?? (data['bankAccountClabe'] as string);
      beneficiaryName = beneficiaryName ?? (data['borrowerSnapshot'] as Record<string, string>)?.['fullName'];

      if (!clabe) throw new Error(`No bankAccountClabe for loan ${loanId}`);
      if (!beneficiaryName) throw new Error(`No borrowerSnapshot.fullName for loan ${loanId}`);
    }

    const result = await disburseLoan({ loanId, userId, amount, clabe, beneficiaryName });
    console.log(`[payment-server] Disbursement job ${job.id} done: stpId=${result.stpId}`);
    return result;
  },
  {
    connection: bullConnection,
    concurrency: 3,
  },
);

disbursementWorker.on('completed', (job) => {
  console.log(`[payment-server] ✅ Disbursement job ${job.id} completed`);
});

disbursementWorker.on('failed', async (job, err) => {
  console.error(`[payment-server] ❌ Disbursement job ${job?.id} failed: ${err.message}`);

  if (job && job.attemptsMade >= (job.opts?.attempts ?? 5)) {
    const loanId = job.data.loanId;
    try {
      const { admin: adminSdk } = await import('../lib/firebase');
      await db.collection('loans').doc(loanId).update({
        status: 'disbursement_error',
        disbursementError: err.message,
      });
      await db.collection('incident_log').add({
        source: 'disbursement-worker',
        loanId,
        error: err.message,
        ts: adminSdk.firestore.FieldValue.serverTimestamp(),
      });
    } catch (firestoreErr) {
      console.error('[payment-server] Failed to log disbursement failure to Firestore:', firestoreErr);
    }
  }
});

/**
 * Poller that bridges the raw Redis list `jobs:disbursements`
 * (used by ml-service which pushes raw JSON via lPush) into the
 * BullMQ `vida-disbursements` queue.
 */
export async function startRawQueuePoller(): Promise<void> {
  const { Queue } = await import('bullmq');
  const { redis } = await import('../lib/redis');
  const queue = new Queue<DisbursementJobData>('vida-disbursements', {
    connection: bullConnection,
    defaultJobOptions: {
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
    },
  });

  console.log('[payment-server] Raw queue poller started on jobs:disbursements');

  const poll = async (): Promise<void> => {
    try {
      const item = await redis.brpop('jobs:disbursements', 5);
      if (item) {
        const [, raw] = item;
        const data = JSON.parse(raw) as DisbursementJobData;
        await queue.add('disburse', data);
        console.log(`[payment-server] Forwarded jobs:disbursements item to BullMQ: loanId=${data.loanId}`);
      }
    } catch (err) {
      console.error('[payment-server] Raw queue poller error:', err);
    }
    // Re-schedule immediately (brpop blocks for 5s, so this is near-instant on activity)
    setImmediate(poll);
  };

  poll();
}
