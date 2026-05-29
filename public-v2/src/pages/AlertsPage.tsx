import { useState, useEffect } from 'react';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  doc,
  updateDoc,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

/* ─── Types ────────────────────────────────────────────────────────── */

type Severity = 'critical' | 'warning' | 'info';
type AlertType = 'all' | 'overdue' | 'system' | 'payment_failure';

interface IncidentAlert {
  id: string;
  kind: 'incident';
  source: string;
  service?: string;
  queue?: string;
  error?: string;
  severity: Severity;
  loanId?: string;
  failedCount?: number;
  ts: { seconds: number } | null;
  resolved: boolean;
}

interface OverdueAlert {
  id: string;
  kind: 'overdue';
  loanId: string;
  employeeName: string;
  employerId: string;
  amount: number;
  daysOverdue: number;
  dueDate: { seconds: number } | null;
  detectedAt: { seconds: number } | null;
  resolved: boolean;
}

type Alert = IncidentAlert | OverdueAlert;

/* ─── Helpers ──────────────────────────────────────────────────────── */

function tsToDate(ts: { seconds: number } | null | undefined): Date | null {
  if (!ts || !ts.seconds) return null;
  return new Date(ts.seconds * 1000);
}

function fmtDate(ts: { seconds: number } | null | undefined): string {
  const d = tsToDate(ts);
  if (!d) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtRelative(ts: { seconds: number } | null | undefined): string {
  const d = tsToDate(ts);
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function getSeverity(alert: Alert): Severity {
  if (alert.kind === 'overdue') {
    const days = (alert as OverdueAlert).daysOverdue;
    if (days >= 30) return 'critical';
    if (days >= 7) return 'warning';
    return 'info';
  }
  return (alert as IncidentAlert).severity || 'warning';
}

function getAlertType(alert: Alert): AlertType {
  if (alert.kind === 'overdue') return 'overdue';
  const src = (alert as IncidentAlert).source;
  if (
    src === 'conekta-webhook' ||
    src === 'create-checkout' ||
    src === 'disbursement-worker'
  )
    return 'payment_failure';
  return 'system';
}

function getTimestamp(alert: Alert): { seconds: number } | null {
  if (alert.kind === 'overdue') return (alert as OverdueAlert).detectedAt;
  return (alert as IncidentAlert).ts;
}

function getMessage(alert: Alert): string {
  if (alert.kind === 'overdue') {
    const o = alert as OverdueAlert;
    return `${o.employeeName} — $${o.amount.toLocaleString()} overdue by ${o.daysOverdue} day${o.daysOverdue !== 1 ? 's' : ''}`;
  }
  const i = alert as IncidentAlert;
  const parts: string[] = [];
  if (i.service) parts.push(i.service);
  else if (i.queue) parts.push(`Queue: ${i.queue}`);
  else parts.push(i.source);
  if (i.error) parts.push(i.error);
  if (i.failedCount) parts.push(`${i.failedCount} failed jobs`);
  return parts.join(' — ');
}

function getSourceLabel(alert: Alert): string {
  if (alert.kind === 'overdue') return 'Overdue Loan';
  const src = (alert as IncidentAlert).source;
  const labels: Record<string, string> = {
    'health-check': 'Health Check',
    'queue-monitor': 'Queue Monitor',
    'notification-worker': 'Notifications',
    'pdf-worker': 'PDF Generator',
    'conekta-webhook': 'Conekta Webhook',
    'metamap-webhook': 'MetaMap Webhook',
    'disbursement-worker': 'Disbursement',
    'create-checkout': 'Checkout',
  };
  return labels[src] || src;
}

/* ─── Severity Styles ──────────────────────────────────────────────── */

const severityConfig: Record<
  Severity,
  { bg: string; text: string; dot: string; border: string; badgeBg: string }
> = {
  critical: {
    bg: 'rgba(220,80,60,0.04)',
    text: 'var(--danger)',
    dot: 'var(--danger)',
    border: 'rgba(220,80,60,0.12)',
    badgeBg: 'rgba(220,80,60,0.08)',
  },
  warning: {
    bg: 'rgba(196,155,65,0.04)',
    text: 'var(--gold)',
    dot: '#c49b41',
    border: 'rgba(196,155,65,0.12)',
    badgeBg: 'rgba(196,155,65,0.08)',
  },
  info: {
    bg: 'rgba(25,68,69,0.03)',
    text: 'var(--t2)',
    dot: '#4a8fa0',
    border: 'rgba(25,68,69,0.06)',
    badgeBg: 'rgba(74,143,160,0.08)',
  },
};

/* ─── Component ────────────────────────────────────────────────────── */

export function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<AlertType>('all');
  const [dismissing, setDismissing] = useState<string | null>(null);

  // Real-time incident_log listener
  useEffect(() => {
    const q = query(
      collection(db, 'incident_log'),
      orderBy('ts', 'desc'),
      limit(50)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const data: IncidentAlert[] = snap.docs.map((d) => ({
          id: d.id,
          kind: 'incident' as const,
          source: d.data().source ?? '',
          service: d.data().service,
          queue: d.data().queue,
          error: d.data().error,
          severity: d.data().severity ?? 'warning',
          loanId: d.data().loanId,
          failedCount: d.data().failedCount,
          ts: d.data().ts ?? null,
          resolved: d.data().resolved ?? false,
        }));
        setAlerts((prev) => {
          const overdue = prev.filter((a) => a.kind === 'overdue');
          return mergeAndSort([...data, ...overdue]);
        });
        setLoading(false);
      },
      () => setLoading(false)
    );
    return unsub;
  }, []);

  // Real-time overdue_log listener
  useEffect(() => {
    const q = query(
      collection(db, 'overdue_log'),
      orderBy('detectedAt', 'desc'),
      limit(50)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const data: OverdueAlert[] = snap.docs.map((d) => ({
          id: d.id,
          kind: 'overdue' as const,
          loanId: d.data().loanId ?? d.id,
          employeeName: d.data().employeeName ?? 'Unknown',
          employerId: d.data().employerId ?? '',
          amount: d.data().amount ?? 0,
          daysOverdue: d.data().daysOverdue ?? 0,
          dueDate: d.data().dueDate ?? null,
          detectedAt: d.data().detectedAt ?? null,
          resolved: d.data().resolved ?? false,
        }));
        setAlerts((prev) => {
          const incidents = prev.filter((a) => a.kind === 'incident');
          return mergeAndSort([...incidents, ...data]);
        });
      },
      () => {}
    );
    return unsub;
  }, []);

  function mergeAndSort(items: Alert[]): Alert[] {
    return items.sort((a, b) => {
      const ta = getTimestamp(a)?.seconds ?? 0;
      const tb = getTimestamp(b)?.seconds ?? 0;
      return tb - ta;
    });
  }

  const dismiss = async (alert: Alert) => {
    const key = `${alert.kind}-${alert.id}`;
    setDismissing(key);
    try {
      const col = alert.kind === 'overdue' ? 'overdue_log' : 'incident_log';
      await updateDoc(doc(db, col, alert.id), { resolved: true });
    } catch (e) {
      console.error('Failed to dismiss alert:', e);
    } finally {
      setDismissing(null);
    }
  };

  // Filter & counts
  const activeAlerts = alerts.filter((a) => !a.resolved);
  const resolvedAlerts = alerts.filter((a) => a.resolved);

  const filtered = (list: Alert[]) =>
    filter === 'all' ? list : list.filter((a) => getAlertType(a) === filter);

  const counts = {
    critical: activeAlerts.filter((a) => getSeverity(a) === 'critical').length,
    warning: activeAlerts.filter((a) => getSeverity(a) === 'warning').length,
    info: activeAlerts.filter((a) => getSeverity(a) === 'info').length,
  };

  const filterTabs: { key: AlertType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'overdue', label: 'Overdue' },
    { key: 'system', label: 'System' },
    { key: 'payment_failure', label: 'Payment Failure' },
  ];

  /* ─── Shared Styles ──────────────────────────────────────────────── */

  const cardStyle: React.CSSProperties = {
    background: '#fff',
    borderRadius: 20,
    padding: '24px 28px',
    border: '1px solid rgba(25,68,69,0.04)',
    boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
    marginBottom: 12,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '2.2px',
    color: 'var(--gold)',
    marginBottom: 10,
  };

  return (
    <div style={{ maxWidth: 620, margin: '0 auto', padding: '48px 0 64px' }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1
          style={{
            fontFamily: 'var(--df)',
            fontSize: 26,
            color: 'var(--t1)',
            fontWeight: 400,
            letterSpacing: '-0.02em',
            lineHeight: 1.15,
            marginBottom: 8,
          }}
        >
          Alerts
        </h1>
        <p style={{ fontSize: 14, color: 'var(--t2)', lineHeight: 1.7 }}>
          System incidents and overdue loan alerts from Firestore.
        </p>
      </div>

      {/* Severity Count Badges */}
      <div
        style={{ display: 'flex', gap: 12, marginBottom: 28, flexWrap: 'wrap' }}
      >
        {(
          [
            ['critical', counts.critical],
            ['warning', counts.warning],
            ['info', counts.info],
          ] as [Severity, number][]
        ).map(([sev, count]) => (
          <div
            key={sev}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: severityConfig[sev].badgeBg,
              border: `1px solid ${severityConfig[sev].border}`,
              borderRadius: 60,
              padding: '8px 18px',
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: severityConfig[sev].dot,
              }}
            />
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: severityConfig[sev].text,
                textTransform: 'capitalize',
              }}
            >
              {sev}
            </span>
            <span
              style={{
                fontFamily: 'var(--df)',
                fontSize: 16,
                color: severityConfig[sev].text,
              }}
            >
              {count}
            </span>
          </div>
        ))}
      </div>

      {/* Filter Tabs */}
      <div
        style={{
          display: 'flex',
          gap: 32,
          borderBottom: '1px solid rgba(25,68,69,0.06)',
          marginBottom: 24,
        }}
      >
        {filterTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            style={{
              fontSize: 12,
              fontWeight: filter === t.key ? 700 : 500,
              color: filter === t.key ? 'var(--brand)' : 'var(--t3)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              padding: '14px 0',
              background: 'none',
              border: 'none',
              borderBottom:
                filter === t.key
                  ? '2px solid var(--gold)'
                  : '2px solid transparent',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div
          style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--t3)' }}
        >
          <p style={{ fontSize: 14 }}>Loading alerts...</p>
        </div>
      )}

      {/* Active Alerts */}
      {!loading && filtered(activeAlerts).length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ ...labelStyle, marginBottom: 16 }}>
            Active ({filtered(activeAlerts).length})
          </div>
          {filtered(activeAlerts).map((alert) => {
            const sev = getSeverity(alert);
            const cfg = severityConfig[sev];
            const key = `${alert.kind}-${alert.id}`;
            return (
              <div
                key={key}
                style={{
                  ...cardStyle,
                  borderLeft: `3px solid ${cfg.dot}`,
                  background: cfg.bg,
                  borderColor: cfg.border,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 16,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Source + Severity */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: cfg.text,
                          background: cfg.badgeBg,
                          padding: '3px 10px',
                          borderRadius: 20,
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }}
                      >
                        {sev}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--t2)',
                          background: 'rgba(25,68,69,0.04)',
                          padding: '3px 10px',
                          borderRadius: 20,
                        }}
                      >
                        {getSourceLabel(alert)}
                      </span>
                    </div>

                    {/* Message */}
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: 'var(--t1)',
                        lineHeight: 1.5,
                        marginBottom: 6,
                        wordBreak: 'break-word',
                      }}
                    >
                      {getMessage(alert)}
                    </div>

                    {/* Timestamp */}
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--t3)',
                        display: 'flex',
                        gap: 8,
                      }}
                    >
                      <span>{fmtDate(getTimestamp(alert))}</span>
                      <span>{fmtRelative(getTimestamp(alert))}</span>
                    </div>
                  </div>

                  {/* Dismiss Button */}
                  <button
                    onClick={() => dismiss(alert)}
                    disabled={dismissing === key}
                    style={{
                      background: 'rgba(25,68,69,0.06)',
                      color: 'var(--t2)',
                      borderRadius: 60,
                      padding: '8px 18px',
                      fontSize: 11,
                      fontWeight: 600,
                      border: 'none',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      whiteSpace: 'nowrap',
                      opacity: dismissing === key ? 0.5 : 1,
                    }}
                  >
                    {dismissing === key ? 'Dismissing...' : 'Dismiss'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Resolved Alerts */}
      {!loading && filtered(resolvedAlerts).length > 0 && (
        <div>
          <div style={{ ...labelStyle, marginBottom: 16, color: 'var(--t3)' }}>
            Resolved ({filtered(resolvedAlerts).length})
          </div>
          {filtered(resolvedAlerts).map((alert) => {
            const key = `${alert.kind}-${alert.id}`;
            return (
              <div
                key={key}
                style={{
                  ...cardStyle,
                  opacity: 0.55,
                  borderLeft: '3px solid rgba(25,68,69,0.08)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 16,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: 'var(--brand-light)',
                          background: 'rgba(36,122,110,0.06)',
                          padding: '3px 10px',
                          borderRadius: 20,
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }}
                      >
                        Resolved
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--t2)',
                          background: 'rgba(25,68,69,0.04)',
                          padding: '3px 10px',
                          borderRadius: 20,
                        }}
                      >
                        {getSourceLabel(alert)}
                      </span>
                    </div>

                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: 'var(--t1)',
                        lineHeight: 1.5,
                        marginBottom: 6,
                        wordBreak: 'break-word',
                      }}
                    >
                      {getMessage(alert)}
                    </div>

                    <div style={{ fontSize: 12, color: 'var(--t3)' }}>
                      {fmtDate(getTimestamp(alert))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty State */}
      {!loading && alerts.length === 0 && (
        <div
          style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--t3)' }}
        >
          <p style={{ fontSize: 14 }}>No alerts recorded.</p>
        </div>
      )}

      {/* Empty Filtered State */}
      {!loading &&
        alerts.length > 0 &&
        filtered(activeAlerts).length === 0 &&
        filtered(resolvedAlerts).length === 0 && (
          <div
            style={{
              textAlign: 'center',
              padding: '48px 24px',
              color: 'var(--t3)',
            }}
          >
            <p style={{ fontSize: 14 }}>
              No {filter === 'all' ? '' : filter.replace('_', ' ')} alerts.
            </p>
          </div>
        )}
    </div>
  );
}
