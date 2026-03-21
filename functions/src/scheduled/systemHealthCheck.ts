import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import fetch from 'node-fetch';

export const systemHealthCheck = onSchedule(
  { schedule: '*/5 * * * *', timeZone: 'America/Mexico_City' },
  async () => {
    const db = getFirestore();
    const services = [
      { name: 'payment-server', url: process.env['PAYMENT_SERVER_URL'] + '/health' },
      { name: 'softcredito-adapter', url: process.env['SOFTCREDITO_ADAPTER_URL'] + '/health' },
      { name: 'notification-service', url: process.env['NOTIFICATION_SERVICE_URL'] + '/health' },
      { name: 'pdf-generator', url: process.env['PDF_GENERATOR_URL'] + '/health' },
      { name: 'ml-service', url: process.env['ML_SERVICE_URL'] + '/health' },
    ];

    const results = await Promise.allSettled(
      services.map(async (s) => {
        const start = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await fetch(s.url, { signal: (AbortSignal as any).timeout(6000) });
        const d = (await r.json()) as Record<string, unknown>;
        return { name: s.name, status: d['status'], redis: d['redis'], latencyMs: Date.now() - start };
      })
    );

    const data: Record<string, unknown> = {};
    const ts = FieldValue.serverTimestamp();

    for (let i = 0; i < services.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled') {
        data[services[i].name] = { ...res.value, checkedAt: ts };
      } else {
        data[services[i].name] = { status: 'down', error: res.reason.message, checkedAt: ts };
        await db.collection('incident_log').add({
          source: 'health-check',
          service: services[i].name,
          error: res.reason.message,
          severity: 'critical',
          ts,
          resolved: false,
        });
      }
    }

    await db.collection('system_health').doc('current').set({ ...data, lastChecked: ts });
  }
);
