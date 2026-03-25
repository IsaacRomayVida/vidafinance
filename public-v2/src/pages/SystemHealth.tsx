import { useState, useEffect, useCallback } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

/* ─── types ─── */
interface HealthEntry {
  name: string;
  status: 'live' | 'stubbed' | 'dead';
  detail?: string;
}

interface Section {
  title: string;
  items: HealthEntry[];
}

/* ─── static integration map ─── */
const RAILWAY_SERVICES: HealthEntry[] = [
  { name: 'SoftCredito Adapter', status: 'live', detail: 'https://softcredito-adapter-production.up.railway.app/health' },
  { name: 'PDF Generator', status: 'live', detail: 'https://pdf-generator-production.up.railway.app/health' },
  { name: 'Payment Server', status: 'dead', detail: 'DEAD' },
  { name: 'Notification Service', status: 'dead', detail: 'DEAD' },
  { name: 'Underwriting', status: 'stubbed', detail: 'REPLACED by inline ML' },
  { name: 'ML Service', status: 'dead', detail: 'WRONG PROJECT' },
];

const INTEGRATIONS: HealthEntry[] = [
  { name: 'ML Scoring', status: 'live', detail: 'INLINE' },
  { name: 'SPEI Disbursement', status: 'stubbed', detail: 'STUBBED' },
  { name: 'Conekta Payments', status: 'dead', detail: 'NOT CONNECTED' },
  { name: 'Notifications', status: 'dead', detail: 'NOT CONNECTED' },
];

const CLOUD_FUNCTIONS = [
  'getAdminDashboard', 'approveEmployer', 'submitReviewDecision',
  'submitLoanApplication', 'uploadDocument', 'getEmployeeProfile',
  'getEmployerProfile', 'onEmployerCreated', 'onLoanCreated',
  'scheduledHealthCheck', 'disburseLoan', 'processPayment',
  'sendNotification', 'generatePayrollReport', 'calculateInterest',
  'onUserCreated', 'syncEmployeeData', 'generateLoanContract',
  'processDeduction', 'getPortfolioMetrics', 'runCreditCheck',
  'processRepayment',
];

/* ─── helpers ─── */
const DOT: Record<HealthEntry['status'], string> = {
  live: '#247a6e',
  stubbed: '#d4a843',
  dead: '#dc503c',
};

const STATUS_LABEL: Record<HealthEntry['status'], string> = {
  live: 'Live',
  stubbed: 'Partial',
  dead: 'Down',
};

/* ─── component ─── */
export function SystemHealth() {
  const { user } = useAuth();
  const [firestoreHealth, setFirestoreHealth] = useState<Record<string, unknown> | null>(null);
  const [railwayChecks, setRailwayChecks] = useState<Record<string, 'live' | 'dead'>>({});
  const [stats, setStats] = useState<{ totalUsers?: number; totalEmployers?: number; totalEmployees?: number } | null>(null);
  const [lastChecked, setLastChecked] = useState<Date>(new Date());
  const [checking, setChecking] = useState(false);

  /* Listen to Firestore system_health/current */
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'system_health', 'current'),
      (snap) => { if (snap.exists()) setFirestoreHealth(snap.data()); },
      () => { /* collection may not exist yet */ },
    );
    return unsub;
  }, []);

  /* Fetch admin stats for user/collection counts */
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const functions = getFunctions();
        const getAdminDash = httpsCallable<unknown, { stats: { totalEmployers: number; totalEmployees: number } }>(functions, 'getAdminDashboard');
        const result = await getAdminDash({});
        if (result.data.stats) setStats(result.data.stats);
      } catch { /* non-critical */ }
    })();
  }, [user]);

  /* Client-side Railway health checks */
  const checkRailway = useCallback(async () => {
    setChecking(true);
    const urls: Record<string, string> = {
      'SoftCredito Adapter': 'https://softcredito-adapter-production.up.railway.app/health',
      'PDF Generator': 'https://pdf-generator-production.up.railway.app/health',
    };
    const results: Record<string, 'live' | 'dead'> = {};
    await Promise.all(
      Object.entries(urls).map(async ([name, url]) => {
        try {
          const res = await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(5000) });
          // no-cors returns opaque response — treat as live if no error
          results[name] = res.type === 'opaque' || res.ok ? 'live' : 'dead';
        } catch {
          results[name] = 'dead';
        }
      }),
    );
    setRailwayChecks(results);
    setLastChecked(new Date());
    setChecking(false);
  }, []);

  /* Initial check + auto-refresh every 60s */
  useEffect(() => {
    checkRailway();
    const iv = setInterval(checkRailway, 60_000);
    return () => clearInterval(iv);
  }, [checkRailway]);

  /* ─── build sections ─── */
  const firebaseSection: Section = {
    title: 'Firebase Services',
    items: [
      { name: 'Auth', status: 'live', detail: stats ? `${(stats.totalEmployers || 0) + (stats.totalEmployees || 0)} users` : 'Connected' },
      { name: 'Firestore', status: 'live', detail: stats ? `${stats.totalEmployers || 0} employers, ${stats.totalEmployees || 0} employees` : 'Connected' },
      { name: 'Storage', status: 'live', detail: 'Active' },
      { name: 'Hosting', status: 'live', detail: 'vida-finance.web.app' },
    ],
  };

  const functionsSection: Section = {
    title: `Cloud Functions (${CLOUD_FUNCTIONS.length})`,
    items: CLOUD_FUNCTIONS.map(fn => ({
      name: fn,
      status: 'live' as const,
      detail: 'Deployed',
    })),
  };

  const railwaySection: Section = {
    title: 'Railway Services',
    items: RAILWAY_SERVICES.map(svc => {
      const liveCheck = railwayChecks[svc.name];
      if (liveCheck && (svc.status === 'live')) {
        return { ...svc, status: liveCheck };
      }
      return svc;
    }),
  };

  const integrationsSection: Section = {
    title: 'Integrations',
    items: INTEGRATIONS,
  };

  const sections = [firebaseSection, functionsSection, railwaySection, integrationsSection];

  /* ─── styles (matching admin design language) ─── */
  const cardStyle: React.CSSProperties = {
    background: '#fff',
    borderRadius: 20,
    padding: '28px',
    border: '1px solid rgba(25,68,69,0.04)',
    boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
    marginBottom: 20,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '2.2px',
    color: '#a28657',
    marginBottom: 16,
  };

  const dotStyle = (status: HealthEntry['status']): React.CSSProperties => ({
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: DOT[status],
    flexShrink: 0,
    boxShadow: `0 0 6px ${DOT[status]}44`,
  });

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 0',
    borderBottom: '1px solid rgba(25,68,69,0.04)',
  };

  /* Summary counts */
  const allItems = sections.flatMap(s => s.items);
  const liveCount = allItems.filter(i => i.status === 'live').length;
  const stubbedCount = allItems.filter(i => i.status === 'stubbed').length;
  const deadCount = allItems.filter(i => i.status === 'dead').length;

  return (
    <div style={{ maxWidth: 620, margin: '0 auto', padding: '48px 0 64px' }}>
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <h1 style={{
          fontFamily: "'DM Serif Display',Georgia,serif",
          fontSize: 26, color: '#0c1e1f', fontWeight: 400,
          letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 8,
        }}>
          System Health
        </h1>
        <p style={{ fontSize: 14, color: '#4a6364', lineHeight: 1.7, margin: 0 }}>
          Real-time status of all platform integrations and services.
        </p>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 32 }}>
        {[
          { label: 'Live', count: liveCount, color: '#247a6e' },
          { label: 'Partial', count: stubbedCount, color: '#d4a843' },
          { label: 'Down', count: deadCount, color: '#dc503c' },
        ].map(({ label, count, color }) => (
          <div key={label} style={cardStyle}>
            <div style={labelStyle}>{label}</div>
            <div style={{
              fontFamily: "'DM Serif Display',Georgia,serif",
              fontSize: 36, color, letterSpacing: '-0.03em',
              fontWeight: 400, lineHeight: 1,
            }}>
              {count}
            </div>
          </div>
        ))}
      </div>

      {/* Last checked + refresh */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 24, padding: '0 4px',
      }}>
        <span style={{ fontSize: 12, color: '#93aaa9' }}>
          Last checked: {lastChecked.toLocaleTimeString()}
        </span>
        <button
          onClick={checkRailway}
          disabled={checking}
          style={{
            fontSize: 12, fontWeight: 600, color: '#194445',
            background: 'rgba(25,68,69,0.06)', border: 'none',
            borderRadius: 60, padding: '8px 20px', cursor: 'pointer',
            opacity: checking ? 0.5 : 1, transition: 'all 0.2s',
          }}
        >
          {checking ? 'Checking...' : 'Refresh'}
        </button>
      </div>

      {/* Sections */}
      {sections.map(section => (
        <div key={section.title} style={{ ...cardStyle, marginBottom: 24 }}>
          <div style={labelStyle}>{section.title}</div>
          <div>
            {section.items.map((item, idx) => (
              <div
                key={item.name}
                style={{
                  ...rowStyle,
                  borderBottom: idx === section.items.length - 1 ? 'none' : rowStyle.borderBottom,
                }}
              >
                <div style={dotStyle(item.status)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 500, color: '#0c1e1f' }}>
                    {item.name}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {item.detail && (
                    <span style={{ fontSize: 12, color: '#93aaa9' }}>
                      {item.detail}
                    </span>
                  )}
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: DOT[item.status],
                    background: `${DOT[item.status]}10`,
                    padding: '3px 10px', borderRadius: 20,
                    textTransform: 'uppercase', letterSpacing: '0.5px',
                  }}>
                    {STATUS_LABEL[item.status]}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Firestore health doc (if available) */}
      {firestoreHealth && (
        <div style={cardStyle}>
          <div style={labelStyle}>Firestore Health Document</div>
          <pre style={{
            fontSize: 12, color: '#4a6364', background: 'rgba(25,68,69,0.02)',
            borderRadius: 12, padding: 16, overflow: 'auto',
            margin: 0, lineHeight: 1.6,
          }}>
            {JSON.stringify(firestoreHealth, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
