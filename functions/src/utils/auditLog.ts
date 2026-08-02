import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

/**
 * The one and only audit collection.
 *
 * `audit_log` is the collection that firestore.rules grants ops read access to
 * (`allow read: if isOps(); allow write: if false;`) and that firestore.indexes.json
 * declares indexes for. Anything written anywhere else is write-only in production:
 * unreadable by ops, unqueryable by the admin console. Do not add a second one.
 */
export const AUDIT_LOG_COLLECTION = 'audit_log';

export interface AuditLogEntry {
  action: string;
  actorUid: string;
  actorRole: string;
  targetId: string;
  /** Email of the acting principal, when the caller has it. Rendered by the ops audit tab. */
  actorEmail?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
}

export interface AuditLogDocument {
  action: string;
  actorUid: string;
  actorRole: string;
  actorEmail: string | null;
  targetCollection: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  meta: Record<string, unknown>;
  timestamp: FirebaseFirestore.FieldValue | Timestamp;
}

/**
 * Canonical audit document shape. Every writer — plain `add()` and transactional
 * `txn.set()` alike — must go through this so the schema cannot drift per call site.
 *
 * `timestamp` defaults to a server timestamp; transactional writers that need the
 * same instant on several documents pass an explicit Timestamp instead.
 */
export function buildAuditLogDocument(
  entry: AuditLogEntry,
  timestamp?: Timestamp
): AuditLogDocument {
  return {
    action: entry.action,
    actorUid: entry.actorUid,
    actorRole: entry.actorRole,
    actorEmail: entry.actorEmail ?? null,
    targetCollection: entry.action.split('.')[0] ?? '',
    targetId: entry.targetId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    meta: entry.meta ?? {},
    timestamp: timestamp ?? FieldValue.serverTimestamp(),
  };
}

export async function auditLog(entry: AuditLogEntry): Promise<void> {
  const db = getFirestore();
  await db.collection(AUDIT_LOG_COLLECTION).add(buildAuditLogDocument(entry));
}
