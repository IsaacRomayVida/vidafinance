import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';
import { isActiveDeductionStatus } from '../lib/loanStatus';

interface Employer {
  id: string;
  companyName: string;
  email: string;
  status: string;
  employerCode?: string;
  companySize?: string;
  createdAt?: { seconds: number };
  docRFC?: string | null;
}

interface Loan {
  id: string;
  employeeName: string;
  employerName: string;
  employerId?: string;
  amount: number;
  total: number;
  status: string;
  mlCreditScore?: number;
  mlDefaultProb?: number;
  createdAt?: { seconds: number };
}

interface DashStats {
  totalEmployers: number;
  totalEmployees: number;
  activeLoans: number;
  totalDisbursed: number;
  pendingLoans: number;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/* ── quincena helpers (presentation only) ─────────────────────────────────
   A quincena is the 1st–15th or the 16th–end of a month. The board names the
   lit folder after the current one; nothing here schedules or prices. */
function quincenaStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() >= 16 ? 16 : 1);
}
function monthShort(d: Date, lang: string): string {
  return d.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short' }).replace('.', '');
}

/** Of the loans in payroll deduction (isActiveDeductionStatus), these are late. */
const LATE = new Set(['overdue', 'in_collections']);
/** The same set the page has always called "active" for the queue below. */
const ACTIVE = new Set(['active', 'approved', 'disbursement_queued']);

interface EmployerGroup {
  key: string;
  name: string;
  active: number;
  pending: number;
  total: number;
  status?: string;
}


/** Which rendered object stands for each thing on the stage. */
function stageIcon(kind: 'quincena' | 'empleador' | 'kyc' | 'contrato' | 'condusef' | 'sat' | 'cobranza'): string {
  return `/images/brand/icon-${kind}.png`;
}

export function AdminDashboard() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashStats>({ totalEmployers: 0, totalEmployees: 0, activeLoans: 0, totalDisbursed: 0, pendingLoans: 0 });
  const [employers, setEmployers] = useState<Employer[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [tab, setTab] = useState<'employers' | 'loans'>('employers');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Fetch stats from Cloud Function
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const functions = getFunctions();
        const getAdminDash = httpsCallable<unknown, { stats: DashStats }>(functions, 'getAdminDashboard');
        const result = await getAdminDash({});
        if (result.data.stats) setStats(result.data.stats);
      } catch {
        // Dashboard stats fetch failed — non-critical, UI shows stale data
      }
    })();
  }, [user]);

  // Real-time employers listener
  useEffect(() => {
    const q = query(collection(db, 'employers'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as Employer));
      setEmployers(data);
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, []);

  // Real-time loans listener
  useEffect(() => {
    const q = query(collection(db, 'loans'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      setLoans(snap.docs.map(d => ({ id: d.id, ...d.data() } as Loan)));
    });
    return unsub;
  }, []);

  const approveEmployer = async (employerId: string, decision: 'approved' | 'rejected') => {
    const msg = decision === 'approved'
      ? t('admin_confirm_approve', '¿Aprobar este empleador?')
      : t('admin_confirm_reject', '¿Rechazar este empleador?');
    if (!window.confirm(msg)) return;
    setActionLoading(employerId);
    try {
      const functions = getFunctions();
      const fn = httpsCallable(functions, 'approveEmployer');
      await fn({ employerUid: employerId, decision, rejectionReason: decision === 'rejected' ? 'Not qualified' : undefined });
      // Refresh stats
      const getAdminDash = httpsCallable<unknown, { stats: DashStats }>(functions, 'getAdminDashboard');
      const result = await getAdminDash({});
      if (result.data.stats) setStats(result.data.stats);
    } catch (e: unknown) {
      alert('Error: ' + ((e as Error)?.message || 'Unknown error'));
    } finally {
      setActionLoading(null);
    }
  };

  const reviewLoan = async (loanId: string, decision: 'approved' | 'rejected') => {
    if (!window.confirm(decision === 'approved' ? t('admin_confirm_approve_loan', '¿Aprobar este préstamo?') : t('admin_confirm_reject_loan', '¿Rechazar este préstamo?'))) return;
    setActionLoading(loanId);
    try {
      const functions = getFunctions();
      const fn = httpsCallable(functions, 'submitReviewDecision');
      await fn({ loanId, decision, note: decision === 'rejected' ? 'Not approved' : 'Approved by ops' });
    } catch (e: unknown) {
      alert('Error: ' + ((e as Error)?.message || 'Unknown error'));
    } finally {
      setActionLoading(null);
    }
  };

  const pendingEmployers = employers.filter(e => e.status === 'pending_verification' || e.status === 'pending_review');
  const activeEmployers = employers.filter(e => e.status === 'active');
  const pendingLoans = loans.filter(l => l.status === 'pending');
  const activeLoans = loans.filter(l => ACTIVE.has(l.status));

  /* ── the board: derived from the reads above, naming real objects —
     the top employers, the current quincena, the review queue, sign-ups. ── */
  const lang = i18n.language;
  const cur = quincenaStart(new Date());
  const curLabel = t('ops_quincena', { day: cur.getDate(), month: monthShort(cur, lang) });

  const inDeduction = loans.filter(l => isActiveDeductionStatus(l.status));
  const onSchedule = inDeduction.filter(l => !LATE.has(l.status)).length;
  const pct = inDeduction.length > 0 ? Math.round((onSchedule / inDeduction.length) * 100) : null;

  const groups = new Map<string, EmployerGroup>();
  for (const l of loans) {
    const key = l.employerId || l.employerName || '';
    if (!key) continue;
    const g = groups.get(key) ?? { key, name: l.employerName || key, active: 0, pending: 0, total: 0 };
    if (ACTIVE.has(l.status)) { g.active += 1; g.total += Number(l.total) || 0; }
    else if (l.status === 'pending') g.pending += 1;
    groups.set(key, g);
  }
  for (const e of employers) {
    const g = groups.get(e.id) ?? [...groups.values()].find(x => x.name === e.companyName);
    if (g) { g.status = e.status; g.name = e.companyName || g.name; }
  }
  const employerRows = [...groups.values()]
    .sort((a, b) => b.active - a.active || b.pending - a.pending)
    .slice(0, 6);
  const stackEmployers = employerRows.slice(0, 3);
  const folders: { i: number; label: string; n: number; lit?: boolean; kind: 'quincena' | 'empleador' | 'contrato' }[] = [
    ...stackEmployers.map((g, idx) => ({ i: idx - stackEmployers.length, label: g.name, n: g.active, kind: 'empleador' as const })),
    { i: 0, label: curLabel, n: inDeduction.length, lit: true, kind: 'quincena' },
    { i: 1, label: t('ops_folder_review'), n: pendingLoans.length, kind: 'contrato' },
    { i: 2, label: t('ops_folder_signups'), n: pendingEmployers.length, kind: 'empleador' },
  ];

  return (
    <div>
      <div className="ops-board">
        {/* ── stage ── */}
        <section className="ops-panel stage" aria-labelledby="ops-stage-title">
          <div className="dot ops-eyebrow">{t('ops_eyebrow_ops')} · {curLabel}</div>
          <h1 id="ops-stage-title" className="ops-title">{t('admin_title')}</h1>
          <p className="ops-sub">{t('admin_subtitle')}</p>

          <div className="ops-objects" aria-hidden="true">
            {folders.map((f) => (
              <div key={f.i} className={`ops-object${f.lit ? ' lit' : ''}`}>
                <img src={stageIcon(f.kind)} alt="" loading="lazy" />
                <b>{f.n}</b>
                <span>{f.label}</span>
              </div>
            ))}
          </div>

          <div className="ops-prog">
            <div className="h"><span>{curLabel}</span><span aria-hidden="true">↗</span></div>
            <div className="d">
              {pct === null
                ? t('ops_prog_none')
                : t('ops_prog_on_schedule', { ok: onSchedule, total: inDeduction.length })}
            </div>
            <div className="v">{pct === null ? '—' : <>{pct}<b>%</b></>}</div>
            <span className="dotg" aria-hidden="true" />
          </div>
        </section>

        {/* ── data ── */}
        <section className="ops-panel data" aria-labelledby="ops-data-title">
          <span className="ops-tag" id="ops-data-title"><i aria-hidden="true" />{t('ops_live_book')}</span>

          <div className="ops-kpis">
            <div className="ops-kpi">
              <small>{t('admin_total_disbursed')}</small>
              <b>${fmt(stats.totalDisbursed)}<span>MXN</span></b>
            </div>
            <div className="ops-kpi">
              <small>{t('admin_active_loans')}</small>
              <b>{stats.activeLoans || activeLoans.length}</b>
            </div>
            <div className={`ops-kpi${pendingEmployers.length + pendingLoans.length > 0 ? ' warn' : ''}`}>
              <small>{t('admin_pending')}</small>
              <b>{pendingEmployers.length + pendingLoans.length}</b>
            </div>
          </div>
          <div className="ops-kpi-line">
            {t('admin_employers')} <span>{stats.totalEmployers || employers.length}</span>
            {' · '}{t('admin_employees')} <span>{fmt(stats.totalEmployees)}</span>
          </div>

          <h2 className="ops-h3">{t('ops_collections_by_employer')}</h2>
          {employerRows.length === 0 ? (
            <div className="ops-batch">
              <span className="fl" aria-hidden="true" />
              <span className="t">{t('ops_rows_employers_empty')}</span>
            </div>
          ) : employerRows.map((g) => (
            <div className="ops-batch" key={g.key}>
              <span className={`fl${g.status === 'active' ? ' g' : ''}`} aria-hidden="true" />
              <span className="t">
                {g.name}
                <small>{t('ops_row_employer', { active: g.active, pending: g.pending })}</small>
              </span>
              <span className="p">{g.active > 0 ? '$' + fmt(g.total) : '—'}</span>
            </div>
          ))}

          <button type="button" className="ops-go" onClick={() => navigate('/ops/review-queue')}>
            <i aria-hidden="true" />{t('ops_go_review', { count: pendingLoans.length })}
          </button>
        </section>
      </div>

      {/* ── queues ── */}
      <div className="ops-chips" style={{ margin: '14px 4px' }}>
        {(['employers', 'loans'] as const).map(tabKey => {
          const on = tab === tabKey;
          return (
            <button
              key={tabKey}
              type="button"
              onClick={() => setTab(tabKey)}
              className={`ops-chip${on ? ' on' : ''}`}
              aria-pressed={on}
            >
              {tabKey === 'employers' ? t('admin_employers') : t('admin_loans_tab', 'Préstamos')}
              <span className="cnt">{tabKey === 'employers' ? pendingEmployers.length : pendingLoans.length}</span>
            </button>
          );
        })}
      </div>

      {/* Employer list */}
      {tab === 'employers' && (
        <section className="ops-card">
          {pendingEmployers.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h2 className="ops-h3">{t('admin_pending_approval')}</h2>
              {pendingEmployers.map(emp => (
                <div key={emp.id} className="ops-batch" style={{ flexWrap: 'wrap' }}>
                  <span className="fl" aria-hidden="true" />
                  <span className="t">
                    {emp.companyName}
                    <small>
                      {emp.email} · {emp.companySize || '—'} · {t('admin_code')} {emp.employerCode || '—'} · {emp.docRFC ? t('admin_docs_uploaded') : t('admin_docs_missing')}
                    </small>
                  </span>
                  <span className="ops-actions">
                    <button
                      type="button"
                      className="ops-btn sm"
                      onClick={() => approveEmployer(emp.id, 'approved')}
                      disabled={!!actionLoading}
                    >
                      {actionLoading === emp.id ? '...' : t('admin_approve', 'Aprobar')}
                    </button>
                    <button
                      type="button"
                      className="ops-btn sm ghost danger"
                      onClick={() => approveEmployer(emp.id, 'rejected')}
                      disabled={!!actionLoading}
                    >
                      {t('admin_reject')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {activeEmployers.length > 0 && (
            <div>
              <h2 className="ops-h3">{t('admin_active_employers')}</h2>
              {activeEmployers.map(emp => (
                <div key={emp.id} className="ops-batch">
                  <span className="fl g" aria-hidden="true" />
                  <span className="t">
                    {emp.companyName}
                    <small>{emp.email}</small>
                  </span>
                  <span className="ops-status g">{t('status_active', 'Activo')}</span>
                </div>
              ))}
            </div>
          )}

          {employers.length === 0 && !loading && (
            <div className="empty-state">
              <p>{t('admin_no_employers')}</p>
            </div>
          )}
        </section>
      )}

      {/* Loan list */}
      {tab === 'loans' && (
        <section className="ops-card">
          {pendingLoans.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h2 className="ops-h3">{t('admin_pending')}</h2>
              {pendingLoans.map(loan => (
                <div key={loan.id} className="ops-batch" style={{ flexWrap: 'wrap' }}>
                  <span className="fl" aria-hidden="true" />
                  <span className="t">
                    {loan.employeeName}
                    <small>
                      {loan.employerName}
                      {loan.mlCreditScore !== undefined && (
                        <> · {t('admin_ml_score')} {loan.mlCreditScore} · {t('admin_default_prob')} {((loan.mlDefaultProb || 0) * 100).toFixed(0)}%</>
                      )}
                    </small>
                  </span>
                  <span className="p">${fmt(loan.amount)}<small>MXN</small></span>
                  <span className="ops-actions">
                    <button
                      type="button"
                      className="ops-btn sm"
                      onClick={() => reviewLoan(loan.id, 'approved')}
                      disabled={!!actionLoading}
                    >
                      {actionLoading === loan.id ? '...' : t('admin_approve_loan', 'Aprobar Préstamo')}
                    </button>
                    <button
                      type="button"
                      className="ops-btn sm ghost danger"
                      onClick={() => reviewLoan(loan.id, 'rejected')}
                      disabled={!!actionLoading}
                    >
                      {t('admin_reject')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {activeLoans.length > 0 && (
            <div>
              <h2 className="ops-h3">{t('admin_active_loans')}</h2>
              {activeLoans.map(loan => (
                <div key={loan.id} className="ops-batch">
                  <span className="fl g" aria-hidden="true" />
                  <span className="t">
                    {loan.employeeName}
                    <small>{loan.employerName}</small>
                  </span>
                  <span className="p g">${fmt(loan.amount)}</span>
                </div>
              ))}
            </div>
          )}

          {loans.length === 0 && (
            <div className="empty-state">
              <p>{t('admin_no_loans')}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
