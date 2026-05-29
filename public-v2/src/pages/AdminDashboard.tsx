import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

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

export function AdminDashboard() {
  const { user } = useAuth();
  const { t } = useTranslation();
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
  const activeLoans = loans.filter(l => l.status === 'active' || l.status === 'approved' || l.status === 'disbursement_queued');

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

  return (
    <div style={{ maxWidth: 620, margin: '0 auto', padding: '48px 0 64px' }}>
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontFamily: 'var(--df)', fontSize: 26, color: 'var(--t1)', fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 8 }}>
          {t('admin_title')}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--t2)', lineHeight: 1.7 }}>
          {t('admin_subtitle')}
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 32 }}>
        <div style={cardStyle}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'rgba(168,213,208,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#194445" strokeWidth="1.5"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22V12h6v10"/><path d="M8 6h.01M16 6h.01M12 6h.01"/></svg>
          </div>
          <div style={labelStyle}>{t('admin_employers')}</div>
          <div style={valueStyle}>{stats.totalEmployers || employers.length}</div>
        </div>
        <div style={cardStyle}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'rgba(168,213,208,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#194445" strokeWidth="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
          </div>
          <div style={labelStyle}>{t('admin_employees')}</div>
          <div style={valueStyle}>{stats.totalEmployees}</div>
        </div>
        <div style={cardStyle}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'rgba(36,122,110,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#247a6e" strokeWidth="1.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          </div>
          <div style={labelStyle}>{t('admin_active_loans')}</div>
          <div style={valueStyle}>{stats.activeLoans || activeLoans.length}</div>
        </div>
        <div style={cardStyle}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'rgba(162,134,87,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a28657" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          </div>
          <div style={labelStyle}>{t('admin_pending')}</div>
          <div style={valueStyle}>{pendingEmployers.length + pendingLoans.length}</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 32, borderBottom: '1px solid rgba(25,68,69,0.06)', marginBottom: 24 }}>
        {(['employers', 'loans'] as const).map(tabKey => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            style={{
              fontSize: 12, fontWeight: tab === tabKey ? 700 : 500,
              color: tab === tabKey ? 'var(--brand)' : 'var(--t3)',
              textTransform: 'uppercase', letterSpacing: '0.5px',
              padding: '14px 0', background: 'none', border: 'none',
              borderBottom: tab === tabKey ? '2px solid var(--gold)' : '2px solid transparent',
              cursor: 'pointer', transition: 'all 0.2s',
            }}
          >
            {tabKey === 'employers' ? `${t('admin_employers')} (${pendingEmployers.length} ${t('admin_pending_short', 'pendientes')})` : `${t('admin_loans_tab', 'Préstamos')} (${pendingLoans.length} ${t('admin_pending_short', 'pendientes')})`}
          </button>
        ))}
      </div>

      {/* Employer list */}
      {tab === 'employers' && (
        <div>
          {pendingEmployers.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ ...labelStyle, marginBottom: 16 }}>Pending Approval</div>
              {pendingEmployers.map(emp => (
                <div key={emp.id} style={{ ...cardStyle, padding: '24px 28px' }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--t1)', marginBottom: 6 }}>{emp.companyName}</div>
                  <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 4 }}>{emp.email}</div>
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 16 }}>
                    {emp.companySize || '—'} · Code: {emp.employerCode || '—'} · Docs: {emp.docRFC ? 'Uploaded' : 'Missing'}
                  </div>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <button
                      onClick={() => approveEmployer(emp.id, 'approved')}
                      disabled={!!actionLoading}
                      style={pillBtn('var(--brand)', '#fff')}
                    >
                      {actionLoading === emp.id ? '...' : t('admin_approve', 'Aprobar')}
                    </button>
                    <button
                      onClick={() => approveEmployer(emp.id, 'rejected')}
                      disabled={!!actionLoading}
                      style={pillBtn('rgba(220,80,60,0.08)', 'var(--danger)')}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeEmployers.length > 0 && (
            <div>
              <div style={{ ...labelStyle, marginBottom: 16 }}>Active Employers</div>
              {activeEmployers.map(emp => (
                <div key={emp.id} style={{ ...cardStyle, padding: '20px 28px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t1)' }}>{emp.companyName}</div>
                      <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>{emp.email}</div>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand-light)', background: 'rgba(36,122,110,0.06)', padding: '4px 12px', borderRadius: 20 }}>{t('status_active', 'Activo')}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {employers.length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--t3)' }}>
              <p style={{ fontSize: 14 }}>No employers registered yet.</p>
            </div>
          )}
        </div>
      )}

      {/* Loan list */}
      {tab === 'loans' && (
        <div>
          {pendingLoans.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ ...labelStyle, marginBottom: 16 }}>{t('admin_pending')}</div>
              {pendingLoans.map(loan => (
                <div key={loan.id} style={{ ...cardStyle, padding: '24px 28px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--t1)', marginBottom: 4 }}>{loan.employeeName}</div>
                      <div style={{ fontSize: 13, color: 'var(--t2)' }}>{loan.employerName}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: 'var(--df)', fontSize: 24, color: 'var(--t1)' }}>${fmt(loan.amount)}</div>
                      <div style={{ fontSize: 11, color: 'var(--t3)' }}>MXN</div>
                    </div>
                  </div>
                  {loan.mlCreditScore !== undefined && (
                    <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 12, display: 'flex', gap: 16 }}>
                      <span>ML Score: <strong>{loan.mlCreditScore}</strong></span>
                      <span>Default Prob: <strong>{((loan.mlDefaultProb || 0) * 100).toFixed(0)}%</strong></span>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 12 }}>
                    <button onClick={() => reviewLoan(loan.id, 'approved')} disabled={!!actionLoading} style={pillBtn('var(--brand)', '#fff')}>
                      {actionLoading === loan.id ? '...' : t('admin_approve_loan', 'Aprobar Préstamo')}
                    </button>
                    <button onClick={() => reviewLoan(loan.id, 'rejected')} disabled={!!actionLoading} style={pillBtn('rgba(220,80,60,0.08)', 'var(--danger)')}>
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeLoans.length > 0 && (
            <div>
              <div style={{ ...labelStyle, marginBottom: 16 }}>{t('admin_active_loans')}</div>
              {activeLoans.map(loan => (
                <div key={loan.id} style={{ ...cardStyle, padding: '20px 28px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t1)' }}>{loan.employeeName}</div>
                      <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{loan.employerName}</div>
                    </div>
                    <div style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>${fmt(loan.amount)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {loans.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--t3)' }}>
              <p style={{ fontSize: 14 }}>No loan applications yet.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
