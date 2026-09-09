import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useAuth } from '../hooks/useAuth';
import { availableDecisions, blockedReason, canDecideReview } from '../lib/reviewStatus';
import { Stage3ConditionsPanel } from '../components/ops/Stage3ConditionsPanel';
import type { UnderwritingDetail } from '../lib/underwritingConditions';

/* ── types ────────────────────────────────────────────────────────────────── */

interface ReviewDetailData {
  review: Record<string, unknown>;
  loan: Record<string, unknown> | null;
  employee: Record<string, unknown> | null;
  employer: Record<string, unknown> | null;
  mlDecision: Record<string, unknown> | null;
  // Null for a loan that never reached Stage 3, one predating #393/#509, or a
  // review with no loanId. The panel renders its own empty state for all three
  // — this is never an error and must never gate the rest of the screen.
  underwritingDetail: UnderwritingDetail | null;
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

/** Risk is never green: a low risk level is an input, not an approval. */
function riskClass(level: string): string {
  switch (level) {
    case 'critical':
    case 'high': return ' bad';
    case 'medium': return ' warn';
    default: return '';
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
  // The role decides whether an escalated review is actionable from here, so it
  // is read rather than discarded.
  const { role } = useAuth();
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

  // Dark board card — the ops recipe (rgba(0,11,26,.55), 22px radius).
  const cardStyle: React.CSSProperties = {
    background: 'rgba(0,11,26,.55)',
    borderRadius: 22,
    padding: '24px',
    border: '1px solid rgba(255,255,255,.06)',
    marginBottom: 10,
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 15,
    fontWeight: 500,
    color: 'rgba(242,245,240,.85)',
    marginBottom: 16,
  };

  const fieldLabel: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '.04em',
    color: 'rgba(242,245,240,.75)',
    marginBottom: 4,
  };

  const fieldValue: React.CSSProperties = {
    fontSize: 14,
    color: 'var(--paper-dark)',
    marginBottom: 16,
  };

  const jsonBoxStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,.05)',
    borderRadius: 16,
    padding: '16px',
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: 'rgba(242,245,240,.85)',
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
      <div className="ops-page">
        <div className="ops-card" style={{ textAlign: 'center', padding: 48 }} aria-busy="true">
          <p className="ops-note">Loading review details...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="ops-page">
        <div className="ops-card" style={{ textAlign: 'center', padding: 48 }}>
          <p className="ops-error" style={{ marginBottom: 16 }}>{error || 'Review not found'}</p>
          <button type="button" onClick={() => navigate('/ops/review-queue')} className="ops-btn">
            Back to Queue
          </button>
        </div>
      </div>
    );
  }

  const { review, loan, employee, employer, mlDecision, underwritingDetail, auditHistory } = data;
  const signals = review['signals'] as Record<string, Record<string, unknown>> | undefined;
  const llm = review['llm_narrative'] as { summary?: string; key_signals?: string[]; recommendation?: string; confidence?: number } | undefined;
  const aml = review['aml_result'] as Record<string, unknown> | undefined;
  const risk = riskClass(str(review['risk_level'], 'unknown'));
  const queuedAt = review['queuedAt'] as string;
  // Mirrors the server's own guard rather than a narrower copy of it: an
  // `info_requested` review stays decidable by anyone (the answer ops asked for
  // has to be able to land), and an `escalated` one by admin/super_admin.
  // Gating on ['pending','pending_review'] hid the buttons on reviews the
  // server would have accepted — that is how a triaged loan became
  // unresolvable and its borrower lost their only loan slot.
  const reviewStatus = str(review['status'], '');
  const isActionable = canDecideReview(reviewStatus, role);
  const offeredDecisions = availableDecisions(reviewStatus, role);
  const cannotActReason = blockedReason(reviewStatus, role);

  /* ── render ──────────────────────────────────────────────────────────────── */

  return (
    <div className="ops-page">
      {/* Back link */}
      <button
        type="button"
        onClick={() => navigate('/ops/review-queue')}
        className="ops-link"
        style={{ padding: '10px 4px 0' }}
      >
        ← Back to Queue
      </button>

      {/* Header */}
      <div className="ops-head" style={{ paddingTop: 6 }}>
        <div>
          <div className="dot ops-eyebrow">Revisión</div>
          <h1 className="ops-title">
            {String(review['applicantName'] || 'Review Detail')}
          </h1>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
            <span className={`ops-status${risk}`} style={{ textTransform: 'uppercase', fontSize: 10.5, letterSpacing: '.04em' }}>
              {String(review['risk_level'] || 'unknown')} risk
            </span>
            {queuedAt && (
              <span className={`ops-status${hoursElapsed(queuedAt) > 24 ? ' bad' : ' g'}`}>
                {slaLabel(queuedAt)}
              </span>
            )}
            <span className="ops-note">
              Loan: {str(review['loanId']).slice(0, 12)}
            </span>
          </div>
        </div>
      </div>

      {/* Two-column grid for application data */}
      <div className="ops-two">
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
              <div style={{ ...fieldValue, color: aml['amlHit'] ? 'var(--danger)' : 'var(--brand-light)', fontWeight: 600 }}>
                {aml['amlHit'] ? 'Yes' : 'No'}
              </div>
            </div>
            <div>
              <div style={fieldLabel}>Criminal Record</div>
              <div style={{ ...fieldValue, color: aml['criminalRecordFound'] ? 'var(--danger)' : 'var(--brand-light)', fontWeight: 600 }}>
                {aml['criminalRecordFound'] ? 'Found' : 'None'}
              </div>
            </div>
            <div>
              <div style={fieldLabel}>PEP</div>
              <div style={{ ...fieldValue, color: aml['isPEP'] ? 'var(--danger)' : 'var(--brand-light)', fontWeight: 600 }}>
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
            <div style={{ ...fieldLabel, fontSize: 11, color: 'var(--gold)', marginBottom: 8 }}>Bureau Report Summary</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 8 }}>
              <div>
                <div style={fieldLabel}>Score</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: (signals.bureau['score'] as number) < 400 ? 'var(--danger)' : 'var(--t1)' }}>
                  {signals.bureau['score'] != null ? String(signals.bureau['score']) : '—'}
                </div>
              </div>
              <div>
                <div style={fieldLabel}>Active Defaults</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: (signals.bureau['activeDefaults'] as number) > 0 ? 'var(--danger)' : 'var(--brand-light)' }}>
                  {signals.bureau['activeDefaults'] != null ? String(signals.bureau['activeDefaults']) : '—'}
                </div>
              </div>
              <div>
                <div style={fieldLabel}>Open Accounts</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--t1)' }}>
                  {signals.bureau['openAccounts'] != null ? String(signals.bureau['openAccounts']) : '—'}
                </div>
              </div>
            </div>
            <details>
              <summary style={{ fontSize: 12, color: 'var(--gold)', cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>Full bureau data</summary>
              <div style={jsonBoxStyle}>{JSON.stringify(signals.bureau, null, 2)}</div>
            </details>
          </div>
        ) : null}

        {/* RiskSeal */}
        {signals?.riskseal ? (
          <div style={{ marginBottom: 20 }}>
            <div style={{ ...fieldLabel, fontSize: 11, color: 'var(--gold)', marginBottom: 8 }}>RiskSeal Digital Footprint</div>
            <div style={{ display: 'flex', gap: 24, marginBottom: 8 }}>
              <div>
                <div style={fieldLabel}>Score</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: (signals.riskseal['score'] as number) < 30 ? 'var(--danger)' : 'var(--t1)' }}>
                  {signals.riskseal['score'] != null ? String(signals.riskseal['score']) : '—'}
                </div>
              </div>
              <div>
                <div style={fieldLabel}>Risk Level</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t2)' }}>
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
            <div style={{ ...fieldLabel, fontSize: 11, color: 'var(--gold)', marginBottom: 8 }}>Loan Metrics</div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {num(signals.loan['amount']) > 0 ? (
                <div>
                  <div style={fieldLabel}>Amount</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>${fmt(num(signals.loan['amount']))} MXN</div>
                </div>
              ) : null}
              {num(signals.loan['loanToSalaryRatio']) > 0 ? (
                <div>
                  <div style={fieldLabel}>LTI Ratio</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>{(num(signals.loan['loanToSalaryRatio']) * 100).toFixed(1)}%</div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* Stage 3 — the auto-approve gate, row by row. Sits directly under the
          stage summaries it explains, and renders unconditionally: its own
          empty state is the answer when no breakdown was recorded. */}
      <Stage3ConditionsPanel detail={underwritingDetail ?? null} cardStyle={cardStyle} />

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
                      <span style={{ fontSize: 12, color: 'var(--t2)', minWidth: 160 }}>{feature}</span>
                      <div style={{ flex: 1, height: 8, background: 'rgba(255,255,255,.1)', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
                        <div style={{
                          position: 'absolute',
                          left: value >= 0 ? '50%' : `${50 + (value / 2) * 100}%`,
                          width: `${Math.min(Math.abs(value) * 50, 50)}%`,
                          height: '100%',
                          background: value > 0 ? 'var(--danger)' : 'var(--brand-light)',
                          borderRadius: 4,
                        }} />
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, color: value > 0 ? 'var(--danger)' : 'var(--brand-light)', minWidth: 50, textAlign: 'right' }}>
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
                      <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.1)', color: 'var(--t3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>Feature</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.1)', color: 'var(--t3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>Bin</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.1)', color: 'var(--t3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>WoE</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.1)', color: 'var(--t3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px' }}>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(mlDecision['woeBins'] as Record<string, unknown>[]).map((bin, i) => (
                      <tr key={i}>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.06)', color: 'var(--t2)' }}>{String(bin['feature'])}</td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.06)', color: 'var(--t2)' }}>{String(bin['bin'])}</td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.06)', textAlign: 'right', fontWeight: 600, color: (bin['woe'] as number) > 0 ? 'var(--danger)' : 'var(--brand-light)' }}>
                          {(bin['woe'] as number)?.toFixed(3) || '—'}
                        </td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.06)', textAlign: 'right', fontWeight: 600, color: 'var(--t1)' }}>
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
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--t1)' }}>{String(mlDecision['creditScore'])}</div>
              </div>
            ) : null}
            {mlDecision['defaultProb'] != null ? (
              <div>
                <div style={fieldLabel}>Default Probability</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: (mlDecision['defaultProb'] as number) > 0.5 ? 'var(--danger)' : 'var(--t1)' }}>
                  {((mlDecision['defaultProb'] as number) * 100).toFixed(1)}%
                </div>
              </div>
            ) : null}
          </div>

          {/* Full ML decision JSON */}
          <details style={{ marginTop: 16 }}>
            <summary style={{ fontSize: 12, color: 'var(--gold)', cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>Full ML decision data</summary>
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
                  <div style={{ ...fieldValue, fontWeight: 600, color: cashFlow['salaryConfirmed'] ? 'var(--brand-light)' : 'var(--danger)' }}>
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
              <div key={i} style={{ padding: '12px 16px', background: 'var(--bg2)', borderRadius: 16, fontSize: 13, border: '1px solid rgba(255,255,255,.06)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{String(entry['action'])}</span>
                  <span style={{ fontSize: 11, color: 'var(--t3)' }}>{formatDate(entry['timestamp'])}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--t2)' }}>
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
        <div className="ops-sticky" style={{ ...cardStyle, position: 'sticky', bottom: 10, zIndex: 10 }}>
          <div style={sectionLabel}>Actions</div>
          <textarea
            aria-label="Review notes"
            placeholder="Review notes (optional)..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className="ops-input"
            style={{ minHeight: 64, marginBottom: 14 }}
          />
          <div className="ops-actions" style={{ gap: 10 }}>
            {/* Approve is the one white action on this page. */}
            <button
              type="button"
              onClick={() => submitDecision('approved')}
              disabled={actionLoading}
              className="ops-go"
              style={{ marginTop: 0 }}
            >
              <i aria-hidden="true" />{actionLoading ? 'Processing...' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={() => setShowDenyModal(true)}
              disabled={actionLoading}
              className="ops-btn ghost danger"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={() => submitDecision('request_info')}
              disabled={actionLoading}
              className="ops-btn"
            >
              Request More Info
            </button>
            {/* Hidden on an already-escalated review: the server answers that
                with failed-precondition, so the button can only produce an
                error. */}
            {offeredDecisions.includes('escalate') && (
              <button
                type="button"
                onClick={() => submitDecision('escalate')}
                disabled={actionLoading}
                className="ops-btn ghost"
              >
                Escalate to Senior
              </button>
            )}
          </div>
        </div>
      )}

      {/* Non-actionable status.
          An escalated review is not resolved — it is waiting on someone more
          senior. Rendering it with the same flat "this review has status: x"
          as a closed one is what made escalation read as a dead end. */}
      {!isActionable && (
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div className="ops-note" style={{ fontSize: 14 }}>
            This review has status: <strong style={{ color: 'var(--paper-dark)' }}>{String(review['status'])}</strong>
          </div>
          {cannotActReason && (
            <div className="ops-sub" style={{ margin: '8px auto 0' }}>
              {cannotActReason}
            </div>
          )}
        </div>
      )}

      {/* Deny modal */}
      {showDenyModal && (
        <div className="ops-overlay" role="dialog" aria-modal="true" aria-label="Deny reason">
          <div className="ops-card ops-sheet">
            <div style={sectionLabel}>Deny Reason</div>
            <p className="ops-sub" style={{ marginBottom: 16 }}>
              Please provide a reason for denying this application.
            </p>
            <textarea
              autoFocus
              aria-label="Reason for denial"
              placeholder="Reason for denial..."
              value={denyReason}
              onChange={e => setDenyReason(e.target.value)}
              className="ops-input"
              style={{ minHeight: 96, marginBottom: 14 }}
            />
            <div className="ops-actions" style={{ justifyContent: 'flex-end', width: '100%', gap: 10 }}>
              <button type="button" onClick={() => setShowDenyModal(false)} className="ops-btn ghost">Cancel</button>
              <button type="button" onClick={handleDeny} className="ops-btn danger">Confirm Deny</button>
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
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '2.2px', color: 'var(--gold)', marginBottom: 16 }}>
        LLM Risk Narrative
      </div>
      <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.7, marginBottom: 14, padding: '14px 18px', background: 'var(--bg2)', borderRadius: 12 }}>
        {llm.summary || '—'}
      </div>
      {llm.key_signals && llm.key_signals.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={fieldLabel}>Key Signals</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {llm.key_signals.map((sig, i) => (
              <span key={i} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 16, background: 'rgba(255,255,255,.08)', color: 'var(--t2)' }}>
                {sig}
              </span>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 24 }}>
        <div>
          <div style={fieldLabel}>Recommendation</div>
          <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>{llm.recommendation || '—'}</div>
        </div>
        <div>
          <div style={fieldLabel}>Confidence</div>
          <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>{((llm.confidence ?? 0) * 100).toFixed(0)}%</div>
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
      <div style={{ ...fieldLabel, fontSize: 11, color: 'var(--gold)', marginBottom: 8 }}>{title}</div>
      <details>
        <summary style={{ fontSize: 12, color: 'var(--t2)', cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>View stage data</summary>
        <div style={jsonBoxStyle}>{JSON.stringify(data, null, 2)}</div>
      </details>
    </div>
  );
}
