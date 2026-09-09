import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { useNavigate } from 'react-router-dom';
import { db } from '../lib/firebase';
import { friendlyError } from '../lib/errors';
import { ErrorBanner } from '../components/ui/ErrorBanner';
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

function slaLabel(queuedAt: string, t: TFunction): string {
  const elapsed = hoursElapsed(queuedAt);
  const remaining = 24 - elapsed;
  if (remaining <= 0) {
    const over = Math.abs(remaining);
    const h = Math.floor(over);
    const m = Math.floor((over - h) * 60);
    return t('rq_sla_overdue', 'Vencido {{h}}h {{m}}m', { h, m });
  }
  const h = Math.floor(remaining);
  const m = Math.floor((remaining - h) * 60);
  return t('rq_sla_left', 'Faltan {{h}}h {{m}}m', { h, m });
}

/** Risk is never green: a low risk level is an input, not an approval. */
function riskClass(level: string): string {
  switch (level) {
    case 'critical':
    case 'high':
      return ' bad';
    case 'medium':
      return ' warn';
    default:
      return '';
  }
}

function urgencyLevel(item: ReviewItem): 'breach' | 'warning' | 'normal' {
  const elapsed = hoursElapsed(item.queuedAt);
  if (elapsed > 24) return 'breach';
  if (elapsed > 20) return 'warning';
  return 'normal';
}

function getEscalationReason(item: ReviewItem, t: TFunction): string {
  const reasons: string[] = [];
  if (item.aml_result?.criminalRecordFound) reasons.push(t('rq_reason_criminal', 'Antecedentes penales'));
  if (item.aml_result?.amlHit) reasons.push(t('rq_reason_aml', 'Coincidencia PLD'));
  if (item.aml_result?.isPEP) reasons.push(t('rq_reason_pep', 'PEP'));
  if (item.llm_narrative?.risk_level === 'high' || item.llm_narrative?.risk_level === 'critical') {
    reasons.push(t('rq_reason_llm', 'IA: {{level}}', { level: item.llm_narrative.risk_level }));
  }
  const signals = item.signals as Record<string, Record<string, unknown>> | undefined;
  if (signals?.bureau && (signals.bureau['activeDefaults'] as number) > 0) reasons.push(t('rq_reason_defaults', 'Incumplimientos activos'));
  if (signals?.riskseal && (signals.riskseal['score'] as number) < 30) reasons.push(t('rq_reason_riskseal', 'RiskSeal bajo'));
  if (signals?.bureau && (signals.bureau['score'] as number) < 400) reasons.push(t('rq_reason_bureau', 'Score de buró bajo'));
  return reasons.length > 0 ? reasons.join(', ') : t('rq_reason_stage4', 'Escalado en Etapa 4');
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
  const { t } = useTranslation();
  useAuth();
  const navigate = useNavigate();
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  // The error is held as a code + raw reason, not a translated sentence: a
  // formatted string here would drag `t` into the snapshot effect, whose
  // identity changes on language switch and would tear down and re-establish
  // the realtime listener every toggle. Translated at render instead.
  const [loadError, setLoadError] = useState<{ code: 'index' | 'generic'; reason?: string } | null>(null);
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
        setLoadError(null);
        setLoading(false);
      },
      (err) => {
        // A swallowed error here rendered "No pending reviews. All caught up."
        // — a failed read told the ops team that every waiting borrower had
        // been dealt with. This is the #503 rule (a failed read must not show a
        // spinner or a lie) applied to the console, which never got it.
        //
        // FAILED_PRECONDITION is called out by name because it is the live
        // risk, not a hypothetical: this query needs the
        // (status ASC, queuedAt ASC) composite index, and index deploys have
        // been 403'ing since 2026-07-31 on a missing IAM role (#414). Without
        // it the page fails exactly this way, and "all caught up" is what ops
        // would see.
        setLoadError(
          err.code === 'failed-precondition'
            ? { code: 'index' }
            : { code: 'generic', reason: friendlyError(err) }
        );
        setLoading(false);
      },
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
      getEscalationReason(r, t).split(', ').forEach(reason => set.add(reason));
    });
    return Array.from(set).sort();
  }, [reviews, t]);

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
      result = result.filter(r => getEscalationReason(r, t).includes(reasonFilter));
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
  }, [reviews, sortKey, urgencyFilter, employerFilter, reasonFilter, t]);

  const highRisk = reviews.filter(r => r.risk_level === 'high' || r.risk_level === 'critical').length;
  const breached = reviews.filter(r => hoursElapsed(r.queuedAt) > 24).length;

  /* ── render ──────────────────────────────────────────────────────────────── */

  return (
    <div className="ops-page">
      {/* Header */}
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_ops')}</div>
          <h1 className="ops-title">{t('rq_title', 'Cola de revisión')}</h1>
          <p className="ops-sub">{t('rq_subtitle', 'Préstamos marcados para revisión manual (Etapa 5). SLA de 24 horas por caso.')}</p>
        </div>
      </div>

      {/* Stats row */}
      <div className="ops-kpis" style={{ marginTop: 0, marginBottom: 10 }}>
        <div className="ops-kpi">
          <small>{t('rq_stat_pending', 'Pendientes')}</small>
          <b>{reviews.length}</b>
        </div>
        <div className={`ops-kpi${highRisk > 0 ? ' warn' : ''}`}>
          <small>{t('rq_stat_high_risk', 'Riesgo alto')}</small>
          <b>{highRisk}</b>
        </div>
        <div className={`ops-kpi${breached > 0 ? ' warn' : ''}`}>
          <small>{t('rq_stat_sla_breach', 'SLA incumplido')}</small>
          <b>{breached}</b>
        </div>
      </div>

      {/* Filters & Sort */}
      <div className="ops-card quiet" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '14px 16px' }}>
        <span className="ops-label" style={{ marginRight: 4 }}>{t('rq_filters', 'Filtros')}</span>
        <select
          aria-label={t('rq_aria_filter_urgency', 'Filtrar por urgencia')}
          value={urgencyFilter}
          onChange={e => setUrgencyFilter(e.target.value as UrgencyFilter)}
          className="ops-input"
          style={{ width: 'auto', minWidth: 150 }}
        >
          <option value="all">{t('rq_urgency_all', 'Toda urgencia')}</option>
          <option value="breach">{t('rq_urgency_breach', 'SLA incumplido')}</option>
          <option value="warning">{t('rq_urgency_warning', 'SLA por vencer')}</option>
        </select>
        <select
          aria-label={t('rq_aria_filter_employer', 'Filtrar por empleador')}
          value={employerFilter}
          onChange={e => setEmployerFilter(e.target.value)}
          className="ops-input"
          style={{ width: 'auto', minWidth: 170 }}
        >
          <option value="">{t('rq_employer_all', 'Todos los empleadores')}</option>
          {employers.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        <select
          aria-label={t('rq_aria_filter_reason', 'Filtrar por motivo')}
          value={reasonFilter}
          onChange={e => setReasonFilter(e.target.value)}
          className="ops-input"
          style={{ width: 'auto', minWidth: 150 }}
        >
          <option value="">{t('rq_reason_all', 'Todos los motivos')}</option>
          {reasons.map(r => <option key={r} value={r}>{r}</option>)}
        </select>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="ops-label">{t('rq_sort', 'Ordenar')}</span>
          <select
            aria-label={t('rq_aria_sort', 'Ordenar revisiones')}
            value={sortKey}
            onChange={e => setSortKey(e.target.value as SortKey)}
            className="ops-input"
            style={{ width: 'auto' }}
          >
            <option value="age">{t('rq_sort_age', 'Antigüedad (más antiguas primero)')}</option>
            <option value="amount">{t('rq_sort_amount', 'Monto (mayor primero)')}</option>
            <option value="lti">{t('rq_sort_lti', 'Razón préstamo/salario (mayor primero)')}</option>
          </select>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="ops-card" style={{ textAlign: 'center', padding: 48 }} aria-busy="true">
          <p className="ops-note">{t('rq_loading', 'Cargando revisiones...')}</p>
        </div>
      )}

      {/* Read failure — never rendered as an empty queue. */}
      {!loading && loadError && (
        <ErrorBanner
          message={
            loadError.code === 'index'
              ? t('rq_err_index', 'No se pudo cargar la cola: falta un índice de Firestore (#414). Esto NO significa que no haya revisiones pendientes.')
              : t('rq_err_generic', 'No se pudo cargar la cola de revisión: {{reason}}. Esto NO significa que no haya revisiones pendientes.', { reason: loadError.reason })
          }
          style={{ textAlign: 'left', marginBottom: 10 }}
        />
      )}

      {/* Empty. Gated on loadError: "All caught up" is a claim that every
          waiting borrower has been dealt with, and it must only be made when
          the queue was actually read. */}
      {!loading && !loadError && reviews.length === 0 && (
        <div className="ops-card">
          <div className="empty-state">
            <p>{t('rq_empty', 'No hay revisiones pendientes. Todo al día.')}</p>
          </div>
        </div>
      )}

      {/* Table */}
      {!loading && filteredReviews.length > 0 && (
        <section className="ops-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('rq_th_loan_id', 'ID de préstamo')}</th>
                  <th>{t('rq_th_applicant', 'Solicitante')}</th>
                  <th>{t('rq_th_employer', 'Empleador')}</th>
                  <th className="num">{t('rq_th_amount', 'Monto')}</th>
                  <th>{t('rq_th_risk', 'Riesgo')}</th>
                  <th>{t('rq_th_reason', 'Motivo')}</th>
                  <th>{t('rq_th_age', 'Antigüedad')}</th>
                  <th>{t('rq_th_sla', 'SLA')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredReviews.map(item => {
                  const urg = urgencyLevel(item);
                  const open = () => navigate(`/ops/review-queue/${item.id}`);

                  return (
                    <tr
                      key={item.id}
                      className={`ops-row-link${urg === 'breach' ? ' breach' : urg === 'warning' ? ' warning' : ''}`}
                      tabIndex={0}
                      onClick={open}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
                    >
                      <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, color: 'rgba(242,245,240,.75)' }}>
                        {item.loanId?.slice(0, 8) || '—'}
                      </td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{item.applicantName}</div>
                        {item.applicantRfc && (
                          <div style={{ fontSize: 11.5, color: 'rgba(242,245,240,.75)' }}>{item.applicantRfc}</div>
                        )}
                      </td>
                      <td style={{ fontSize: 12.5, color: 'rgba(242,245,240,.75)' }}>
                        {getEmployerName(item)}
                      </td>
                      <td className="num" style={{ fontWeight: 500 }}>
                        {getLoanAmount(item) > 0 ? `$${fmt(getLoanAmount(item))}` : '—'}
                      </td>
                      <td>
                        <span className={`ops-status${riskClass(item.risk_level)}`} style={{ textTransform: 'uppercase', fontSize: 10.5, letterSpacing: '.04em' }}>
                          {item.risk_level}
                        </span>
                      </td>
                      <td style={{ fontSize: 12.5, color: 'rgba(242,245,240,.75)', maxWidth: 200 }}>
                        <span style={{ display: 'inline-block', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                          {getEscalationReason(item, t)}
                        </span>
                      </td>
                      <td style={{ fontSize: 12.5, color: 'rgba(242,245,240,.75)' }}>
                        {ageLabel(item.queuedAt)}
                      </td>
                      <td>
                        <span className={`ops-status${urg === 'breach' ? ' bad' : urg === 'warning' ? ' warn' : ' g'}`}>
                          {slaLabel(item.queuedAt, t)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Filtered count */}
      {!loading && reviews.length > 0 && filteredReviews.length !== reviews.length && (
        <div className="ops-note" style={{ textAlign: 'center', marginTop: 8 }}>
          {t('rq_showing', 'Mostrando {{shown}} de {{total}} revisiones', { shown: filteredReviews.length, total: reviews.length })}
        </div>
      )}
    </div>
  );
}
