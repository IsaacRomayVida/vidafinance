import { Worker, Job } from 'bullmq';
import { db, storage } from '../lib/firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { parseCSV, FieldMapping } from '../services/csvParser';
import { validateRows } from '../services/validator';

const QUEUE_NAME = 'vida-payroll';

const redisUrl = process.env.REDIS_URL ?? '';
const bullConnection = {
  url: redisUrl,
  ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
};

export interface PayrollJobData {
  batchId: string;
  employerId: string;
  storagePath: string;
  fileName: string;
  source: 'csv_upload' | 'sftp' | 'email';
  explicitMapping?: FieldMapping;
}

async function processCsvJob(job: Job<PayrollJobData>): Promise<void> {
  const { batchId, employerId, storagePath, explicitMapping } = job.data;

  // Update batch status to processing
  await db.collection('payroll_batches').doc(batchId).update({
    status: 'processing',
    processingStartedAt: FieldValue.serverTimestamp(),
  });

  try {
    // Download CSV from Firebase Storage
    const bucket = storage.bucket();
    const file = bucket.file(storagePath);
    const [buffer] = await file.download();

    // Parse CSV
    const { fieldMapping, rows, totalRows } = await parseCSV(buffer, explicitMapping);

    // Validate rows
    const validatedRows = validateRows(rows, fieldMapping);
    const validRows = validatedRows.filter((r) => r.isValid);
    const invalidRows = validatedRows.filter((r) => !r.isValid);

    // Match rows to existing employee records where possible
    const employeesByRfc = new Map<string, string>();
    const employeesByEmail = new Map<string, string>();
    const employeesSnap = await db
      .collection('employees')
      .where('employerId', '==', employerId)
      .get();
    for (const doc of employeesSnap.docs) {
      const e = doc.data();
      if (e['rfc']) employeesByRfc.set((e['rfc'] as string).toUpperCase(), doc.id);
      if (e['email']) employeesByEmail.set((e['email'] as string).toLowerCase(), doc.id);
    }

    // Write payroll records to Firestore in chunks
    const CHUNK_SIZE = 400;
    for (let i = 0; i < validatedRows.length; i += CHUNK_SIZE) {
      const chunk = validatedRows.slice(i, i + CHUNK_SIZE);
      const batch = db.batch();
      for (const row of chunk) {
        const recordRef = db.collection('payroll_records').doc();
        const rfcKey = row.employee_rfc?.toUpperCase();
        const emailKey = row.email?.toLowerCase();
        const matchedEmployeeId =
          (rfcKey ? employeesByRfc.get(rfcKey) : undefined) ??
          (emailKey ? employeesByEmail.get(emailKey) : undefined) ??
          null;

        batch.set(recordRef, {
          batchId,
          employerId,
          employeeId: matchedEmployeeId,
          employeeRfc: row.employee_rfc ?? null,
          employeeName: row.employee_name ?? null,
          employeeNumber: row.employee_number ?? null,
          department: row.department ?? null,
          grossSalary: row.gross_salary ?? null,
          netSalary: row.net_salary ?? null,
          payPeriod: row.pay_period ?? null,
          bankClabe: row.bank_clabe ?? null,
          email: row.email ?? null,
          position: row.position ?? null,
          isValid: row.isValid,
          validationErrors: row.errors.map((e) => e.message),
          matchStatus: matchedEmployeeId ? 'matched' : 'unmatched',
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }

    // Collect first 100 errors for the batch summary
    const batchErrors = invalidRows
      .slice(0, 100)
      .flatMap((r) => r.errors)
      .map((e) => ({ row: e.row, field: e.field, message: e.message }));

    const status =
      invalidRows.length === 0
        ? 'completed'
        : validRows.length === 0
          ? 'failed'
          : 'partial';

    await db.collection('payroll_batches').doc(batchId).update({
      status,
      totalRows,
      validRows: validRows.length,
      invalidRows: invalidRows.length,
      processedRows: validatedRows.length,
      fieldMapping,
      errors: batchErrors,
      processedAt: FieldValue.serverTimestamp(),
    });

    console.log(
      `[payroll-worker] Batch ${batchId}: ${validRows.length}/${totalRows} valid rows, status=${status}`,
    );
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[payroll-worker] Batch ${batchId} failed:`, msg);
    await db.collection('payroll_batches').doc(batchId).update({
      status: 'failed',
      errors: [{ row: 0, field: 'system', message: msg }],
      processedAt: FieldValue.serverTimestamp(),
    });
    throw err;
  }
}

export const payrollWorker = new Worker<PayrollJobData>(
  QUEUE_NAME,
  async (job: Job<PayrollJobData>) => {
    console.log(`[payroll-worker] Processing ${job.name} job ${job.id}`);
    if (job.name === 'process_csv') {
      await processCsvJob(job);
    } else {
      console.warn(`[payroll-worker] Unknown job type: ${job.name}`);
    }
  },
  {
    connection: bullConnection,
    concurrency: 3,
  },
);

payrollWorker.on('completed', (job) => {
  console.log(`[payroll-worker] Completed job ${job.id}`);
});

payrollWorker.on('failed', (job, err) => {
  console.error(`[payroll-worker] Failed job ${job?.id}:`, err.message);
});
