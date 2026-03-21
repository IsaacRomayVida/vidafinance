import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export interface AuditLogEntry {
  action: string;
  actorUid: string;
  actorRole: string;
  targetId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
}

export async function auditLog(entry: AuditLogEntry): Promise<void> {
  const db = getFirestore();
  await db.collection('audit_log').add({
    action: entry.action,
    actorUid: entry.actorUid,
    actorRole: entry.actorRole,
    targetCollection: entry.action.split('.')[0],
    targetId: entry.targetId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    meta: entry.meta ?? {},
    timestamp: FieldValue.serverTimestamp(),
  });
}
