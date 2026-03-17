import { onSchedule } from 'firebase-functions/v2/scheduler';
import fetch from 'node-fetch';

export const pollSFTP = onSchedule(
  { schedule: '0 */4 * * *', timeZone: 'America/Mexico_City' },
  async () => {
    const payrollServiceUrl = process.env['PAYROLL_SERVICE_URL'];
    if (!payrollServiceUrl) {
      console.warn('[pollSFTP] PAYROLL_SERVICE_URL not configured — skipping');
      return;
    }

    try {
      const res = await fetch(`${payrollServiceUrl}/internal/poll-sftp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signal: (AbortSignal as any).timeout(120000),
      });

      if (res.ok) {
        const result = (await res.json()) as {
          employersPolled: number;
          totalFilesEnqueued: number;
          errors: string[];
        };
        console.log(
          `[pollSFTP] Polled ${result.employersPolled} employers, enqueued ${result.totalFilesEnqueued} files`,
        );
        if (result.errors.length > 0) {
          console.warn('[pollSFTP] Errors:', result.errors.join('; '));
        }
      } else {
        console.error(`[pollSFTP] Payroll service returned ${res.status}`);
      }
    } catch (err: unknown) {
      console.error('[pollSFTP] Failed to trigger SFTP poll:', (err as Error).message);
    }
  },
);
