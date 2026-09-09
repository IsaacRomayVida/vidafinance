import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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

/* ─── Severity → status pill class (never green: an alert is never "approved") ─── */

const severityClass: Record<Severity, string> = {
  critical: ' bad',
  warning: ' warn',
  info: '',
};

/* ─── Component ────────────────────────────────────────────────────── */

export function AlertsPage() {
  const { t } = useTranslation();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
      setError(null);
    } catch (e) {
      console.error('Failed to dismiss alert:', e);
      setError('No se pudo resolver la alerta. Intenta de nuevo.');
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
    { key: 'all', label: t('alerts_filter_all') },
    { key: 'overdue', label: t('alerts_filter_overdue') },
    { key: 'system', label: t('alerts_filter_system') },
    { key: 'payment_failure', label: t('alerts_filter_payment') },
  ];

  const severityLabel: Record<Severity, string> = {
    critical: t('alerts_sev_critical'),
    warning: t('alerts_sev_warning'),
    info: t('alerts_sev_info'),
  };

  return (
    <div className="ops-page">
      {/* Header */}
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_ops')}</div>
          <h1 className="ops-title">{t('alerts_title')}</h1>
          <p className="ops-sub">{t('alerts_subtitle')}</p>
        </div>
      </div>

      {/* Severity counts */}
      <div className="ops-kpis" style={{ marginTop: 0, marginBottom: 10 }}>
        {(
          [
            ['critical', counts.critical],
            ['warning', counts.warning],
            ['info', counts.info],
          ] as [Severity, number][]
        ).map(([sev, count]) => (
          <div key={sev} className={`ops-kpi${count > 0 && sev !== 'info' ? ' warn' : ''}`}>
            <small>{severityLabel[sev]}</small>
            <b>{count}</b>
          </div>
        ))}
      </div>

      {/* Filter chips */}
      <div className="ops-chips" style={{ margin: '4px 4px 14px' }}>
        {filterTabs.map((tab) => {
          const on = filter === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              className={`ops-chip${on ? ' on' : ''}`}
              aria-pressed={on}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Errors / loading */}
      {error && (
        <div role="alert" className="ops-error" style={{ marginBottom: 10, padding: '12px 16px' }}>
          {error}
        </div>
      )}
      {loading && (
        <div className="ops-card" style={{ textAlign: 'center', padding: 48 }} aria-busy="true">
          <p className="ops-note">{t('alerts_loading')}</p>
        </div>
      )}

      {/* Active Alerts */}
      {!loading && filtered(activeAlerts).length > 0 && (
        <section className="ops-card">
          <h2 className="ops-h3">{t('alerts_active', { count: filtered(activeAlerts).length })}</h2>
          {filtered(activeAlerts).map((alert) => {
            const sev = getSeverity(alert);
            const key = `${alert.kind}-${alert.id}`;
            return (
              <div key={key} className="ops-batch" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <span className="fl" aria-hidden="true" style={{ marginTop: 2 }} />
                <span className="t" style={{ whiteSpace: 'normal' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span className={`ops-status${severityClass[sev]}`}>{severityLabel[sev]}</span>
                    <span className="ops-status mute">{getSourceLabel(alert)}</span>
                  </span>
                  <span style={{ display: 'block', whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.5 }}>{getMessage(alert)}</span>
                  <small style={{ whiteSpace: 'normal' }}>
                    {fmtDate(getTimestamp(alert))} · {fmtRelative(getTimestamp(alert))}
                  </small>
                </span>
                <button
                  type="button"
                  className="ops-btn sm ghost"
                  onClick={() => dismiss(alert)}
                  disabled={dismissing === key}
                >
                  {dismissing === key ? t('alerts_dismissing') : t('alerts_dismiss')}
                </button>
              </div>
            );
          })}
        </section>
      )}

      {/* Resolved Alerts — the only green on this page: resolved = done */}
      {!loading && filtered(resolvedAlerts).length > 0 && (
        <section className="ops-card">
          <h2 className="ops-h3">{t('alerts_resolved', { count: filtered(resolvedAlerts).length })}</h2>
          {filtered(resolvedAlerts).map((alert) => {
            const key = `${alert.kind}-${alert.id}`;
            return (
              <div key={key} className="ops-batch" style={{ flexWrap: 'wrap', alignItems: 'flex-start', opacity: 0.7 }}>
                <span className="fl g" aria-hidden="true" style={{ marginTop: 2 }} />
                <span className="t" style={{ whiteSpace: 'normal' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span className="ops-status g">{t('alerts_resolved_label')}</span>
                    <span className="ops-status mute">{getSourceLabel(alert)}</span>
                  </span>
                  <span style={{ display: 'block', whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.5 }}>{getMessage(alert)}</span>
                  <small>{fmtDate(getTimestamp(alert))}</small>
                </span>
              </div>
            );
          })}
        </section>
      )}

      {/* Empty State */}
      {!loading && alerts.length === 0 && (
        <div className="ops-card">
          <div className="empty-state">
            <p>{t('alerts_empty')}</p>
          </div>
        </div>
      )}

      {/* Empty Filtered State */}
      {!loading &&
        alerts.length > 0 &&
        filtered(activeAlerts).length === 0 &&
        filtered(resolvedAlerts).length === 0 && (
          <div className="ops-card">
            <div className="empty-state">
              <p>{t('alerts_empty_filtered')}</p>
            </div>
          </div>
        )}
    </div>
  );
}
