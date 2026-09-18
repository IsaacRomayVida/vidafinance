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

/** Bars are paper; only the states that mean money is live/repaid are green. */
const STATUS_GREEN = new Set(['approved', 'active', 'disbursed', 'repaid']);

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
    <div className="ops-page">
      {/* Header */}
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">Cartera</div>
          <h1 className="ops-title">Portfolio Analytics</h1>
          <p className="ops-sub">Loan portfolio performance, risk metrics, and employer breakdown.</p>
        </div>
        {/* Period filter */}
        <div className="ops-chips">
          {periodOptions.map((opt) => {
            const on = period === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setPeriod(opt.value)}
                className={`ops-chip${on ? ' on' : ''}`}
                aria-pressed={on}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="ops-card" style={{ textAlign: 'center', padding: 48 }} aria-busy="true">
          <p className="ops-note">Loading portfolio data...</p>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="ops-card">
          <p className="ops-error">Error: {error}</p>
        </div>
      )}

      {/* Main content */}
      {report && !loading && (
        <>
          {/* Key metrics */}
          <div className="ops-kpis" style={{ marginTop: 0, marginBottom: 10 }}>
            <div className="ops-kpi">
              <small>Loans Disbursed</small>
              <b>{fmt(summary!.totalLoans)}</b>
              <em>{fmtCurrency(summary!.totalDisbursedMXN)} MXN total</em>
            </div>
            <div className="ops-kpi">
              <small>Active Loans</small>
              <b>{fmt(activeCount)}</b>
              <em>{fmtCurrency(summary!.totalDisbursedMXN - summary!.totalRepaidMXN)} MXN outstanding</em>
            </div>
            <div className="ops-kpi">
              <small>Default Rate</small>
              {/* An absent rate renders as an explicit em-dash, never as a
                  number. React renders null as nothing, which would have left
                  this tile silently blank and read as "fine". */}
              <b>{summary!.defaultRate ?? '—'}</b>
              {/* The backend has never measured days-late: there is no
                  days-overdue field on the loan doc. This figure is the
                  share of disbursed VOLUME sitting anywhere on the default
                  ladder. The old ">30 days" subtitle described a metric that
                  does not exist. */}
              <em>
                {summary!.defaultRate === null
                  ? 'No disbursed volume yet'
                  : 'Share of disbursed volume overdue, in collections or written off'}
              </em>
            </div>
            <div className="ops-kpi">
              <small>Avg Loan Size</small>
              <b>{fmtCurrency(avgLoanSize)}</b>
              <em>MXN per loan</em>
            </div>
            <div className="ops-kpi">
              <small>Repayment Rate</small>
              <b>{repaymentRate}</b>
              <em>{fmtCurrency(summary!.totalRepaidMXN)} MXN collected</em>
            </div>
            <div className="ops-kpi">
              <small>Revenue</small>
              <b>{fmtCurrency(summary!.totalRevenueMXN)}</b>
              <em>Fees collected (MXN)</em>
            </div>
          </div>

          {/* Loan volume by status - bar chart */}
          <section className="ops-card">
            <h2 className="ops-h3">Loan Volume by Status</h2>
            {statusEntries.length === 0 && (
              <p className="ops-note">No loan data for this period.</p>
            )}
            {statusEntries.map(([status, count]) => (
              <div key={status} className="ops-bar-row">
                <div className="ops-bar-meta">
                  <span>{STATUS_LABELS[status] || status}</span>
                  <span>{count}</span>
                </div>
                <div className="ops-bar" aria-hidden="true">
                  <i
                    className={STATUS_GREEN.has(status) ? 'g' : undefined}
                    style={{ width: `${(count / maxStatusCount) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </section>

          {/* Top employers by loan volume */}
          <section className="ops-card">
            <h2 className="ops-h3">Top Employers by Loan Volume</h2>
            {topEmployers.length === 0 && (
              <p className="ops-note">No employer data for this period.</p>
            )}
            {topEmployers.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Employer</th>
                      <th className="num">Loans</th>
                      <th className="num">Volume (MXN)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topEmployers.map(([employerId, data]) => (
                      <tr key={employerId}>
                        <td style={{ fontWeight: 500, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>{employerId}</td>
                        <td className="num">{fmt(data.count)}</td>
                        <td className="num">{fmtCurrency(data.volume)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Report timestamp */}
          <div className="ops-note" style={{ textAlign: 'center', padding: '8px 0' }}>
            Report generated {new Date(report.generatedAt).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}
