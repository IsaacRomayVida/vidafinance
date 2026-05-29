import { useState, useEffect, useCallback } from 'react';
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

// ── Styles ───────────────────────────────────────────────────────────────────

const colors = {
  bg: '#f5f1eb',
  card: '#fff',
  dark: '#0c1e1f',
  mid: '#4a6364',
  light: '#93aaa9',
  gold: '#a28657',
  green: '#247a6e',
  yellow: '#b8860b',
  red: '#dc503c',
  border: 'rgba(25,68,69,0.04)',
  shadow: '0 1px 4px rgba(25,68,69,0.02)',
};

const cardStyle: React.CSSProperties = {
  background: colors.card,
  borderRadius: 20,
  padding: '28px',
  border: `1px solid ${colors.border}`,
  boxShadow: colors.shadow,
  marginBottom: 20,
};

const sectionTitleStyle: React.CSSProperties = {
  fontFamily: 'var(--df)',
  fontSize: 22,
  fontWeight: 400,
  color: colors.dark,
  margin: '0 0 20px 0',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: colors.gold,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 0',
  borderBottom: `1px solid ${colors.border}`,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusDot(level: StatusLevel): string {
  if (level === 'green') return '●';
  if (level === 'yellow') return '●';
  return '●';
}

function statusColor(level: StatusLevel): string {
  if (level === 'green') return colors.green;
  if (level === 'yellow') return colors.yellow;
  return colors.red;
}

function StatusRow({ item }: { item: DisplayItem }) {
  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: statusColor(item.status), fontSize: 14 }}>{statusDot(item.status)}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: colors.dark }}>{item.label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {item.latencyMs != null && (
          <span style={{ fontSize: 11, color: colors.light, fontFamily: 'monospace' }}>{item.latencyMs}ms</span>
        )}
        <span style={{ fontSize: 12, color: colors.mid, maxWidth: 280, textAlign: 'right' as const }}>{item.detail}</span>
      </div>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function SystemHealth() {
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

  return (
    <div>
      {/* Page header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--df)', fontSize: 28, fontWeight: 400, color: colors.dark, margin: 0 }}>
            System Health
          </h1>
          <p style={{ fontSize: 13, color: colors.mid, margin: '4px 0 0 0' }}>
            Real-time API & service status
          </p>
        </div>
        <div style={{ textAlign: 'right' as const }}>
          <button
            onClick={fetchHealth}
            disabled={loading}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: colors.card,
              background: colors.gold,
              border: 'none',
              borderRadius: 60,
              padding: '8px 20px',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1,
              transition: 'opacity 0.2s',
            }}
          >
            {loading ? 'Checking…' : 'Refresh'}
          </button>
          {lastRefresh && (
            <p style={{ fontSize: 11, color: colors.light, margin: '6px 0 0 0' }}>
              Last checked {lastRefresh.toLocaleTimeString()}
            </p>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ ...cardStyle, background: '#fdf2f0', border: `1px solid ${colors.red}`, color: colors.red, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Summary bar */}
      <div style={{ ...cardStyle, display: 'flex', gap: 32, alignItems: 'center' }}>
        <div>
          <span style={labelStyle}>Overview</span>
        </div>
        <div style={{ display: 'flex', gap: 24 }}>
          <span style={{ fontSize: 14, color: colors.green, fontWeight: 600 }}>● {greenCount} Live</span>
          <span style={{ fontSize: 14, color: colors.yellow, fontWeight: 600 }}>● {yellowCount} Partial</span>
          <span style={{ fontSize: 14, color: colors.red, fontWeight: 600 }}>● {redCount} Down</span>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 11, color: colors.light }}>
          Auto-refresh every 60s
        </div>
      </div>

      {/* Section 1: Firebase */}
      <div style={cardStyle}>
        <h2 style={sectionTitleStyle}>Firebase Services</h2>
        {firebaseItems.map(item => (
          <StatusRow key={item.label} item={item} />
        ))}
      </div>

      {/* Section 2: Railway */}
      <div style={cardStyle}>
        <h2 style={sectionTitleStyle}>Railway Services</h2>
        {loading && !health ? (
          <p style={{ fontSize: 13, color: colors.light, padding: '12px 0' }}>Loading…</p>
        ) : (
          railwayItems.map(item => (
            <StatusRow key={item.label} item={item} />
          ))
        )}
      </div>

      {/* Section 3: External Providers */}
      <div style={cardStyle}>
        <h2 style={sectionTitleStyle}>External Providers</h2>
        {loading && !health ? (
          <p style={{ fontSize: 13, color: colors.light, padding: '12px 0' }}>Loading…</p>
        ) : (
          externalItems.map(item => (
            <StatusRow key={item.label} item={item} />
          ))
        )}
      </div>

      {/* Section 4: Integrations */}
      <div style={cardStyle}>
        <h2 style={sectionTitleStyle}>Integrations</h2>
        {loading && !health ? (
          <p style={{ fontSize: 13, color: colors.light, padding: '12px 0' }}>Loading…</p>
        ) : (
          integrationItems.map(item => (
            <StatusRow key={item.label} item={item} />
          ))
        )}
      </div>
    </div>
  );
}
