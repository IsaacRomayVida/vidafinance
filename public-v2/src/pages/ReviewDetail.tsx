import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useAuth } from '../hooks/useAuth';

/* ── types ────────────────────────────────────────────────────────────────── */

interface ReviewDetailData {
  review: Record<string, unknown>;
  loan: Record<string, unknown> | null;
  employee: Record<string, unknown> | null;
  employer: Record<string, unknown> | null;
  mlDecision: Record<string, unknown> | null;
  auditHistory: Record<string, unknown>[];
}

type Decision = 'approved' | 'rejected' | 'request_info' | 'escalate';

/* ── helpers ──────────────────────────────────────────────────────────────── */

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatDate(val: unknown): string {
  if (!val) return '—';
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? String(val) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  if (typeof val === 'object' && val !== null && 'seconds' in val) {
    return new Date((val as { seconds: number }).seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return String(val);
}

/** Safely extract a string from unknown, with fallback */
function str(val: unknown, fallback = '—'): string {
  return typeof val === 'string' && val ? val : fallback;
}

/** Safely extract a number from unknown */
function num(val: unknown): number {
  return typeof val === 'number' ? val : 0;
}

function riskColor(level: string): { bg: string; text: string } {
  switch (level) {
    case 'critical': return { bg: 'rgba(180,40,30,0.10)', text: '#a01c14' };
    case 'high': return { bg: 'rgba(220,80,60,0.08)', text: '#dc503c' };
    case 'medium': return { bg: 'rgba(212,160,60,0.10)', text: '#b08420' };
    case 'low': return { bg: 'rgba(36,122,110,0.08)', text: '#247a6e' };
    default: return { bg: 'rgba(147,170,169,0.10)', text: '#4a6364' };
  }
}

function hoursElapsed(queuedAt: string): number {
  return (Date.now() - new Date(queuedAt).getTime()) / (1000 * 60 * 60);
}

function slaLabel(queuedAt: string): string {
  const elapsed = hoursElapsed(queuedAt);
  const remaining = 24 - elapsed;
  if (remaining <= 0) {
    const over = Math.abs(remaining);
    return `Overdue ${Math.floor(over)}h ${Math.floor((over % 1) * 60)}m`;
  }
  return `${Math.floor(remaining)}h ${Math.floor((remaining % 1) * 60)}m left`;
}

/* ── component ────────────────────────────────────────────────────────────── */

export function ReviewDetail() {
  useAuth();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<ReviewDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [notes, setNotes] = useState('');
  const [denyReason, setDenyReason] = useState('');
  const [showDenyModal, setShowDenyModal] = useState(false);

  // Fetch detail data
  useEffect(() => {
    if (!id) return;
    const functions = getFunctions();
    const fn = httpsCallable<{ reviewId: string }, ReviewDetailData>(functions, 'getReviewDetail');
    fn({ reviewId: id })
      .then(result => {
        setData(result.data);
        setLoading(false);
      })
      .catch(e => {
        setError((e as Error)?.message || 'Failed to load review');
        setLoading(false);
      });
  }, [id]);

  const submitDecision = useCallback(
    async (decision: Decision, reasonNotes?: string) => {
      if (!id) return;
      setActionLoading(true);
      try {
        const functions = getFunctions();
        const fn = httpsCallable(functions, 'submitReviewDecision');
        await fn({ reviewId: id, decision, notes: reasonNotes || notes || undefined });
        navigate('/ops/review-queue');
      } catch (e) {
        alert('Error: ' + ((e as Error)?.message || 'Unknown error'));
      } finally {
        setActionLoading(false);
      }
    },
    [id, notes, navigate],
  );

  const handleDeny = () => {
    if (!denyReason.trim()) {
      alert('Please provide a reason for denial.');
      return;
    }
    setShowDenyModal(false);
    submitDecision('rejected', denyReason);
  };

  /* ── styles ──────────────────────────────────────────────────────────────── */

  const cardStyle: React.CSSProperties = {
    background: '#fff',
    borderRadius: 20,
    padding: '24px 28px',
    border: '1px solid rgba(25,68,69,0.04)',
    boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
    marginBottom: 20,
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '2.2px',
    color: '#a28657',
    marginBottom: 16,
  };

  const fieldLabel: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '1.5px',
    color: '#93aaa9',
    marginBottom: 4,
  };

  const fieldValue: React.CSSProperties = {
    fontSize: 14,
    color: '#0c1e1f',
    marginBottom: 16,
  };

  const pillBtn = (bg: string, text: string): React.CSSProperties => ({
    background: bg,
    color: text,
    borderRadius: 60,
    padding: '10px 24px',
    fontSize: 12,
    fontWeight: 600,
    border: 'none',
    cursor: actionLoading ? 'not-allowed' : 'pointer',
    transition: 'all 0.2s',
    letterSpacing: '0.2px',
    opacity: actionLoading ? 0.6 : 1,
  });

  const jsonBoxStyle: React.CSSProperties = {
    background: '#f5f8f7',
    borderRadius: 12,
    padding: '16px',
    fontSize: 12,
    fontFamily: "'DM Mono', monospace",
    color: '#2a4445',
    lineHeight: 1.6,
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 400,
    overflow: 'auto',
  };

  /* ── loading / error ─────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div style={{ maxWidth: 920, margin: '0 auto', padding: '48px 0 64px', textAlign: 'center', color: '#93aaa9' }}>
        <p style={{ fontSize: 14 }}>Loading review details...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ maxWidth: 920, margin: '0 auto', padding: '48px 0 64px', textAlign: 'center' }}>
        <p style={{ fontSize: 14, color: '#dc503c', marginBottom: 16 }}>{error || 'Review not found'}</p>
        <button onClick={() => navigate('/ops/review-queue')} style={pillBtn('#194445', '#fff')}>
          Back to Queue
        </button>
      </div>
    );
  }

  const { review, loan, employee, employer, mlDecision, auditHistory } = data;
  const signals = review['signals'] as Record<string, Record<string, unknown>> | undefined;
  const llm = review['llm_narrative'] as { summary?: string; key_signals?: string[]; recommendation?: string; confidence?: number } | undefined;
  const aml = review['aml_result'] as Record<string, unknown> | undefined;
  const risk = riskColor(str(review['risk_level'], 'unknown'));
  const queuedAt = review['queuedAt'] as string;
  const isActionable = ['pending', 'pending_review'].includes(review['status'] as string);

  /* ── render ──────────────────────────────────────────────────────────────── */

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: '48px 0 64px' }}>
      {/* Back link */}
      <button
        onClick={() => navigate('/ops/review-queue')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#a28657', fontWeight: 600, marginBottom: 24, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
      >
        ← Back to Queue
      </button>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32, flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 26, color: '#0c1e1f', fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 8 }}>
            {String(review['applicantName'] || 'Review Detail')}
          </h1>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20, background: risk.bg, color: risk.text, textTransform: 'uppercase' }}>
              {String(review['risk_level'] || 'unknown')} risk
            </span>
            {queuedAt && (
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20,
                background: hoursElapsed(queuedAt) > 24 ? 'rgba(220,80,60,0.08)' : 'rgba(36,122,110,0.06)',
                color: hoursElapsed(queuedAt) > 24 ? '#dc503c' : '#247a6e',
              }}>
                {slaLabel(queuedAt)}
              </span>
            )}
            <span style={{ fontSize: 12, color: '#93aaa9' }}>
              Loan: {str(review['loanId']).slice(0, 12)}
            </span>
          </div>
        </div>
      </div>

      {/* Two-column grid for application data */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        {/* Applicant info */}
        <div style={cardStyle}>
          <div style={sectionLabel}>Applicant</div>
          <div style={fieldLabel}>Name</div>
          <div style={fieldValue}>{str(review['applicantName'])}</div>
          <div style={fieldLabel}>RFC</div>
          <div style={fieldValue}>{str(review['applicantRfc']) !== '—' ? str(review['applicantRfc']) : str(employee?.['rfc'])}</div>
          <div style={fieldLabel}>CURP</div>
          <div style={fieldValue}>{str(employee?.['curp'])}</div>
          <div style={fieldLabel}>Email</div>
          <div style={fieldValue}>{str(employee?.['email']) !== '—' ? str(employee?.['email']) : str(loan?.['employeeEmail'])}</div>
          <div style={fieldLabel}>Phone</div>
          <div style={fieldValue}>{str(employee?.['phone']) !== '—' ? str(employee?.['phone']) : str(loan?.['employeePhone'])}</div>
          <div style={fieldLabel}>Monthly Salary</div>
          <div style={fieldValue}>{num(employee?.['monthlySalary']) > 0 ? `$${fmt(num(employee?.['monthlySalary']))} MXN` : '—'}</div>
        </div>

        {/* Loan + employer info */}
        <div style={cardStyle}>
          <div style={sectionLabel}>Loan & Employer</div>
          <div style={fieldLabel}>Loan Amount</div>
          <div style={fieldValue}>{num(loan?.['amount']) > 0 ? `$${fmt(num(loan?.['amount']))} MXN` : '—'}</div>
          <div style={fieldLabel}>Fee</div>
          <div style={fieldValue}>{num(loan?.['fee']) > 0 ? `$${fmt(num(loan?.['fee']))} MXN` : '—'}</div>
          <div style={fieldLabel}>Total</div>
          <div style={fieldValue}>{num(loan?.['total']) > 0 ? `$${fmt(num(loan?.['total']))} MXN` : '—'}</div>
          <div style={fieldLabel}>Employer</div>
          <div style={fieldValue}>{str(employer?.['companyName']) !== '—' ? str(employer?.['companyName']) : str(loan?.['employerName'])}</div>
          <div style={fieldLabel}>Industry</div>
          <div style={fieldValue}>{str(employer?.['industry'])}</div>
          <div style={fieldLabel}>Employer Risk Tier</div>
          <div style={fieldValue}>{employer?.['riskTier'] != null ? String(employer['riskTier']) : '—'}</div>
        </div>
      </div>

      {/* LLM Risk Narrative */}
      <LlmNarrativeSection llm={llm} cardStyle={cardStyle} fieldLabel={fieldLabel} />

      {/* AML / MetaMap KYC */}
      {aml ? (
        <div style={cardStyle}>
          <div style={sectionLabel}>MetaMap AML / KYC</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <div>
              <div style={fieldLabel}>AML Hit</div>
              <div style={{ ...fieldValue, color: aml['amlHit'] ? '#dc503c' : '#247a6e', fontWeight: 600 }}>
                {aml['amlHit'] ? 'Yes' : 'No'}
              </div>
            </div>
            <div>
              <div style={fieldLabel}>Criminal Record</div>
              <div style={{ ...fieldValue, color: aml['criminalRecordFound'] ? '#dc503c' : '#247a6e', fontWeight: 600 }}>
                {aml['criminalRecordFound'] ? 'Found' : 'None'}
              </div>
            </div>
            <div>
              <div style={fieldLabel}>PEP</div>
              <div style={{ ...fieldValue, color: aml['isPEP'] ? '#dc503c' : '#247a6e', fontWeight: 600 }}>
                {aml['isPEP'] ? 'Yes' : 'No'}
              </div>
            </div>
          </div>
          {Array.isArray(aml['amlLists']) && (aml['amlLists'] as unknown[]).length > 0 ? (
            <div>
              <div style={fieldLabel}>AML Lists</div>
              <div style={jsonBoxStyle}>{JSON.stringify(aml['amlLists'], null, 2)}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Underwriting Stages */}
      <div style={cardStyle}>
        <div style={sectionLabel}>Underwriting Stages</div>

        {/* Stage 0: Initial Checks */}
        {signals?.stage0 ? (
          <StageSection title="Stage 0 — Initial Checks" data={signals.stage0} fieldLabel={fieldLabel} jsonBoxStyle={jsonBoxStyle} />
        ) : null}

        {/* Stage 1: Employer Verification */}
        {signals?.stage1 ? (
          <StageSection title="Stage 1 — Employer Verification" data={signals.stage1} fieldLabel={fieldLabel} jsonBoxStyle={jsonBoxStyle} />
        ) : null}

        {/* Stage 2: Employment & Bureau */}
        {signals?.stage2 ? (
          <StageSection title="Stage 2 — Employment & Bureau" data={signals.stage2} fieldLabel={fieldLabel} jsonBoxStyle={jsonBoxStyle} />
        ) : null}

        {/* Bureau */}
        {signals?.bureau ? (
          <div style={{ marginBottom: 20 }}>
            <div style={{ ...fieldLabel, fontSize: 11, color: '#a28657', marginBottom: 8 }}>Bureau Report Summary</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 8 }}>
              <div>
                <div style={fieldLabel}>Score</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: (signals.bureau['score'] as number) < 400 ? '#dc503c' : '#0c1e1f' }}>
                  {signals.bureau['score'] != null ? String(signals.bureau['score']) : '—'}
                </div>
              </div>
              <div>
                <div style={fieldLabel}>Active Defaults</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: (signals.bureau['activeDefaults'] as number) > 0 ? '#dc503c' : '#247a6e' }}>
                  {signals.bureau['activeDefaults'] != null ? String(signals.bureau['activeDefaults']) : '—'}
                </div>
              </div>
              <div>
                <div style={fieldLabel}>Open Accounts</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#0c1e1f' }}>
                  {signals.bureau['openAccounts'] != null ? String(signals.bureau['openAccounts']) : '—'}
                </div>
              </div>
            </div>
            <details>
              <summary style={{ fontSize: 12, color: '#a28657', cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>Full bureau data</summary>
              <div style={jsonBoxStyle}>{JSON.stringify(signals.bureau, null, 2)}</div>
            </details>
          </div>
        ) : null}

        {/* RiskSeal */}
        {signals?.riskseal ? (
          <div style={{ marginBottom: 20 }}>
            <div style={{ ...fieldLabel, fontSize: 11, color: '#a28657', marginBottom: 8 }}>RiskSeal Digital Footprint</div>
            <div style={{ display: 'flex', gap: 24, marginBottom: 8 }}>
              <div>
                <div style={fieldLabel}>Score</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: (signals.riskseal['score'] as number) < 30 ? '#dc503c' : '#0c1e1f' }}>
                  {signals.riskseal['score'] != null ? String(signals.riskseal['score']) : '—'}
                </div>
              </div>
              <div>
                <div style={fieldLabel}>Risk Level</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#4a6364' }}>
                  {str(signals.riskseal['risk_level'])}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Stage 3: Identity */}
        {signals?.stage3 ? (
          <StageSection title="Stage 3 — Identity Verification" data={signals.stage3} fieldLabel={fieldLabel} jsonBoxStyle={jsonBoxStyle} />
        ) : null}

        {/* Stage 4: Full KYC */}
        {signals?.stage4 ? (
          <StageSection title="Stage 4 — Full KYC" data={signals.stage4} fieldLabel={fieldLabel} jsonBoxStyle={jsonBoxStyle} />
        ) : null}

        {/* Loan details in signals */}
        {signals?.loan ? (
          <div style={{ marginBottom: 20 }}>
            <div style={{ ...fieldLabel, fontSize: 11, color: '#a28657', marginBottom: 8 }}>Loan Metrics</div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {num(signals.loan['amount']) > 0 ? (
                <div>
                  <div style={fieldLabel}>Amount</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0c1e1f' }}>${fmt(num(signals.loan['amount']))} MXN</div>
                </div>
              ) : null}
              {num(signals.loan['loanToSalaryRatio']) > 0 ? (
                <div>
                  <div style={fieldLabel}>LTI Ratio</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0c1e1f' }}>{(num(signals.loan['loanToSalaryRatio']) * 100).toFixed(1)}%</div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* SHAP Features (from ML decision) */}
      {mlDecision ? (
        <div style={cardStyle}>
          <div style={sectionLabel}>ML Model — SHAP Features & WoE Scorecard</div>

          {/* SHAP top 5 */}
          {(mlDecision['shapValues'] as Record<string, number> | undefined) ? (
            <div style={{ marginBottom: 20 }}>
              <div style={fieldLabel}>SHAP Top 5 Features (XGBoost)</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {Object.entries(mlDecision['shapValues'] as Record<string, number>)
                  .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
                  .slice(0, 5)
                  .map(([feature, value]) => (
                    <div key={feature} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 12, color: '#4a6364', minWidth: 160 }}>{feature}</span>
                      <div style={{ flex: 1, height: 8, background: '#f0f3f2', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
                        <div style={{
                          position: 'absolute',
                          left: value >= 0 ? '50%' : `${50 + (value / 2) * 100}%`,
                          width: `${Math.min(Math.abs(value) * 50, 50)}%`,
                          height: '100%',
                          background: value > 0 ? '#dc503c' : '#247a6e',
                          borderRadius: 4,
                        }} />
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, color: value > 0 ? '#dc503c' : '#247a6e', minWidth: 50, textAlign: 'right' }}>
                        {value > 0 ? '+' : ''}{value.toFixed(3)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ) : null}

          {/* WoE Scorecard */}
          {(mlDecision['woeBins'] as Record<string, unknown>[] | undefined) ? (
            <div style={{ marginBottom: 20 }}>
              <div style={fieldLabel}>WoE Scorecard Breakdown</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid rgba(25,68,69,0.08)', color: '#93aaa9', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>Feature</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid rgba(25,68,69,0.08)', color: '#93aaa9', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>Bin</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', borderBottom: '1px solid rgba(25,68,69,0.08)', color: '#93aaa9', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>WoE</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', borderBottom: '1px solid rgba(25,68,69,0.08)', color: '#93aaa9', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(mlDecision['woeBins'] as Record<string, unknown>[]).map((bin, i) => (
                      <tr key={i}>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(25,68,69,0.04)', color: '#4a6364' }}>{String(bin['feature'])}</td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(25,68,69,0.04)', color: '#4a6364' }}>{String(bin['bin'])}</td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(25,68,69,0.04)', textAlign: 'right', fontWeight: 600, color: (bin['woe'] as number) > 0 ? '#dc503c' : '#247a6e' }}>
                          {(bin['woe'] as number)?.toFixed(3) || '—'}
                        </td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(25,68,69,0.04)', textAlign: 'right', fontWeight: 600, color: '#0c1e1f' }}>
                          {(bin['points'] as number)?.toFixed(0) || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {/* ML scores */}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {mlDecision['creditScore'] != null ? (
              <div>
                <div style={fieldLabel}>ML Credit Score</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#0c1e1f' }}>{String(mlDecision['creditScore'])}</div>
              </div>
            ) : null}
            {mlDecision['defaultProb'] != null ? (
              <div>
                <div style={fieldLabel}>Default Probability</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: (mlDecision['defaultProb'] as number) > 0.5 ? '#dc503c' : '#0c1e1f' }}>
                  {((mlDecision['defaultProb'] as number) * 100).toFixed(1)}%
                </div>
              </div>
            ) : null}
          </div>

          {/* Full ML decision JSON */}
          <details style={{ marginTop: 16 }}>
            <summary style={{ fontSize: 12, color: '#a28657', cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>Full ML decision data</summary>
            <div style={jsonBoxStyle}>{JSON.stringify(mlDecision, null, 2)}</div>
          </details>
        </div>
      ) : null}

      {/* Belvo Employment History */}
      {signals?.stage4?.['details'] && (signals.stage4['details'] as Record<string, unknown>)?.['cashFlow'] ? (
        <div style={cardStyle}>
          <div style={sectionLabel}>Belvo Employment & Cash Flow</div>
          {(() => {
            const cashFlow = (signals.stage4['details'] as Record<string, unknown>)['cashFlow'] as Record<string, unknown>;
            return (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
                <div>
                  <div style={fieldLabel}>Salary Confirmed</div>
                  <div style={{ ...fieldValue, fontWeight: 600, color: cashFlow['salaryConfirmed'] ? '#247a6e' : '#dc503c' }}>
                    {cashFlow['salaryConfirmed'] ? 'Yes' : 'No'}
                  </div>
                </div>
                <div>
                  <div style={fieldLabel}>Avg Daily Balance</div>
                  <div style={fieldValue}>{cashFlow['avgDailyBalance'] != null ? `$${fmt(cashFlow['avgDailyBalance'] as number)} MXN` : '—'}</div>
                </div>
                <div>
                  <div style={fieldLabel}>Income Stability</div>
                  <div style={fieldValue}>{str(cashFlow['incomeStability'])}</div>
                </div>
              </div>
            );
          })()}
        </div>
      ) : null}

      {/* Audit Trail */}
      {auditHistory.length > 0 && (
        <div style={cardStyle}>
          <div style={sectionLabel}>Audit Trail</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {auditHistory.map((entry, i) => (
              <div key={i} style={{ padding: '12px 16px', background: '#f5f8f7', borderRadius: 12, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, color: '#0c1e1f' }}>{String(entry['action'])}</span>
                  <span style={{ fontSize: 11, color: '#93aaa9' }}>{formatDate(entry['timestamp'])}</span>
                </div>
                <div style={{ fontSize: 12, color: '#4a6364' }}>
                  by {String(entry['actorUid'])} ({String(entry['actorRole'])})
                  {(() => {
                    const meta = entry['meta'] as Record<string, unknown> | undefined;
                    return meta?.['notes'] ? <span> — {String(meta['notes'])}</span> : null;
                  })()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      {isActionable && (
        <div style={{ ...cardStyle, position: 'sticky', bottom: 0, zIndex: 10, boxShadow: '0 -4px 20px rgba(25,68,69,0.08)' }}>
          <div style={sectionLabel}>Actions</div>
          <textarea
            placeholder="Review notes (optional)..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
            style={{
              width: '100%',
              minHeight: 48,
              padding: '10px 14px',
              fontSize: 13,
              color: '#0c1e1f',
              border: '1px solid rgba(25,68,69,0.10)',
              borderRadius: 12,
              resize: 'vertical',
              fontFamily: "'DM Sans',sans-serif",
              background: '#fff',
              outline: 'none',
              boxSizing: 'border-box',
              marginBottom: 14,
            }}
          />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              onClick={() => submitDecision('approved')}
              disabled={actionLoading}
              style={pillBtn('#194445', '#fff')}
            >
              {actionLoading ? 'Processing...' : 'Approve'}
            </button>
            <button
              onClick={() => setShowDenyModal(true)}
              disabled={actionLoading}
              style={pillBtn('rgba(220,80,60,0.08)', '#dc503c')}
            >
              Deny
            </button>
            <button
              onClick={() => submitDecision('request_info')}
              disabled={actionLoading}
              style={pillBtn('rgba(162,134,87,0.10)', '#a28657')}
            >
              Request More Info
            </button>
            <button
              onClick={() => submitDecision('escalate')}
              disabled={actionLoading}
              style={pillBtn('rgba(147,170,169,0.10)', '#4a6364')}
            >
              Escalate to Senior
            </button>
          </div>
        </div>
      )}

      {/* Non-actionable status */}
      {!isActionable && (
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#93aaa9' }}>
            This review has status: <strong>{String(review['status'])}</strong>
          </div>
        </div>
      )}

      {/* Deny modal */}
      {showDenyModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(12,30,31,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }}>
          <div style={{ background: '#fff', borderRadius: 20, padding: '28px', maxWidth: 440, width: '90%' }}>
            <div style={sectionLabel}>Deny Reason</div>
            <p style={{ fontSize: 13, color: '#4a6364', marginBottom: 16 }}>
              Please provide a reason for denying this application.
            </p>
            <textarea
              autoFocus
              placeholder="Reason for denial..."
              value={denyReason}
              onChange={e => setDenyReason(e.target.value)}
              style={{
                width: '100%',
                minHeight: 80,
                padding: '10px 14px',
                fontSize: 13,
                color: '#0c1e1f',
                border: '1px solid rgba(25,68,69,0.10)',
                borderRadius: 12,
                resize: 'vertical',
                fontFamily: "'DM Sans',sans-serif",
                background: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: 14,
              }}
            />
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDenyModal(false)} style={pillBtn('rgba(147,170,169,0.10)', '#4a6364')}>Cancel</button>
              <button onClick={handleDeny} style={pillBtn('rgba(220,80,60,0.08)', '#dc503c')}>Confirm Deny</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── LLM narrative sub-component ──────────────────────────────────────────── */

function LlmNarrativeSection({ llm, cardStyle, fieldLabel }: {
  llm: { summary?: string; key_signals?: string[]; recommendation?: string; confidence?: number } | undefined;
  cardStyle: React.CSSProperties;
  fieldLabel: React.CSSProperties;
}) {
  if (!llm) return null;
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '2.2px', color: '#a28657', marginBottom: 16 }}>
        LLM Risk Narrative
      </div>
      <div style={{ fontSize: 13, color: '#4a6364', lineHeight: 1.7, marginBottom: 14, padding: '14px 18px', background: '#f5f8f7', borderRadius: 12 }}>
        {llm.summary || '—'}
      </div>
      {llm.key_signals && llm.key_signals.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={fieldLabel}>Key Signals</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {llm.key_signals.map((sig, i) => (
              <span key={i} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 16, background: 'rgba(25,68,69,0.04)', color: '#4a6364' }}>
                {sig}
              </span>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 24 }}>
        <div>
          <div style={fieldLabel}>Recommendation</div>
          <div style={{ fontSize: 13, color: '#0c1e1f', fontWeight: 600 }}>{llm.recommendation || '—'}</div>
        </div>
        <div>
          <div style={fieldLabel}>Confidence</div>
          <div style={{ fontSize: 13, color: '#0c1e1f', fontWeight: 600 }}>{((llm.confidence ?? 0) * 100).toFixed(0)}%</div>
        </div>
      </div>
    </div>
  );
}

/* ── Stage section sub-component ──────────────────────────────────────────── */

function StageSection({ title, data, fieldLabel, jsonBoxStyle }: {
  title: string;
  data: Record<string, unknown>;
  fieldLabel: React.CSSProperties;
  jsonBoxStyle: React.CSSProperties;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ ...fieldLabel, fontSize: 11, color: '#a28657', marginBottom: 8 }}>{title}</div>
      <details>
        <summary style={{ fontSize: 12, color: '#4a6364', cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>View stage data</summary>
        <div style={jsonBoxStyle}>{JSON.stringify(data, null, 2)}</div>
      </details>
    </div>
  );
}
