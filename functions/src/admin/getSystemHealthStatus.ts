import { onCall } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

export const getSystemHealthStatus = onCall(
  { enforceAppCheck: true },
  withAuth(['ops', 'admin', 'super_admin'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getSystemHealthStatus', uid: auth.uid }, async () => {
      const db = getFirestore();

      const [currentSnap, queuesSnap, incidentsSnap] = await Promise.all([
        db.collection('system_health').doc('current').get(),
        db.collection('system_health').doc('queues').get(),
        db
          .collection('incident_log')
          .where('resolved', '==', false)
          .orderBy('ts', 'desc')
          .limit(20)
          .get(),
      ]);

      const services = currentSnap.exists ? currentSnap.data() ?? {} : {};
      const queues = queuesSnap.exists ? queuesSnap.data() ?? {} : {};
      const incidents = incidentsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

      // Summarize service health
      const serviceNames = ['payment-server', 'softcredito-adapter', 'notification-service', 'pdf-generator', 'ml-service'];
      const serviceStatuses = serviceNames.map((name) => {
        const s = services[name] as Record<string, unknown> | undefined;
        if (!s) return { name, status: 'unknown', latencyMs: null, checkedAt: null };
        return {
          name,
          status: s['status'] ?? 'unknown',
          latencyMs: s['latencyMs'] ?? null,
          redis: s['redis'] ?? null,
          error: s['error'] ?? null,
          checkedAt: s['checkedAt'] ?? null,
        };
      });

      const lastChecked = services['lastChecked'] ?? null;
      const overallStatus = serviceStatuses.every((s) => s.status === 'ok')
        ? 'healthy'
        : serviceStatuses.some((s) => s.status === 'down')
        ? 'degraded'
        : 'partial';

      return {
        overallStatus,
        lastChecked,
        services: serviceStatuses,
        queues,
        incidents,
        generatedAt: new Date().toISOString(),
      };
    })
  )
);
