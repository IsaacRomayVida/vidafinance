import { onCall } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';

const GetAuditLogsSchema = z.object({
  search: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(50).optional(),
  performedBy: z.string().max(128).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  collection: z.enum(['all', 'audit_log', 'auditLogs']).default('all'),
  limit: z.number().int().min(1).max(500).default(200),
});

interface AuditLogEntry {
  id: string;
  action: string | null;
  actorUid: string | null;
  actorEmail: string | null;
  performedBy: string | null;
  performedByEmail: string | null;
  entityType: string | null;
  entityId: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  details: string | null;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  timestamp: FirebaseFirestore.Timestamp | null;
  source: 'audit_log' | 'auditLogs';
}

export const getAuditLogs = onCall(
  { enforceAppCheck: true },
  withAuth(['ops', 'admin', 'super_admin'], async (data, auth) =>
    withErrorHandling({ functionName: 'getAuditLogs', uid: auth.uid }, async () => {
      const input = validateInput(GetAuditLogsSchema, data);
      const db = getFirestore();

      const fromTs = input.dateFrom
        ? Timestamp.fromDate((() => { const d = new Date(input.dateFrom!); d.setHours(0, 0, 0, 0); return d; })())
        : null;
      const toTs = input.dateTo
        ? Timestamp.fromDate((() => { const d = new Date(input.dateTo!); d.setHours(23, 59, 59, 999); return d; })())
        : null;

      const fetchLegacyLogs = async (): Promise<AuditLogEntry[]> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q: any = db.collection('audit_log').orderBy('timestamp', 'desc');
        if (fromTs) q = q.where('timestamp', '>=', fromTs);
        if (toTs) q = q.where('timestamp', '<=', toTs);
        if (input.action) q = q.where('action', '==', input.action);
        q = q.limit(input.limit);

        const snap = await q.get();
        return snap.docs.map((d: FirebaseFirestore.QueryDocumentSnapshot) => {
          const l = d.data();
          return {
            id: d.id,
            action: l['action'] ?? null,
            actorUid: l['actorUid'] ?? null,
            actorEmail: l['actorEmail'] ?? l['performedByEmail'] ?? null,
            performedBy: l['actorUid'] ?? null,
            performedByEmail: l['actorEmail'] ?? null,
            entityType: l['targetCollection'] ?? null,
            entityId: l['targetId'] ?? null,
            targetId: l['targetId'] ?? null,
            metadata: l['meta'] ?? null,
            details: l['details'] ?? null,
            previousState: l['before'] ?? null,
            newState: l['after'] ?? null,
            timestamp: l['timestamp'] ?? null,
            source: 'audit_log' as const,
          };
        });
      };

      const fetchNewLogs = async (): Promise<AuditLogEntry[]> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q: any = db.collection('auditLogs').orderBy('timestamp', 'desc');
        if (fromTs) q = q.where('timestamp', '>=', fromTs);
        if (toTs) q = q.where('timestamp', '<=', toTs);
        if (input.action) q = q.where('action', '==', input.action);
        if (input.entityType) q = q.where('entityType', '==', input.entityType);
        q = q.limit(input.limit);

        const snap = await q.get();
        return snap.docs.map((d: FirebaseFirestore.QueryDocumentSnapshot) => {
          const l = d.data();
          return {
            id: d.id,
            action: l['action'] ?? null,
            actorUid: l['performedBy'] ?? null,
            actorEmail: l['performedByEmail'] ?? null,
            performedBy: l['performedBy'] ?? null,
            performedByEmail: l['performedByEmail'] ?? null,
            entityType: l['entityType'] ?? null,
            entityId: l['entityId'] ?? null,
            targetId: l['entityId'] ?? null,
            metadata: l['metadata'] ?? null,
            details: l['metadata'] ? JSON.stringify(l['metadata']) : null,
            previousState: l['previousState'] ?? null,
            newState: l['newState'] ?? null,
            timestamp: l['timestamp'] ?? null,
            source: 'auditLogs' as const,
          };
        });
      };

      let allLogs: AuditLogEntry[] = [];

      if (input.collection === 'audit_log') {
        allLogs = await fetchLegacyLogs();
      } else if (input.collection === 'auditLogs') {
        allLogs = await fetchNewLogs();
      } else {
        const [legacy, newLogs] = await Promise.all([fetchLegacyLogs(), fetchNewLogs()]);
        allLogs = [...legacy, ...newLogs].sort((a, b) => {
          const ta = a.timestamp ? a.timestamp.toMillis() : 0;
          const tb = b.timestamp ? b.timestamp.toMillis() : 0;
          return tb - ta;
        });
      }

      // Apply text search client-side (search across actor, action, targetId, details)
      if (input.search) {
        const s = input.search.toLowerCase();
        allLogs = allLogs.filter((l) => {
          const haystack = [
            l.actorUid, l.actorEmail, l.performedBy, l.performedByEmail,
            l.action, l.entityType, l.entityId, l.targetId, l.details,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(s);
        });
      }

      // Apply performedBy filter
      if (input.performedBy) {
        allLogs = allLogs.filter(
          (l) =>
            l.performedBy === input.performedBy ||
            l.actorUid === input.performedBy ||
            l.performedByEmail === input.performedBy
        );
      }

      // Extract unique actions for filter dropdown
      const actions = [...new Set(allLogs.map((l) => l.action).filter(Boolean))].slice(0, 100);

      return {
        logs: allLogs.slice(0, input.limit),
        total: allLogs.length,
        actions,
        generatedAt: new Date().toISOString(),
      };
    })
  )
);
