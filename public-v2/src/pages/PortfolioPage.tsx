import { useState, useEffect } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useAuth } from '../hooks/useAuth';

interface PortfolioSummary {
  totalLoans: number;
  totalDisbursedMXN: number;
  totalRepaidMXN: number;
  totalRevenueMXN: number;
  // null when there is no disbursed volume to divide by. The backend
  // deliberately returns null rather than a fabricated '0%' so an empty or
  // all-pending book cannot read as a clean bill of health.
  defaultRate: string | null;
}

interface PortfolioReport {
  period: string;
  summary: PortfolioSummary;
  byStatus: Record<string, number>;
  byEmployer: Record<string, { count: number; volume: number }>;
  generatedAt: string;
}

type Period = '7d' | '30d' | '90d' | 'all';

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtCurrency(n: number): string {
  return '$' + fmt(n);
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  approved: 'Approved',
  // 'active' and 'disbursed' are two live spellings of the same thing (the
  // automatic adapter path vs the manual ops-confirmed path). 'active' was
  // missing here entirely, so every automatically-disbursed loan rendered
  // under the raw key.
  active: 'Disbursed (auto)',
  disbursed: 'Disbursed',
  disbursement_queued: 'Queued',
  repaid: 'Repaid',
  overdue: 'Overdue',
  in_collections: 'In Collections',
  written_off: 'Written Off',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--gold)',
  approved: 'var(--brand-light)',
  active: 'var(--brand)',
  disbursed: 'var(--brand)',
  disbursement_queued: 'var(--t2)',
  repaid: 'var(--brand-light)',
  overdue: 'var(--danger)',
  in_collections: 'var(--danger)',
  written_off: 'var(--t3)',
  rejected: 'var(--t3)',
  cancelled: 'var(--t3)',
};

export function PortfolioPage() {
  const { user } = useAuth();
  const [report, setReport] = useState<PortfolioReport | null>(null);
  const [period, setPeriod] = useState<Period>('30d');
  const [loading, setLoading] = useState(true);
  const [error] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const functions = getFunctions();
        const getReport = httpsCallable<{ period: Period }, PortfolioReport>(functions, 'getPortfolioReport');
        const result = await getReport({ period });
        if (!cancelled) {
          setReport(result.data);
          setLoading(false);
        }
      } catch (e: unknown) {
        console.warn('getPortfolioReport error:', e);
        if (!cancelled) {
          // Show empty state instead of error
          setReport({
            period,
            // defaultRate stays null on the error path: we did not fetch the
            // book, so we do not know it. Rendering '0%' here told an admin the
            // portfolio was performing perfectly at the exact moment the report
            // failed to load.
            summary: { totalLoans: 0, totalDisbursedMXN: 0, totalRepaidMXN: 0, totalRevenueMXN: 0, defaultRate: null },
            byStatus: {},
            byEmployer: {},
            generatedAt: new Date().toISOString(),
          });
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user, period]);

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
    color: 'var(--gold)',
    marginBottom: 10,
  };

  const valueStyle: React.CSSProperties = {
    fontFamily: 'var(--df)',
    fontSize: 36,
    color: 'var(--t1)',
    letterSpacing: '-0.03em',
    fontWeight: 400,
    lineHeight: 1,
  };

  const subValueStyle: React.CSSProperties = {
    fontSize: 12,
    color: 'var(--t3)',
    marginTop: 6,
  };

  // Compute derived metrics
  const summary = report?.summary;
  // Loans with money out and not yet repaid. This previously counted
  // 'approved' and 'disbursement_queued' — neither of which has sent a peso —
  // while omitting 'active', the spelling the automatic disbursement path
  // writes, so the tile missed every auto-disbursed loan and padded the count
  // with loans that had not been funded. 'written_off' is money out but no
  // longer a live receivable, so it stays out of this tile.
  const activeStatuses = ['active', 'disbursed', 'overdue', 'in_collections'];
  const activeCount = report ? activeStatuses.reduce((sum, s) => sum + (report.byStatus[s] || 0), 0) : 0;
  const avgLoanSize = summary && summary.totalLoans > 0 ? summary.totalDisbursedMXN / summary.totalLoans : 0;
  const repaymentRate = summary && summary.totalDisbursedMXN > 0
    ? ((summary.totalRepaidMXN / summary.totalDisbursedMXN) * 100).toFixed(1) + '%'
    : '0%';

  // Sort employers by volume descending
  const topEmployers = report
    ? Object.entries(report.byEmployer)
        .sort(([, a], [, b]) => b.volume - a.volume)
        .slice(0, 10)
    : [];

  // Status chart data
  const statusEntries = report
    ? Object.entries(report.byStatus).sort(([, a], [, b]) => b - a)
    : [];
  const maxStatusCount = statusEntries.length > 0 ? Math.max(...statusEntries.map(([, v]) => v)) : 1;

  const periodOptions: { value: Period; label: string }[] = [
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: '90d', label: '90 days' },
    { value: 'all', label: 'All time' },
  ];

  return (
    <div style={{ maxWidth: 620, margin: '0 auto', padding: '48px 0 64px' }}>
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontFamily: 'var(--df)', fontSize: 26, color: 'var(--t1)', fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 8 }}>
          Portfolio Analytics
        </h1>
        <p style={{ fontSize: 14, color: 'var(--t2)', lineHeight: 1.7 }}>
          Loan portfolio performance, risk metrics, and employer breakdown.
        </p>
      </div>

      {/* Period filter */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 32 }}>
        {periodOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setPeriod(opt.value)}
            style={{
              background: period === opt.value ? 'var(--brand)' : 'rgba(25,68,69,0.04)',
              color: period === opt.value ? '#fff' : 'var(--t2)',
              borderRadius: 60,
              padding: '8px 20px',
              fontSize: 12,
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              transition: 'all 0.2s',
              letterSpacing: '0.2px',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '64px 24px', color: 'var(--t3)' }}>
          <p style={{ fontSize: 14 }}>Loading portfolio data...</p>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div style={{ ...cardStyle, background: 'rgba(220,80,60,0.04)', borderColor: 'rgba(220,80,60,0.12)' }}>
          <p style={{ fontSize: 14, color: 'var(--danger)' }}>Error: {error}</p>
        </div>
      )}

      {/* Main content */}
      {report && !loading && (
        <>
          {/* Key metrics - 2x3 grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 32 }}>
            <div style={cardStyle}>
              <div style={labelStyle}>Loans Disbursed</div>
              <div style={valueStyle}>{fmt(summary!.totalLoans)}</div>
              <div style={subValueStyle}>{fmtCurrency(summary!.totalDisbursedMXN)} MXN total</div>
            </div>
            <div style={cardStyle}>
              <div style={labelStyle}>Active Loans</div>
              <div style={valueStyle}>{fmt(activeCount)}</div>
              <div style={subValueStyle}>{fmtCurrency(summary!.totalDisbursedMXN - summary!.totalRepaidMXN)} MXN outstanding</div>
            </div>
            <div style={cardStyle}>
              <div style={labelStyle}>Default Rate</div>
              {/* An absent rate renders as an explicit em-dash, never as a
                  number. React renders null as nothing, which would have left
                  this tile silently blank and read as "fine". */}
              <div style={valueStyle}>{summary!.defaultRate ?? '—'}</div>
              {/* The backend has never measured days-late: there is no
                  days-overdue field on the loan doc. This figure is the
                  share of disbursed VOLUME sitting anywhere on the default
                  ladder. The old ">30 days" subtitle described a metric that
                  does not exist. */}
              <div style={subValueStyle}>
                {summary!.defaultRate === null
                  ? 'No disbursed volume yet'
                  : 'Share of disbursed volume overdue, in collections or written off'}
              </div>
            </div>
            <div style={cardStyle}>
              <div style={labelStyle}>Avg Loan Size</div>
              <div style={valueStyle}>{fmtCurrency(avgLoanSize)}</div>
              <div style={subValueStyle}>MXN per loan</div>
            </div>
            <div style={cardStyle}>
              <div style={labelStyle}>Repayment Rate</div>
              <div style={valueStyle}>{repaymentRate}</div>
              <div style={subValueStyle}>{fmtCurrency(summary!.totalRepaidMXN)} MXN collected</div>
            </div>
            <div style={cardStyle}>
              <div style={labelStyle}>Revenue</div>
              <div style={valueStyle}>{fmtCurrency(summary!.totalRevenueMXN)}</div>
              <div style={subValueStyle}>Fees collected (MXN)</div>
            </div>
          </div>

          {/* Loan volume by status - bar chart */}
          <div style={{ ...cardStyle, padding: '32px 28px' }}>
            <div style={{ ...labelStyle, marginBottom: 24 }}>Loan Volume by Status</div>
            {statusEntries.length === 0 && (
              <p style={{ fontSize: 13, color: 'var(--t3)' }}>No loan data for this period.</p>
            )}
            {statusEntries.map(([status, count]) => (
              <div key={status} style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t1)' }}>
                    {STATUS_LABELS[status] || status}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t2)' }}>{count}</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'rgba(25,68,69,0.04)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${(count / maxStatusCount) * 100}%`,
                      borderRadius: 4,
                      background: STATUS_COLORS[status] || 'var(--brand)',
                      transition: 'width 0.4s ease',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Top employers by loan volume */}
          <div style={{ ...cardStyle, padding: '32px 28px' }}>
            <div style={{ ...labelStyle, marginBottom: 24 }}>Top Employers by Loan Volume</div>
            {topEmployers.length === 0 && (
              <p style={{ fontSize: 13, color: 'var(--t3)' }}>No employer data for this period.</p>
            )}
            {topEmployers.length > 0 && (
              <div>
                {/* Table header */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 120px', gap: 12, paddingBottom: 12, borderBottom: '1px solid rgba(25,68,69,0.06)' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--t3)' }}>Employer</div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--t3)', textAlign: 'right' }}>Loans</div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--t3)', textAlign: 'right' }}>Volume (MXN)</div>
                </div>
                {/* Table rows */}
                {topEmployers.map(([employerId, data], i) => (
                  <div
                    key={employerId}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 100px 120px',
                      gap: 12,
                      padding: '14px 0',
                      borderBottom: i < topEmployers.length - 1 ? '1px solid rgba(25,68,69,0.04)' : 'none',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {employerId}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t2)', textAlign: 'right' }}>
                      {fmt(data.count)}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', textAlign: 'right', fontFamily: 'var(--df)' }}>
                      {fmtCurrency(data.volume)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Report timestamp */}
          <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--t3)', fontSize: 11 }}>
            Report generated {new Date(report.generatedAt).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}
