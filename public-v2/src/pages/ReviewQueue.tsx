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

interface ReviewItem {
  id: string;
  loanId: string;
  applicantName: string;
  applicantRfc?: string;
  risk_level: string;
  llm_narrative: LlmNarrative;
  aml_result?: {
    amlHit: boolean;
    criminalRecordFound: boolean;
    isPEP: boolean;
  };
  signals?: Record<string, unknown>;
  priority: number;
  queuedAt: string;          // ISO-8601
  slaDeadline: string;       // ISO-8601
  status: string;
  reviewNotes?: string | null;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Returns elapsed hours since queuedAt */
function hoursElapsed(queuedAt: string): number {
  return (Date.now() - new Date(queuedAt).getTime()) / (1000 * 60 * 60);
}

/** Pretty-print remaining time, e.g. "4h 12m left" or "Overdue 2h 30m" */
function slaLabel(queuedAt: string): string {
  const elapsed = hoursElapsed(queuedAt);
  const remaining = 24 - elapsed;
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

/* ── component ───────────────────────────────────────────────────────────── */

export function ReviewQueue() {
  useAuth();
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [notesMap, setNotesMap] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);

  // Force re-render every 60s to keep SLA timers live
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Real-time listener — pending items ordered by queuedAt desc
  useEffect(() => {
    const q = query(
      collection(db, 'review_queue'),
      where('status', 'in', ['pending', 'pending_review']),
      orderBy('queuedAt', 'desc'),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setReviews(snap.docs.map(d => ({ id: d.id, ...d.data() } as ReviewItem)));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  const submitDecision = useCallback(
    async (reviewId: string, decision: 'approved' | 'rejected') => {
      setActionLoading(reviewId);
      try {
        const functions = getFunctions();
        const fn = httpsCallable(functions, 'submitReviewDecision');
        await fn({ reviewId, decision, notes: notesMap[reviewId] || undefined });
      } catch (e: any) {
        alert('Error: ' + (e?.message || 'Unknown error'));
      } finally {
        setActionLoading(null);
      }
    },
    [notesMap],
  );

  /* ── styles (matching AdminDashboard) ──────────────────────────────────── */

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

  const pillBtn = (color: string, textColor: string): React.CSSProperties => ({
    background: color,
    color: textColor,
    borderRadius: 60,
    padding: '10px 24px',
    fontSize: 12,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.2s',
    letterSpacing: '0.2px',
    opacity: actionLoading ? 0.6 : 1,
  });

  /* ── render ────────────────────────────────────────────────────────────── */

  return (
    <div style={{ maxWidth: 620, margin: '0 auto', padding: '48px 0 64px' }}>
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 26, color: '#0c1e1f', fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 8 }}>
          Review Queue
        </h1>
        <p style={{ fontSize: 14, color: '#4a6364', lineHeight: 1.7 }}>
          Loans flagged for Stage 5 manual review. 24-hour SLA per item.
        </p>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 32 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>Pending</div>
          <div style={valueStyle}>{reviews.length}</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>High Risk</div>
          <div style={{ ...valueStyle, color: reviews.some(r => r.risk_level === 'high') ? '#dc503c' : '#0c1e1f' }}>
            {reviews.filter(r => r.risk_level === 'high').length}
          </div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>SLA Breach</div>
          <div style={{ ...valueStyle, color: reviews.some(r => hoursElapsed(r.queuedAt) > 24) ? '#dc503c' : '#0c1e1f' }}>
            {reviews.filter(r => hoursElapsed(r.queuedAt) > 24).length}
          </div>
        </div>
      </div>

      {/* Section label */}
      {reviews.length > 0 && (
        <div style={{ ...labelStyle, marginBottom: 16 }}>Pending Review ({reviews.length})</div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: '#93aaa9' }}>
          <p style={{ fontSize: 14 }}>Loading reviews...</p>
        </div>
      )}

      {/* Empty */}
      {!loading && reviews.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: '#93aaa9' }}>
          <p style={{ fontSize: 14 }}>No pending reviews. All caught up.</p>
        </div>
      )}

      {/* Review cards */}
      {reviews.map(item => {
        const elapsed = hoursElapsed(item.queuedAt);
        const slaWarning = elapsed > 20;
        const slaBreach = elapsed > 24;
        const risk = riskColor(item.risk_level);

        return (
          <div key={item.id} style={{ ...cardStyle, padding: '24px 28px', borderLeft: slaBreach ? '3px solid #dc503c' : slaWarning ? '3px solid #b08420' : '3px solid transparent' }}>
            {/* Top row: name + SLA */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#0c1e1f', marginBottom: 4 }}>
                  {item.applicantName}
                </div>
                {item.applicantRfc && (
                  <div style={{ fontSize: 12, color: '#93aaa9' }}>RFC: {item.applicantRfc}</div>
                )}
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '4px 12px',
                  borderRadius: 20,
                  background: slaBreach ? 'rgba(220,80,60,0.08)' : slaWarning ? 'rgba(212,160,60,0.10)' : 'rgba(36,122,110,0.06)',
                  color: slaBreach ? '#dc503c' : slaWarning ? '#b08420' : '#247a6e',
                  whiteSpace: 'nowrap',
                }}
              >
                {slaLabel(item.queuedAt)}
              </div>
            </div>

            {/* Risk + confidence badges */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20, background: risk.bg, color: risk.text, textTransform: 'uppercase' }}>
                {item.risk_level} risk
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 20, background: 'rgba(147,170,169,0.10)', color: '#4a6364' }}>
                Confidence: {((item.llm_narrative?.confidence ?? 0) * 100).toFixed(0)}%
              </span>
              {item.aml_result?.amlHit && (
                <span style={{ fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20, background: 'rgba(220,80,60,0.08)', color: '#dc503c' }}>
                  AML Hit
                </span>
              )}
              {item.aml_result?.isPEP && (
                <span style={{ fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20, background: 'rgba(220,80,60,0.08)', color: '#dc503c' }}>
                  PEP
                </span>
              )}
              {item.priority <= 2 && (
                <span style={{ fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20, background: 'rgba(162,134,87,0.10)', color: '#a28657' }}>
                  Priority
                </span>
              )}
            </div>

            {/* LLM narrative summary */}
            {item.llm_narrative?.summary && (
              <div style={{ fontSize: 13, color: '#4a6364', lineHeight: 1.6, marginBottom: 10, padding: '12px 16px', background: '#f5f8f7', borderRadius: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', color: '#a28657', marginBottom: 6 }}>
                  Underwriting Summary
                </div>
                {item.llm_narrative.summary}
              </div>
            )}

            {/* Key signals */}
            {item.llm_narrative?.key_signals?.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', color: '#93aaa9', marginBottom: 6 }}>
                  Key Signals
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {item.llm_narrative.key_signals.map((sig, i) => (
                    <span key={i} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 16, background: 'rgba(25,68,69,0.04)', color: '#4a6364' }}>
                      {sig}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Recommendation */}
            {item.llm_narrative?.recommendation && (
              <div style={{ fontSize: 12, color: '#4a6364', marginBottom: 14 }}>
                <strong>Recommendation:</strong> {item.llm_narrative.recommendation}
              </div>
            )}

            {/* Notes input */}
            <div style={{ marginBottom: 14 }}>
              <textarea
                placeholder="Review notes (optional)..."
                value={notesMap[item.id] || ''}
                onChange={e => setNotesMap(prev => ({ ...prev, [item.id]: e.target.value }))}
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
                }}
              />
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                onClick={() => submitDecision(item.id, 'approved')}
                disabled={!!actionLoading}
                style={pillBtn('#194445', '#fff')}
              >
                {actionLoading === item.id ? 'Processing...' : 'Approve'}
              </button>
              <button
                onClick={() => submitDecision(item.id, 'rejected')}
                disabled={!!actionLoading}
                style={pillBtn('rgba(220,80,60,0.08)', '#dc503c')}
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
