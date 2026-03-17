import { Worker, Job } from 'bullmq';
import { admin, db } from '../lib/firebase';
import { disburseSPEI, DisburseSPEIParams } from '../services/stpService';

export interface DisbursementJobData {
  loanId: string;
  userId: string;
  amount: number;
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
 * Calls stpService.disburseSPEI and updates Firestore loan status on failure.
 */
export const processDisbursementWorker = new Worker<DisbursementJobData>(
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
      beneficiaryName =
        beneficiaryName ?? (data['borrowerSnapshot'] as Record<string, string>)?.['fullName'];

      if (!clabe) throw new Error(`No bankAccountClabe for loan ${loanId}`);
      if (!beneficiaryName) throw new Error(`No borrowerSnapshot.fullName for loan ${loanId}`);
    }

    const params: DisburseSPEIParams = { loanId, userId, amount, clabe, beneficiaryName };
    const result = await disburseSPEI(params);
    console.log(`[payment-server] Disbursement job ${job.id} done: stpId=${result.stpId}`);
    return result;
  },
  {
    connection: bullConnection,
    concurrency: 3,
  },
);

processDisbursementWorker.on('completed', (job) => {
  console.log(`[payment-server] Disbursement job ${job.id} completed`);
});

processDisbursementWorker.on('failed', async (job, err) => {
  console.error(`[payment-server] Disbursement job ${job?.id} failed: ${err.message}`);

  if (job && job.attemptsMade >= (job.opts?.attempts ?? 3)) {
    const { loanId } = job.data;
    try {
      await db.collection('loans').doc(loanId).update({
        status: 'disbursement_error',
        disbursementError: err.message,
      });
      await db.collection('incident_log').add({
        source: 'disbursement-worker',
        loanId,
        error: err.message,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (firestoreErr) {
      console.error(
        '[payment-server] Failed to log disbursement failure to Firestore:',
        firestoreErr,
      );
    }
  }
});
