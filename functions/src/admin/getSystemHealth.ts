import { onCall } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import fetch from 'node-fetch';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { enforceRateLimit } from '../utils/rateLimiter';

interface ServiceStatus {
  name: string;
  status: 'ok' | 'degraded' | 'down';
  latencyMs?: number;
  detail?: string;
}

interface HealthResult {
  railway: ServiceStatus[];
  config: Record<string, boolean>;
  firestoreHealth: Record<string, unknown> | null;
  checkedAt: string;
}

export const getSystemHealth = onCall(
  { enforceAppCheck: true },
  withAuth(['ops', 'admin', 'super_admin'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getSystemHealth', uid: auth.uid }, async () => {
      // Rate limit: 60/min/uid (read-only dashboard)
      // Deliberately fails OPEN. This is a read-only view: the limit is
      // here to protect capacity, not money or secrets, so a limiter
      // outage should degrade to an unthrottled dashboard rather than
      // to a dashboard nobody can open. Contrast the spend- and
      // enumeration-critical limits, which fail closed.
      await enforceRateLimit(`rl:getSystemHealth:${auth.uid}`, 60, 60, {
        onUnavailable: 'open',
        context: 'getSystemHealth',
      });

      const db = getFirestore();

      // 1. Ping Railway services server-side (avoids CORS)
      const railwayServices = [
        { name: 'softcredito-adapter', url: process.env['SOFTCREDITO_ADAPTER_URL'], healthPath: '/health' },
        { name: 'pdf-generator', url: process.env['PDF_GENERATOR_URL'], healthPath: '/health' },
      ];

      const railwayResults = await Promise.allSettled(
        railwayServices.map(async (s): Promise<ServiceStatus> => {
          if (!s.url) {
            return { name: s.name, status: 'down', detail: 'URL not configured' };
          }
          const start = Date.now();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = await fetch(s.url + s.healthPath, { signal: (AbortSignal as any).timeout(6000) });
          const body = (await r.json()) as Record<string, unknown>;
          return {
            name: s.name,
            status: body['status'] === 'ok' ? 'ok' : 'degraded',
            latencyMs: Date.now() - start,
            detail: JSON.stringify(body),
          };
        })
      );

      const railway: ServiceStatus[] = railwayResults.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        return { name: railwayServices[i].name, status: 'down' as const, detail: r.reason?.message ?? 'Unknown error' };
      });

      // 2. Check which env vars are configured
      const configKeys = [
        'METAMAP_CLIENT_ID',
        'BELVO_SECRET_ID',
        'RISKSEAL_API_KEY',
        'SOFTCREDITO_API_URL',
        'TWILIO_ACCOUNT_SID',
        'SENDGRID_API_KEY',
        'SOFTCREDITO_ADAPTER_URL',
      ];
      const config: Record<string, boolean> = {};
      for (const key of configKeys) {
        config[key] = !!process.env[key];
      }

      // 3. Read latest Firestore health doc (written by scheduled systemHealthCheck)
      const healthDoc = await db.collection('system_health').doc('current').get();
      const firestoreHealth = healthDoc.exists ? healthDoc.data() ?? null : null;

      const result: HealthResult = {
        railway,
        config,
        firestoreHealth,
        checkedAt: new Date().toISOString(),
      };

      return result;
    })
  )
);
