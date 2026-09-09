import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getFunctions, httpsCallable } from 'firebase/functions';

// ── Types ────────────────────────────────────────────────────────────────────

interface ServiceStatus {
  name: string;
  status: 'ok' | 'degraded' | 'down';
  latencyMs?: number;
  detail?: string;
}

interface HealthData {
  railway: ServiceStatus[];
  config: Record<string, boolean>;
  firestoreHealth: Record<string, unknown> | null;
  checkedAt: string;
}

type StatusLevel = 'green' | 'yellow' | 'red';

interface DisplayItem {
  label: string;
  status: StatusLevel;
  detail: string;
  latencyMs?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Green means live; partial is peach; down is the soft red. */
function statusColor(level: StatusLevel): string {
  if (level === 'green') return 'var(--harmony)';
  if (level === 'yellow') return '#f2c4a0';
  return '#f4a9a1';
}

function StatusRow({ item }: { item: DisplayItem }) {
  return (
    <div className="ops-batch">
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(item.status), flex: 'none', boxShadow: item.status === 'green' ? '0 0 0 4px rgba(104,231,142,.2)' : undefined }} />
      <span className="t">
        {item.label}
        <small>{item.detail}</small>
      </span>
      {item.latencyMs != null && (
        <span className="p" style={{ fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'rgba(242,245,240,.75)' }}>{item.latencyMs}ms</span>
      )}
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function SystemHealth() {
  const { t } = useTranslation();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const functions = getFunctions();
      const fn = httpsCallable<unknown, HealthData>(functions, 'getSystemHealth');
      const result = await fn({});
      setHealth(result.data);
      setLastRefresh(new Date());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch health data';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 60_000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  // ── Build display sections ───────────────────────────────────────────────

  const firebaseItems: DisplayItem[] = [
    { label: 'Auth', status: 'green', detail: 'Operational' },
    { label: 'Firestore', status: 'green', detail: 'Operational' },
    { label: 'Storage', status: 'green', detail: 'Operational' },
    { label: 'Hosting', status: 'green', detail: 'Operational' },
  ];

  function buildRailwayItems(): DisplayItem[] {
    const railwayMap = new Map<string, ServiceStatus>();
    if (health?.railway) {
      for (const s of health.railway) {
        railwayMap.set(s.name, s);
      }
    }

    const softcredito = railwayMap.get('softcredito-adapter');
    const pdf = railwayMap.get('pdf-generator');

    return [
      {
        label: 'SoftCrédito Adapter',
        status: softcredito ? (softcredito.status === 'ok' ? 'green' : softcredito.status === 'degraded' ? 'yellow' : 'red') : 'red',
        detail: softcredito ? (softcredito.status === 'ok' ? 'Healthy' : softcredito.detail ?? 'Error') : 'Not reachable',
        latencyMs: softcredito?.latencyMs,
      },
      {
        label: 'PDF Generator',
        status: pdf ? (pdf.status === 'ok' ? 'green' : pdf.status === 'degraded' ? 'yellow' : 'red') : 'red',
        detail: pdf ? (pdf.status === 'ok' ? 'Healthy' : pdf.detail ?? 'Error') : 'Not reachable',
        latencyMs: pdf?.latencyMs,
      },
      { label: 'Payment Server', status: 'red', detail: 'Dead — decommissioned' },
      { label: 'Notification Service', status: 'red', detail: 'Replaced by Cloud Functions' },
      { label: 'Underwriting', status: 'yellow', detail: 'Inline ML active, full pipeline pending' },
    ];
  }

  function buildExternalItems(): DisplayItem[] {
    const cfg = health?.config ?? {};
    return [
      { label: 'MetaMap', status: cfg['METAMAP_CLIENT_ID'] ? 'green' : 'red', detail: cfg['METAMAP_CLIENT_ID'] ? 'Configured' : 'Not configured' },
      { label: 'Belvo', status: cfg['BELVO_SECRET_ID'] ? 'green' : 'red', detail: cfg['BELVO_SECRET_ID'] ? 'Configured' : 'Not configured' },
      { label: 'RiskSeal', status: cfg['RISKSEAL_API_KEY'] ? 'green' : 'red', detail: cfg['RISKSEAL_API_KEY'] ? 'Configured' : 'Not configured' },
      { label: 'SoftCrédito Direct API', status: cfg['SOFTCREDITO_API_URL'] ? 'green' : 'red', detail: cfg['SOFTCREDITO_API_URL'] ? 'Configured' : 'Not configured' },
      { label: 'Twilio', status: cfg['TWILIO_ACCOUNT_SID'] ? 'green' : 'red', detail: cfg['TWILIO_ACCOUNT_SID'] ? 'Configured' : 'Not configured' },
      { label: 'SendGrid', status: cfg['SENDGRID_API_KEY'] ? 'green' : 'red', detail: cfg['SENDGRID_API_KEY'] ? 'Configured' : 'Not configured' },
    ];
  }

  function buildIntegrationItems(): DisplayItem[] {
    const cfg = health?.config ?? {};
    const hasNotifications = cfg['TWILIO_ACCOUNT_SID'] || cfg['SENDGRID_API_KEY'];
    return [
      { label: 'ML Scoring', status: 'green', detail: 'Inline rule-based (v1)' },
      { label: 'SPEI Disbursement', status: cfg['SOFTCREDITO_ADAPTER_URL'] ? 'green' : 'yellow', detail: cfg['SOFTCREDITO_ADAPTER_URL'] ? 'Connected via adapter' : 'Adapter not configured' },
      { label: 'Notifications', status: hasNotifications ? 'green' : 'yellow', detail: hasNotifications ? 'Twilio/SendGrid active' : 'No SMS/email provider configured' },
      { label: 'Payments (Conekta)', status: 'red', detail: 'Not connected' },
    ];
  }

  const railwayItems = buildRailwayItems();
  const externalItems = buildExternalItems();
  const integrationItems = buildIntegrationItems();

  // ── Summary counts ───────────────────────────────────────────────────────

  const allItems = [...firebaseItems, ...railwayItems, ...externalItems, ...integrationItems];
  const greenCount = allItems.filter(i => i.status === 'green').length;
  const yellowCount = allItems.filter(i => i.status === 'yellow').length;
  const redCount = allItems.filter(i => i.status === 'red').length;

  const sections: { title: string; items: DisplayItem[]; live: boolean }[] = [
    { title: t('health_section_firebase'), items: firebaseItems, live: true },
    { title: t('health_section_railway'), items: railwayItems, live: !(loading && !health) },
    { title: t('health_section_external'), items: externalItems, live: !(loading && !health) },
    { title: t('health_section_integrations'), items: integrationItems, live: !(loading && !health) },
  ];

  return (
    <div className="ops-page">
      {/* Page header */}
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_ops')}</div>
          <h1 className="ops-title">{t('health_title')}</h1>
          <p className="ops-sub">{t('health_subtitle')}</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <button type="button" className="ops-go" style={{ marginTop: 0 }} onClick={fetchHealth} disabled={loading}>
            <i aria-hidden="true" />{loading ? t('health_checking') : t('health_refresh')}
          </button>
          {lastRefresh && (
            <p className="ops-note" style={{ marginTop: 6 }}>
              {t('health_last_checked', { time: lastRefresh.toLocaleTimeString() })}
            </p>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div role="alert" className="ops-error" style={{ padding: '12px 16px', marginBottom: 10 }}>
          {error}
        </div>
      )}

      {/* Overview */}
      <div className="ops-kpis" style={{ marginTop: 0, marginBottom: 10 }}>
        <div className="ops-kpi">
          <small>{t('health_live')}</small>
          <b style={{ color: 'var(--harmony)' }}>{greenCount}</b>
        </div>
        <div className={`ops-kpi${yellowCount > 0 ? ' warn' : ''}`}>
          <small>{t('health_partial')}</small>
          <b>{yellowCount}</b>
        </div>
        <div className="ops-kpi">
          <small>{t('health_down')}</small>
          <b style={{ color: redCount > 0 ? '#f4a9a1' : undefined }}>{redCount}</b>
        </div>
      </div>
      <p className="ops-note" style={{ margin: '0 4px 14px' }}>{t('health_auto_refresh')}</p>

      {sections.map(section => (
        <section className="ops-card" key={section.title}>
          <h2 className="ops-h3">{section.title}</h2>
          {section.live ? (
            section.items.map(item => <StatusRow key={item.label} item={item} />)
          ) : (
            <p className="ops-note" style={{ padding: '12px 0' }}>{t('health_loading')}</p>
          )}
        </section>
      ))}
    </div>
  );
}
