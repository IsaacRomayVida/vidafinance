import { useState, useEffect, useCallback } from 'react';
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

/* ── review_queue document shape ─────────────────────────────────────────── */

interface LlmNarrative {
  risk_level: string;
  summary: string;
  key_signals: string[];
  recommendation: string;
  confidence: number;
}

interface ShapValues {
  features: { name: string; value: number; impact: 'positive' | 'negative' }[];
}

interface BureauData {
  score?: number;
  provider?: string;
  tradelines?: number;
  delinquencies?: number;
  inquiries30d?: number;
  oldestAccount?: string;
}

interface ReviewItem {
  id: string;
  loanId: string;
  applicantName: string;
  applicantRfc?: string;
  applicantEmail?: string;
  loanAmount?: number;
  risk_level: string;
  llm_narrative: LlmNarrative;
  aml_result?: {
    amlHit: boolean;
    criminalRecordFound: boolean;
    isPEP: boolean;
  };
  shap_values?: ShapValues;
  bureau_data?: BureauData;
  signals?: Record<string, unknown>;
  priority: number;
  queuedAt: string;          // ISO-8601
  slaDeadline: string;       // ISO-8601
  status: string;
  claimedBy?: string;
  claimedByEmail?: string;
  claimedAt?: string;
  reviewNotes?: string | null;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

const SLA_HOURS = 24;

/** Returns fraction of SLA elapsed (0.0 → 1.0+) */
function slaFraction(queuedAt: string): number {
  const elapsed = (Date.now() - new Date(queuedAt).getTime()) / (1000 * 60 * 60);
  return elapsed / SLA_HOURS;
}

/** Pretty-print remaining time, e.g. "4h 12m left" or "Overdue 2h 30m" */
function slaLabel(queuedAt: string): string {
  const elapsed = (Date.now() - new Date(queuedAt).getTime()) / (1000 * 60 * 60);
  const remaining = SLA_HOURS - elapsed;
  if (remaining <= 0) {
    const over = Math.abs(remaining);
    const h = Math.floor(over);
    const m = Math.floor((over - h) * 60);
    return `Overdue ${h}h ${m}m`;
  }
  const h = Math.floor(remaining);
  const m = Math.floor((remaining - h) * 60);
  return `${h}h ${m}m left`;
}

/** SLA color: green < 50%, yellow 50-75%, red > 75% */
function slaColor(queuedAt: string): { bg: string; text: string; border: string } {
  const frac = slaFraction(queuedAt);
  if (frac >= 1) return { bg: 'rgba(220,80,60,0.10)', text: '#dc503c', border: '#dc503c' };
  if (frac >= 0.75) return { bg: 'rgba(220,80,60,0.08)', text: '#dc503c', border: '#dc503c' };
  if (frac >= 0.5) return { bg: 'rgba(212,160,60,0.10)', text: '#b08420', border: '#b08420' };
  return { bg: 'rgba(36,122,110,0.06)', text: '#247a6e', border: 'transparent' };
}

/** SLA progress bar percentage (capped at 100) */
function slaPercent(queuedAt: string): number {
  return Math.min(slaFraction(queuedAt) * 100, 100);
}

function riskColor(level: string): { bg: string; text: string } {
  switch (level) {
    case 'high':
      return { bg: 'rgba(220,80,60,0.08)', text: '#dc503c' };
    case 'medium':
      return { bg: 'rgba(212,160,60,0.10)', text: '#b08420' };
    case 'low':
      return { bg: 'rgba(36,122,110,0.08)', text: '#247a6e' };
    default:
      return { bg: 'rgba(147,170,169,0.10)', text: '#4a6364' };
  }
}

function priorityLabel(priority: number): string {
  if (priority <= 1) return 'Critical';
  if (priority <= 2) return 'High';
  if (priority <= 3) return 'Medium';
  return 'Low';
}

function priorityColor(priority: number): { bg: string; text: string } {
  if (priority <= 1) return { bg: 'rgba(220,80,60,0.08)', text: '#dc503c' };
  if (priority <= 2) return { bg: 'rgba(162,134,87,0.10)', text: '#a28657' };
  if (priority <= 3) return { bg: 'rgba(212,160,60,0.08)', text: '#b08420' };
  return { bg: 'rgba(147,170,169,0.08)', text: '#4a6364' };
}

/** Sort: priority ASC (1 is highest), then SLA urgency DESC (most urgent first) */
function sortReviews(items: ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Higher SLA fraction = more urgent = should come first
    return slaFraction(b.queuedAt) - slaFraction(a.queuedAt);
  });
}

function formatCurrency(amount: number | undefined): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0 }).format(amount);
}

/* ── component ───────────────────────────────────────────────────────────── */

export function OpsReviewQueue() {
  const { user } = useAuth();
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [notesMap, setNotesMap] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterRisk, setFilterRisk] = useState<string>('all');
  const [, setTick] = useState(0);

  // Force re-render every 30s to keep SLA timers live
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Real-time listener — pending + pending_review items
  useEffect(() => {
    const q = query(
      collection(db, 'review_queue'),
      where('status', 'in', ['pending', 'pending_review']),
      orderBy('priority', 'asc'),
      orderBy('queuedAt', 'asc'),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() } as ReviewItem));
        setReviews(sortReviews(items));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  // Filtered list
  const filtered = filterRisk === 'all' ? reviews : reviews.filter(r => r.risk_level === filterRisk);

  // Stats
  const pendingCount = reviews.filter(r => r.status === 'pending').length;
  const claimedCount = reviews.filter(r => r.status === 'pending_review').length;
  const highRiskCount = reviews.filter(r => r.risk_level === 'high').length;
  const breachedCount = reviews.filter(r => slaFraction(r.queuedAt) >= 1).length;

  /* ── actions ──────────────────────────────────────────────────────────── */

  const claimReview = useCallback(async (reviewId: string) => {
    setActionLoading(reviewId);
    try {
      const functions = getFunctions();
      const fn = httpsCallable(functions, 'claimReview');
      await fn({ reviewId });
      setExpandedId(reviewId);
    } catch (e: unknown) {
      alert('Error: ' + ((e as Error)?.message || 'Unknown error'));
    } finally {
      setActionLoading(null);
    }
  }, []);

  const submitDecision = useCallback(
    async (reviewId: string, decision: 'approved' | 'rejected' | 'escalated') => {
      const notes = notesMap[reviewId] || '';
      if (decision === 'rejected' && !notes.trim()) {
        alert('Please provide a reason for rejection.');
        return;
      }
      if (decision === 'escalated' && !notes.trim()) {
        alert('Please provide a reason for escalation.');
        return;
      }
      setActionLoading(reviewId);
      try {
        const functions = getFunctions();
        const fn = httpsCallable(functions, 'submitReviewDecision');
        await fn({ reviewId, decision, notes: notes || undefined });
        setExpandedId(null);
        setNotesMap(prev => { const next = { ...prev }; delete next[reviewId]; return next; });
      } catch (e: unknown) {
        alert('Error: ' + ((e as Error)?.message || 'Unknown error'));
      } finally {
        setActionLoading(null);
      }
    },
    [notesMap],
  );

  /* ── styles ──────────────────────────────────────────────────────────── */

  const cardStyle: React.CSSProperties = {
    background: '#fff',
    borderRadius: 20,
    padding: '28px',
    border: '1px solid rgba(25,68,69,0.04)',
    boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
    marginBottom: 16,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '2.2px',
    color: '#a28657',
    marginBottom: 10,
  };

  const valueStyle: React.CSSProperties = {
    fontFamily: "'DM Serif Display',Georgia,serif",
    fontSize: 36,
    color: '#0c1e1f',
    letterSpacing: '-0.03em',
    fontWeight: 400,
    lineHeight: 1,
  };

  const badgeStyle = (bg: string, text: string): React.CSSProperties => ({
    fontSize: 11,
    fontWeight: 700,
    padding: '4px 12px',
    borderRadius: 20,
    background: bg,
    color: text,
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  });

  const pillBtn = (color: string, textColor: string, disabled?: boolean): React.CSSProperties => ({
    background: color,
    color: textColor,
    borderRadius: 60,
    padding: '10px 24px',
    fontSize: 12,
    fontWeight: 600,
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.2s',
    letterSpacing: '0.2px',
    opacity: disabled ? 0.5 : 1,
  });

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '1.5px',
    color: '#93aaa9',
    marginBottom: 8,
  };

  /* ── render ──────────────────────────────────────────────────────────── */

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: '48px 0 64px' }}>
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 26, color: '#0c1e1f', fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 8 }}>
          Ops Review Queue
        </h1>
        <p style={{ fontSize: 14, color: '#4a6364', lineHeight: 1.7 }}>
          Stage 5 manual review — claim, review signals &amp; data, then decide. 24-hour SLA per item.
        </p>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14, marginBottom: 28 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>Unclaimed</div>
          <div style={valueStyle}>{pendingCount}</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Claimed</div>
          <div style={valueStyle}>{claimedCount}</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>High Risk</div>
          <div style={{ ...valueStyle, color: highRiskCount > 0 ? '#dc503c' : '#0c1e1f' }}>
            {highRiskCount}
          </div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>SLA Breach</div>
          <div style={{ ...valueStyle, color: breachedCount > 0 ? '#dc503c' : '#0c1e1f' }}>
            {breachedCount}
          </div>
        </div>
      </div>

      {/* Filter row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#93aaa9', textTransform: 'uppercase', letterSpacing: '1px' }}>Filter:</span>
        {['all', 'high', 'medium', 'low'].map(level => (
          <button
            key={level}
            onClick={() => setFilterRisk(level)}
            style={{
              fontSize: 11,
              fontWeight: filterRisk === level ? 700 : 500,
              padding: '5px 14px',
              borderRadius: 20,
              border: filterRisk === level ? '1.5px solid #194445' : '1px solid rgba(25,68,69,0.10)',
              background: filterRisk === level ? 'rgba(25,68,69,0.06)' : '#fff',
              color: filterRisk === level ? '#194445' : '#4a6364',
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {level === 'all' ? 'All' : `${level} risk`}
          </button>
        ))}
      </div>

      {/* Section label */}
      {filtered.length > 0 && (
        <div style={{ ...labelStyle, marginBottom: 14 }}>
          Queue ({filtered.length})
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: '#93aaa9' }}>
          <p style={{ fontSize: 14 }}>Loading reviews...</p>
        </div>
      )}

      {/* Empty */}
      {!loading && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: '#93aaa9' }}>
          <p style={{ fontSize: 14 }}>No pending reviews. All caught up.</p>
        </div>
      )}

      {/* Review cards */}
      {filtered.map(item => {
        const sla = slaColor(item.queuedAt);
        const risk = riskColor(item.risk_level);
        const prio = priorityColor(item.priority);
        const isExpanded = expandedId === item.id;
        const isClaimed = item.status === 'pending_review';
        const isClaimedByMe = isClaimed && item.claimedBy === user?.uid;
        const busy = actionLoading === item.id;

        return (
          <div
            key={item.id}
            style={{
              ...cardStyle,
              padding: '24px 28px',
              borderLeft: `3px solid ${sla.border}`,
            }}
          >
            {/* Top row: name + SLA badge */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#0c1e1f', marginBottom: 4 }}>
                  {item.applicantName}
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#93aaa9' }}>
                  {item.applicantRfc && <span>RFC: {item.applicantRfc}</span>}
                  {item.loanAmount != null && <span>{formatCurrency(item.loanAmount)}</span>}
                </div>
              </div>
              <div style={{ ...badgeStyle(sla.bg, sla.text), fontSize: 11 }}>
                {slaLabel(item.queuedAt)}
              </div>
            </div>

            {/* SLA progress bar */}
            <div style={{ height: 3, background: 'rgba(25,68,69,0.06)', borderRadius: 2, marginBottom: 14, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${slaPercent(item.queuedAt)}%`,
                  background: sla.text,
                  borderRadius: 2,
                  transition: 'width 0.5s ease',
                }}
              />
            </div>

            {/* Badges row */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <span style={badgeStyle(risk.bg, risk.text)}>{item.risk_level} risk</span>
              <span style={badgeStyle(prio.bg, prio.text)}>P{item.priority} — {priorityLabel(item.priority)}</span>
              <span style={badgeStyle('rgba(147,170,169,0.10)', '#4a6364')}>
                Confidence: {((item.llm_narrative?.confidence ?? 0) * 100).toFixed(0)}%
              </span>
              {item.aml_result?.amlHit && (
                <span style={badgeStyle('rgba(220,80,60,0.08)', '#dc503c')}>AML Hit</span>
              )}
              {item.aml_result?.isPEP && (
                <span style={badgeStyle('rgba(220,80,60,0.08)', '#dc503c')}>PEP</span>
              )}
              {item.aml_result?.criminalRecordFound && (
                <span style={badgeStyle('rgba(220,80,60,0.08)', '#dc503c')}>Criminal Record</span>
              )}
              {isClaimed && (
                <span style={badgeStyle('rgba(25,68,69,0.06)', '#194445')}>
                  Claimed{item.claimedByEmail ? ` by ${item.claimedByEmail}` : ''}
                </span>
              )}
            </div>

            {/* LLM summary (always visible) */}
            {item.llm_narrative?.summary && (
              <div style={{ fontSize: 13, color: '#4a6364', lineHeight: 1.6, marginBottom: 12, padding: '12px 16px', background: '#f5f8f7', borderRadius: 12 }}>
                <div style={{ ...sectionLabelStyle, color: '#a28657', marginBottom: 6 }}>
                  Underwriting Summary
                </div>
                {item.llm_narrative.summary}
              </div>
            )}

            {/* Claim / Expand toggle */}
            {!isClaimed && (
              <button
                onClick={() => claimReview(item.id)}
                disabled={!!actionLoading}
                style={pillBtn('#194445', '#fff', !!actionLoading)}
              >
                {busy ? 'Claiming...' : 'Claim for Review'}
              </button>
            )}

            {isClaimed && !isExpanded && isClaimedByMe && (
              <button
                onClick={() => setExpandedId(item.id)}
                style={pillBtn('rgba(25,68,69,0.06)', '#194445')}
              >
                Open Review Panel
              </button>
            )}

            {isClaimed && !isClaimedByMe && !isExpanded && (
              <button
                onClick={() => setExpandedId(item.id)}
                style={pillBtn('rgba(147,170,169,0.08)', '#4a6364')}
              >
                View Details
              </button>
            )}

            {isExpanded && (
              <button
                onClick={() => setExpandedId(null)}
                style={{ ...pillBtn('rgba(147,170,169,0.08)', '#4a6364'), marginBottom: 16 }}
              >
                Collapse
              </button>
            )}

            {/* ── Expanded Review Panel ──────────────────────────────── */}
            {isExpanded && (
              <div style={{ marginTop: 16 }}>
                {/* Key Signals */}
                {item.llm_narrative?.key_signals?.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={sectionLabelStyle}>Key Signals</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {item.llm_narrative.key_signals.map((sig, i) => (
                        <span key={i} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 16, background: 'rgba(25,68,69,0.04)', color: '#4a6364' }}>
                          {sig}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* SHAP feature importance */}
                {item.shap_values?.features && item.shap_values.features.length > 0 && (
                  <div style={{ marginBottom: 16, padding: '14px 16px', background: '#f5f8f7', borderRadius: 12 }}>
                    <div style={{ ...sectionLabelStyle, marginBottom: 10 }}>SHAP Feature Importance</div>
                    {item.shap_values.features.map((f, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: '#4a6364', minWidth: 120 }}>{f.name}</span>
                        <div style={{ flex: 1, height: 6, background: 'rgba(25,68,69,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                          <div
                            style={{
                              height: '100%',
                              width: `${Math.min(Math.abs(f.value) * 100, 100)}%`,
                              background: f.impact === 'negative' ? '#dc503c' : '#247a6e',
                              borderRadius: 3,
                            }}
                          />
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 600, color: f.impact === 'negative' ? '#dc503c' : '#247a6e', minWidth: 50, textAlign: 'right' }}>
                          {f.value > 0 ? '+' : ''}{f.value.toFixed(3)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Bureau Data */}
                {item.bureau_data && (
                  <div style={{ marginBottom: 16, padding: '14px 16px', background: '#f5f8f7', borderRadius: 12 }}>
                    <div style={{ ...sectionLabelStyle, marginBottom: 10 }}>Bureau Data</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                      {item.bureau_data.score != null && (
                        <div>
                          <div style={{ fontSize: 10, color: '#93aaa9', textTransform: 'uppercase', letterSpacing: '1px' }}>Score</div>
                          <div style={{ fontSize: 18, fontWeight: 600, color: '#0c1e1f' }}>{item.bureau_data.score}</div>
                        </div>
                      )}
                      {item.bureau_data.tradelines != null && (
                        <div>
                          <div style={{ fontSize: 10, color: '#93aaa9', textTransform: 'uppercase', letterSpacing: '1px' }}>Tradelines</div>
                          <div style={{ fontSize: 18, fontWeight: 600, color: '#0c1e1f' }}>{item.bureau_data.tradelines}</div>
                        </div>
                      )}
                      {item.bureau_data.delinquencies != null && (
                        <div>
                          <div style={{ fontSize: 10, color: '#93aaa9', textTransform: 'uppercase', letterSpacing: '1px' }}>Delinquencies</div>
                          <div style={{ fontSize: 18, fontWeight: 600, color: item.bureau_data.delinquencies > 0 ? '#dc503c' : '#0c1e1f' }}>
                            {item.bureau_data.delinquencies}
                          </div>
                        </div>
                      )}
                      {item.bureau_data.inquiries30d != null && (
                        <div>
                          <div style={{ fontSize: 10, color: '#93aaa9', textTransform: 'uppercase', letterSpacing: '1px' }}>Inquiries (30d)</div>
                          <div style={{ fontSize: 18, fontWeight: 600, color: '#0c1e1f' }}>{item.bureau_data.inquiries30d}</div>
                        </div>
                      )}
                      {item.bureau_data.provider && (
                        <div>
                          <div style={{ fontSize: 10, color: '#93aaa9', textTransform: 'uppercase', letterSpacing: '1px' }}>Provider</div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: '#4a6364' }}>{item.bureau_data.provider}</div>
                        </div>
                      )}
                      {item.bureau_data.oldestAccount && (
                        <div>
                          <div style={{ fontSize: 10, color: '#93aaa9', textTransform: 'uppercase', letterSpacing: '1px' }}>Oldest Account</div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: '#4a6364' }}>{item.bureau_data.oldestAccount}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* AML details */}
                {item.aml_result && (
                  <div style={{ marginBottom: 16, padding: '14px 16px', background: '#f5f8f7', borderRadius: 12 }}>
                    <div style={{ ...sectionLabelStyle, marginBottom: 10 }}>AML / Compliance</div>
                    <div style={{ display: 'flex', gap: 16 }}>
                      <div style={{ fontSize: 12, color: item.aml_result.amlHit ? '#dc503c' : '#247a6e' }}>
                        AML: {item.aml_result.amlHit ? 'Hit' : 'Clear'}
                      </div>
                      <div style={{ fontSize: 12, color: item.aml_result.criminalRecordFound ? '#dc503c' : '#247a6e' }}>
                        Criminal: {item.aml_result.criminalRecordFound ? 'Found' : 'Clear'}
                      </div>
                      <div style={{ fontSize: 12, color: item.aml_result.isPEP ? '#dc503c' : '#247a6e' }}>
                        PEP: {item.aml_result.isPEP ? 'Yes' : 'No'}
                      </div>
                    </div>
                  </div>
                )}

                {/* Raw signals */}
                {item.signals && Object.keys(item.signals).length > 0 && (
                  <div style={{ marginBottom: 16, padding: '14px 16px', background: '#f5f8f7', borderRadius: 12 }}>
                    <div style={{ ...sectionLabelStyle, marginBottom: 10 }}>Raw Signals</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      {Object.entries(item.signals).map(([key, val]) => (
                        <div key={key} style={{ fontSize: 12, color: '#4a6364' }}>
                          <span style={{ fontWeight: 600 }}>{key}:</span>{' '}
                          {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recommendation */}
                {item.llm_narrative?.recommendation && (
                  <div style={{ fontSize: 13, color: '#4a6364', marginBottom: 16, padding: '12px 16px', background: 'rgba(162,134,87,0.06)', borderRadius: 12, border: '1px solid rgba(162,134,87,0.12)' }}>
                    <strong style={{ color: '#a28657' }}>LLM Recommendation:</strong> {item.llm_narrative.recommendation}
                  </div>
                )}

                {/* Notes + Decision (only if claimed by me) */}
                {isClaimedByMe && (
                  <>
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ ...sectionLabelStyle, marginBottom: 6 }}>Review Notes</div>
                      <textarea
                        placeholder="Add your review notes..."
                        value={notesMap[item.id] || ''}
                        onChange={e => setNotesMap(prev => ({ ...prev, [item.id]: e.target.value }))}
                        style={{
                          width: '100%',
                          minHeight: 64,
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
                        }}
                      />
                    </div>

                    {/* Decision buttons */}
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => submitDecision(item.id, 'approved')}
                        disabled={busy}
                        style={pillBtn('#194445', '#fff', busy)}
                      >
                        {busy ? 'Processing...' : 'Approve'}
                      </button>
                      <button
                        onClick={() => submitDecision(item.id, 'rejected')}
                        disabled={busy}
                        style={pillBtn('rgba(220,80,60,0.08)', '#dc503c', busy)}
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => submitDecision(item.id, 'escalated')}
                        disabled={busy}
                        style={pillBtn('rgba(162,134,87,0.10)', '#a28657', busy)}
                      >
                        Escalate
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
