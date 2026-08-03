import { useState, useEffect, useMemo } from 'react';
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { useNavigate } from 'react-router-dom';
import { db } from '../lib/firebase';
import { OPEN_REVIEW_STATUSES } from '../lib/reviewStatus';
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

function hoursElapsed(queuedAt: string): number {
  return (Date.now() - new Date(queuedAt).getTime()) / (1000 * 60 * 60);
}

function ageLabel(queuedAt: string): string {
  const hours = hoursElapsed(queuedAt);
  if (hours < 1) return `${Math.floor(hours * 60)}m`;
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

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
    case 'critical':
      return { bg: 'rgba(180,40,30,0.10)', text: '#a01c14' };
    case 'high':
      return { bg: 'rgba(220,80,60,0.08)', text: 'var(--danger)' };
    case 'medium':
      return { bg: 'rgba(212,160,60,0.10)', text: 'var(--warning)' };
    case 'low':
      return { bg: 'rgba(36,122,110,0.08)', text: 'var(--brand-light)' };
    default:
      return { bg: 'rgba(147,170,169,0.10)', text: 'var(--t2)' };
  }
}

function urgencyLevel(item: ReviewItem): 'breach' | 'warning' | 'normal' {
  const elapsed = hoursElapsed(item.queuedAt);
  if (elapsed > 24) return 'breach';
  if (elapsed > 20) return 'warning';
  return 'normal';
}

function getEscalationReason(item: ReviewItem): string {
  const reasons: string[] = [];
  if (item.aml_result?.criminalRecordFound) reasons.push('Criminal record');
  if (item.aml_result?.amlHit) reasons.push('AML hit');
  if (item.aml_result?.isPEP) reasons.push('PEP');
  if (item.llm_narrative?.risk_level === 'high' || item.llm_narrative?.risk_level === 'critical') {
    reasons.push(`LLM: ${item.llm_narrative.risk_level}`);
  }
  const signals = item.signals as Record<string, Record<string, unknown>> | undefined;
  if (signals?.bureau && (signals.bureau['activeDefaults'] as number) > 0) reasons.push('Active defaults');
  if (signals?.riskseal && (signals.riskseal['score'] as number) < 30) reasons.push('Low RiskSeal');
  if (signals?.bureau && (signals.bureau['score'] as number) < 400) reasons.push('Low bureau score');
  return reasons.length > 0 ? reasons.join(', ') : 'Stage 4 escalation';
}

function getEmployerName(item: ReviewItem): string {
  const signals = item.signals as Record<string, Record<string, unknown>> | undefined;
  return (signals?.loan?.['employerName'] as string) || '—';
}

function getLoanAmount(item: ReviewItem): number {
  const signals = item.signals as Record<string, Record<string, unknown>> | undefined;
  return (signals?.loan?.['amount'] as number) || 0;
}

function getLTI(item: ReviewItem): number {
  const signals = item.signals as Record<string, Record<string, unknown>> | undefined;
  return (signals?.loan?.['loanToSalaryRatio'] as number) || 0;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

type SortKey = 'age' | 'amount' | 'lti';
type UrgencyFilter = 'all' | 'breach' | 'warning';

/* ── component ───────────────────────────────────────────────────────────── */

export function ReviewQueue() {
  useAuth();
  const navigate = useNavigate();
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);

  // Filters & sorting
  const [sortKey, setSortKey] = useState<SortKey>('age');
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>('all');
  const [employerFilter, setEmployerFilter] = useState('');
  const [reasonFilter, setReasonFilter] = useState('');

  // Force re-render every 60s to keep SLA timers live
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Real-time listener
  useEffect(() => {
    // All four OPEN statuses, not just the two un-triaged ones. `info_requested`
    // and `escalated` are outstanding work — the backend keeps both decidable —
    // and this is the only surface in the app that queries `review_queue`, so
    // excluding them here removed them from the product entirely: the review
    // could not be reached, the loan stayed `under_review`, and `under_review`
    // occupies the borrower's only loan slot. See src/lib/reviewStatus.ts.
    const q = query(
      collection(db, 'review_queue'),
      where('status', 'in', [...OPEN_REVIEW_STATUSES]),
      orderBy('queuedAt', 'asc'),
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

  // Unique employers for filter dropdown
  const employers = useMemo(() => {
    const set = new Set<string>();
    reviews.forEach(r => {
      const emp = getEmployerName(r);
      if (emp !== '—') set.add(emp);
    });
    return Array.from(set).sort();
  }, [reviews]);

  // Unique escalation reasons for filter dropdown
  const reasons = useMemo(() => {
    const set = new Set<string>();
    reviews.forEach(r => {
      getEscalationReason(r).split(', ').forEach(reason => set.add(reason));
    });
    return Array.from(set).sort();
  }, [reviews]);

  // Filtered and sorted reviews
  const filteredReviews = useMemo(() => {
    let result = [...reviews];

    if (urgencyFilter !== 'all') {
      result = result.filter(r => urgencyLevel(r) === urgencyFilter);
    }
    if (employerFilter) {
      result = result.filter(r => getEmployerName(r) === employerFilter);
    }
    if (reasonFilter) {
      result = result.filter(r => getEscalationReason(r).includes(reasonFilter));
    }

    result.sort((a, b) => {
      switch (sortKey) {
        case 'age':
          return new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime();
        case 'amount':
          return getLoanAmount(b) - getLoanAmount(a);
        case 'lti':
          return getLTI(b) - getLTI(a);
        default:
          return 0;
      }
    });

    return result;
  }, [reviews, sortKey, urgencyFilter, employerFilter, reasonFilter]);

  /* ── styles ──────────────────────────────────────────────────────────────── */

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

  const selectStyle: React.CSSProperties = {
    fontSize: 12,
    padding: '8px 12px',
    borderRadius: 10,
    border: '1px solid rgba(25,68,69,0.10)',
    background: '#fff',
    color: 'var(--t1)',
    fontFamily: "'DM Sans',sans-serif",
    outline: 'none',
    cursor: 'pointer',
    minWidth: 120,
  };

  const thStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '1.8px',
    color: 'var(--t3)',
    padding: '12px 14px',
    textAlign: 'left',
    borderBottom: '1px solid rgba(25,68,69,0.06)',
    whiteSpace: 'nowrap',
  };

  const tdStyle: React.CSSProperties = {
    fontSize: 13,
    color: 'var(--t1)',
    padding: '14px',
    borderBottom: '1px solid rgba(25,68,69,0.04)',
    verticalAlign: 'middle',
  };

  /* ── render ──────────────────────────────────────────────────────────────── */

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: '48px 0 64px' }}>
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontFamily: 'var(--df)', fontSize: 26, color: 'var(--t1)', fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 8 }}>
          Review Queue
        </h1>
        <p style={{ fontSize: 14, color: 'var(--t2)', lineHeight: 1.7 }}>
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
          <div style={{ ...valueStyle, color: reviews.some(r => r.risk_level === 'high' || r.risk_level === 'critical') ? 'var(--danger)' : 'var(--t1)' }}>
            {reviews.filter(r => r.risk_level === 'high' || r.risk_level === 'critical').length}
          </div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>SLA Breach</div>
          <div style={{ ...valueStyle, color: reviews.some(r => hoursElapsed(r.queuedAt) > 24) ? 'var(--danger)' : 'var(--t1)' }}>
            {reviews.filter(r => hoursElapsed(r.queuedAt) > 24).length}
          </div>
        </div>
      </div>

      {/* Filters & Sort */}
      <div style={{ ...cardStyle, padding: '16px 20px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--t3)', marginRight: 4 }}>
          Filters
        </div>
        <select
          aria-label="Filter by urgency"
          value={urgencyFilter}
          onChange={e => setUrgencyFilter(e.target.value as UrgencyFilter)}
          style={selectStyle}
        >
          <option value="all">All urgency</option>
          <option value="breach">SLA breach</option>
          <option value="warning">SLA warning</option>
        </select>
        <select
          aria-label="Filter by employer"
          value={employerFilter}
          onChange={e => setEmployerFilter(e.target.value)}
          style={selectStyle}
        >
          <option value="">All employers</option>
          {employers.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        <select
          aria-label="Filter by reason"
          value={reasonFilter}
          onChange={e => setReasonFilter(e.target.value)}
          style={selectStyle}
        >
          <option value="">All reasons</option>
          {reasons.map(r => <option key={r} value={r}>{r}</option>)}
        </select>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--t3)' }}>
            Sort
          </span>
          <select
            aria-label="Sort reviews"
            value={sortKey}
            onChange={e => setSortKey(e.target.value as SortKey)}
            style={selectStyle}
          >
            <option value="age">Age (oldest first)</option>
            <option value="amount">Amount (highest)</option>
            <option value="lti">LTI ratio (highest)</option>
          </select>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--t3)' }}>
          <p style={{ fontSize: 14 }}>Loading reviews...</p>
        </div>
      )}

      {/* Empty */}
      {!loading && reviews.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--t3)' }}>
          <p style={{ fontSize: 14 }}>No pending reviews. All caught up.</p>
        </div>
      )}

      {/* Table */}
      {!loading && filteredReviews.length > 0 && (
        <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Loan ID</th>
                  <th style={thStyle}>Applicant</th>
                  <th style={thStyle}>Employer</th>
                  <th style={thStyle}>Amount</th>
                  <th style={thStyle}>Risk</th>
                  <th style={thStyle}>Reason</th>
                  <th style={thStyle}>Age</th>
                  <th style={thStyle}>SLA</th>
                </tr>
              </thead>
              <tbody>
                {filteredReviews.map(item => {
                  const urg = urgencyLevel(item);
                  const risk = riskColor(item.risk_level);

                  return (
                    <tr
                      key={item.id}
                      onClick={() => navigate(`/ops/review-queue/${item.id}`)}
                      style={{
                        cursor: 'pointer',
                        transition: 'background 0.15s',
                        borderLeft: urg === 'breach' ? '3px solid var(--danger)' : urg === 'warning' ? '3px solid var(--warning)' : '3px solid transparent',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(25,68,69,0.02)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={{ ...tdStyle, fontFamily: "'DM Mono', monospace", fontSize: 11, color: 'var(--t2)' }}>
                        {item.loanId?.slice(0, 8) || '—'}
                      </td>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600 }}>{item.applicantName}</div>
                        {item.applicantRfc && (
                          <div style={{ fontSize: 11, color: 'var(--t3)' }}>{item.applicantRfc}</div>
                        )}
                      </td>
                      <td style={{ ...tdStyle, fontSize: 12, color: 'var(--t2)' }}>
                        {getEmployerName(item)}
                      </td>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>
                        {getLoanAmount(item) > 0 ? `$${fmt(getLoanAmount(item))}` : '—'}
                      </td>
                      <td style={tdStyle}>
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '3px 10px',
                          borderRadius: 20,
                          background: risk.bg,
                          color: risk.text,
                          textTransform: 'uppercase',
                          whiteSpace: 'nowrap',
                        }}>
                          {item.risk_level}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, fontSize: 12, color: 'var(--t2)', maxWidth: 180 }}>
                        <span style={{ display: 'inline-block', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {getEscalationReason(item)}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, fontSize: 12, fontWeight: 600, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                        {ageLabel(item.queuedAt)}
                      </td>
                      <td style={tdStyle}>
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '3px 10px',
                          borderRadius: 20,
                          background: urg === 'breach' ? 'rgba(220,80,60,0.08)' : urg === 'warning' ? 'rgba(212,160,60,0.10)' : 'rgba(36,122,110,0.06)',
                          color: urg === 'breach' ? 'var(--danger)' : urg === 'warning' ? 'var(--warning)' : 'var(--brand-light)',
                          whiteSpace: 'nowrap',
                        }}>
                          {slaLabel(item.queuedAt)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Filtered count */}
      {!loading && reviews.length > 0 && filteredReviews.length !== reviews.length && (
        <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--t3)', marginTop: 8 }}>
          Showing {filteredReviews.length} of {reviews.length} reviews
        </div>
      )}
    </div>
  );
}
