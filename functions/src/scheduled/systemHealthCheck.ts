import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import fetch from 'node-fetch';

// Every Railway service the platform runs, keyed by the env var that carries
// its URL. Mirrors SERVICE_DEFS in services/shared/health-monitor.js.
//
// underwriting-service and registry-service were absent until launch-checklist
// v1.8 D2: they are the two services the product cannot transact without —
// underwriting makes the credit decision, registry holds the ledger — so the
// other five could all read green while no loan could be approved.
export const MONITORED_SERVICES: ReadonlyArray<{ name: string; env: string }> = [
  { name: 'payment-server', env: 'PAYMENT_SERVER_URL' },
  { name: 'softcredito-adapter', env: 'SOFTCREDITO_ADAPTER_URL' },
  { name: 'notification-service', env: 'NOTIFICATION_SERVICE_URL' },
  { name: 'pdf-generator', env: 'PDF_GENERATOR_URL' },
  { name: 'ml-service', env: 'ML_SERVICE_URL' },
  { name: 'underwriting-service', env: 'UNDERWRITING_SERVICE_URL' },
  { name: 'registry-service', env: 'REGISTRY_SERVICE_URL' },
];

export const systemHealthCheck = onSchedule(
  { schedule: '*/5 * * * *', timeZone: 'America/Mexico_City' },
  async () => {
    const db = getFirestore();
    const data: Record<string, unknown> = {};
    const ts = FieldValue.serverTimestamp();

    // A service whose URL env var is unset is a deployment gap, not an outage:
    // probing `undefined/health` would always fail and raise a critical
    // incident every 5 minutes for a service that may be perfectly healthy.
    // Record it as its own state, with no incident — same split as
    // health-monitor.js's `unconfiguredInProd`.
    const services: { name: string; url: string }[] = [];
    for (const { name, env } of MONITORED_SERVICES) {
      const base = process.env[env];
      if (base) services.push({ name, url: base + '/health' });
      else data[name] = { status: 'unconfigured', error: `${env} not set`, checkedAt: ts };
    }

    const results = await Promise.allSettled(
      services.map(async (s) => {
        const start = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await fetch(s.url, { signal: (AbortSignal as any).timeout(6000) });
        const d = (await r.json()) as Record<string, unknown>;
        return { name: s.name, status: d['status'], redis: d['redis'], latencyMs: Date.now() - start };
      })
    );

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
