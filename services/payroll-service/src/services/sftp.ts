import SftpClient from 'ssh2-sftp-client';
import { db, storage } from '../lib/firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { Queue } from 'bullmq';

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  remotePath: string;
  employerId: string;
}

function getBullConnection() {
  const redisUrl = process.env.REDIS_URL ?? '';
  return {
    url: redisUrl,
    ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
  };
}

/**
 * Poll a single SFTP connection for new CSV payroll files.
 * Downloads each new file, uploads to Firebase Storage, and enqueues a processing job.
 * Tracks processed files in Firestore to avoid double-processing.
 */
export async function pollSftpServer(config: SftpConfig): Promise<{
  filesFound: number;
  filesEnqueued: number;
  errors: string[];
}> {
  const sftp = new SftpClient();
  const errors: string[] = [];
  let filesFound = 0;
  let filesEnqueued = 0;

  try {
    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      ...(config.password ? { password: config.password } : {}),
      ...(config.privateKey ? { privateKey: config.privateKey } : {}),
      readyTimeout: 30000,
    });

    const fileList = await sftp.list(config.remotePath);
    const csvFiles = fileList.filter(
      (f) => f.type === '-' && f.name.toLowerCase().endsWith('.csv'),
    );

    filesFound = csvFiles.length;

    for (const file of csvFiles) {
      const remotePath = `${config.remotePath}/${file.name}`;
      const trackingRef = `sftp_processed/${config.employerId}_${file.name}`;

      const alreadyProcessed = await db.doc(trackingRef).get().then((d) => d.exists).catch(() => false);
      if (alreadyProcessed) continue;

      try {
        const buffer = (await sftp.get(remotePath)) as Buffer;
        const batchId = nanoid();
        const storagePath = `payroll_uploads/${config.employerId}/${batchId}_${file.name}`;
        const bucket = storage.bucket();
        const storageFile = bucket.file(storagePath);
        await storageFile.save(buffer, { metadata: { contentType: 'text/csv' } });

        // Create batch doc
        await db.collection('payroll_batches').doc(batchId).set({
          employerId: config.employerId,
          uploadedBy: 'sftp_poller',
          fileName: file.name,
          source: 'sftp',
          status: 'queued',
          storagePath,
          totalRows: 0,
          validRows: 0,
          invalidRows: 0,
          processedRows: 0,
          errors: [],
          fieldMapping: {},
          createdAt: FieldValue.serverTimestamp(),
          processedAt: null,
        });

        // Enqueue processing job
        const queue = new Queue('vida-payroll', { connection: getBullConnection() });
        await queue.add('process_csv', {
          batchId,
          employerId: config.employerId,
          storagePath,
          fileName: file.name,
          source: 'sftp',
        });
        await queue.close();

        // Mark as processed
        await db.doc(trackingRef).set({
          fileName: file.name,
          employerId: config.employerId,
          batchId,
          processedAt: FieldValue.serverTimestamp(),
        });

        filesEnqueued++;
      } catch (fileErr) {
        errors.push(`${file.name}: ${(fileErr as Error).message}`);
      }
    }
  } catch (connErr) {
    errors.push(`Connection error: ${(connErr as Error).message}`);
  } finally {
    try {
      await sftp.end();
    } catch (_) {
      // Already disconnected
    }
  }

  return { filesFound, filesEnqueued, errors };
}

/**
 * Poll all SFTP-configured employers from Firestore.
 */
export async function pollAllSftpEmployers(): Promise<{
  employersPolled: number;
  totalFilesEnqueued: number;
  errors: string[];
}> {
  const allErrors: string[] = [];
  let totalFilesEnqueued = 0;

  const snap = await db
    .collection('employers')
    .where('status', '==', 'active')
    .where('sftpEnabled', '==', true)
    .get();

  for (const doc of snap.docs) {
    const emp = doc.data();
    if (!emp['sftpHost'] || !emp['sftpUsername'] || !emp['sftpPath']) continue;

    try {
      const result = await pollSftpServer({
        host: emp['sftpHost'] as string,
        port: (emp['sftpPort'] as number) ?? 22,
        username: emp['sftpUsername'] as string,
        password: emp['sftpPassword'] as string | undefined,
        privateKey: emp['sftpPrivateKey'] as string | undefined,
        remotePath: emp['sftpPath'] as string,
        employerId: doc.id,
      });
      totalFilesEnqueued += result.filesEnqueued;
      allErrors.push(...result.errors.map((e) => `[${doc.id}] ${e}`));
    } catch (err) {
      allErrors.push(`[${doc.id}] ${(err as Error).message}`);
    }
  }

  return {
    employersPolled: snap.size,
    totalFilesEnqueued,
    errors: allErrors,
  };
}
