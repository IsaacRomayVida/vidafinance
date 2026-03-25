import { useState, useEffect } from 'react';
import { collection, query, onSnapshot, orderBy } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

interface Employer {
  id: string;
  companyName: string;
  email: string;
  status: string;
  createdAt?: { seconds: number };
  employerCode?: string;
  docRFC?: string | null;
}

interface Loan {
  id: string;
  employeeName: string;
  employerName: string;
  amount: number;
  status: string;
  createdAt?: { seconds: number };
  mlCreditScore?: number;
  mlDefaultProb?: number;
}

interface Stats {
  totalEmployers: number;
  totalEmployees: number;
  activeLoans: number;
  totalDisbursed: number;
}

export function AdminDashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats>({ totalEmployers: 0, totalEmployees: 0, activeLoans: 0, totalDisbursed: 0 });
  const [employers, setEmployers] = useState<Employer[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [tab, setTab] = useState<'employers' | 'loans'>('employers');

  // Fetch stats
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const functions = getFunctions();
        const getAdminDash = httpsCallable<unknown, { stats: Stats }>(functions, 'getAdminDashboard');
        const result = await getAdminDash({});
        setStats(result.data.stats || stats);
      } catch (e) {
        console.warn('getAdminDashboard failed:', e);
      }
    })();
  }, [user]);

  // Real-time employers
  useEffect(() => {
    const q = query(collection(db, 'employers'), orderBy('createdAt', 'desc'));
    return onSnapshot(q, (snap) => {
      setEmployers(snap.docs.map(d => ({ id: d.id, ...d.data() } as Employer)));
      setLoading(false);
    }, () => setLoading(false));
  }, []);

  // Real-time loans
  useEffect(() => {
    const q = query(collection(db, 'loans'), orderBy('createdAt', 'desc'));
    return onSnapshot(q, (snap) => {
      setLoans(snap.docs.map(d => ({ id: d.id, ...d.data() } as Loan)));
    }, () => {});
  }, []);

  const handleApproveEmployer = async (employerId: string) => {
    setActionLoading(employerId);
    try {
      const functions = getFunctions();
      const approve = httpsCallable(functions, 'approveEmployer');
      await approve({ employerId, decision: 'approved' });
    } catch (e) {
      console.error('Approve failed:', e);
      alert('Error: ' + (e as Error).message);
    }
    setActionLoading(null);
  };

  const handleRejectEmployer = async (employerId: string) => {
    const reason = prompt('Rejection reason:');
    if (!reason) return;
    setActionLoading(employerId);
    try {
      const functions = getFunctions();
      const approve = httpsCallable(functions, 'approveEmployer');
      await approve({ employerId, decision: 'rejected', rejectionReason: reason });
    } catch (e) {
      console.error('Reject failed:', e);
      alert('Error: ' + (e as Error).message);
    }
    setActionLoading(null);
  };

  const handleLoanDecision = async (loanId: string, decision: 'approved' | 'rejected') => {
    if (decision === 'rejected') {
      const note = prompt('Rejection note:');
      if (!note) return;
      setActionLoading(loanId);
      try {
        const functions = getFunctions();
        const submit = httpsCallable(functions, 'submitReviewDecision');
        await submit({ loanId, decision, note });
      } catch (e) { alert('Error: ' + (e as Error).message); }
      setActionLoading(null);
      return;
    }
    setActionLoading(loanId);
    try {
      const functions = getFunctions();
      const submit = httpsCallable(functions, 'submitReviewDecision');
      await submit({ loanId, decision });
    } catch (e) { alert('Error: ' + (e as Error).message); }
    setActionLoading(null);
  };

  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const pendingEmployers = employers.filter(e => e.status === 'pending_verification' || e.status === 'pending_review');
  const activeEmployers = employers.filter(e => e.status === 'active');
  const pendingLoans = loans.filter(l => l.status === 'pending');

  const tabStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 12, fontWeight: active ? 700 : 500,
    color: active ? '#194445' : '#93aaa9',
    textDecoration: 'none', padding: '14px 0',
    borderBottom: active ? '2px solid #a28657' : '2px solid transparent',
    letterSpacing: '0.5px', textTransform: 'uppercase',
    background: 'none', border: 'none', cursor: 'pointer',
  });

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '48px 0 64px' }}>
      <h1 style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 26, color: '#0c1e1f', fontWeight: 400, letterSpacing: '-0.02em', marginBottom: 32 }}>
        Operations Dashboard
      </h1>

      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Employers</div>
          <div className="stat-value">{stats.totalEmployers || employers.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Employees</div>
          <div className="stat-value">{stats.totalEmployees}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active Loans</div>
          <div className="stat-value">{stats.activeLoans || loans.filter(l => l.status === 'active').length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Disbursed</div>
          <div className="stat-value">${fmt(stats.totalDisbursed)}</div>
          <div className="stat-change">MXN</div>
        </div>
      </div>

      {/* Tab navigation */}
      <div style={{ display: 'flex', gap: 32, borderBottom: '1px solid rgba(25,68,69,0.04)', marginBottom: 24 }}>
        <button onClick={() => setTab('employers')} style={tabStyle(tab === 'employers')}>
          Employers {pendingEmployers.length > 0 && `(${pendingEmployers.length})`}
        </button>
        <button onClick={() => setTab('loans')} style={tabStyle(tab === 'loans')}>
          Loans {pendingLoans.length > 0 && `(${pendingLoans.length})`}
        </button>
      </div>

      {tab === 'employers' && (
        <div>
          {/* Pending employers */}
          {pendingEmployers.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '2.2px', color: '#a28657', marginBottom: 16 }}>
                Pending Review ({pendingEmployers.length})
              </div>
              {pendingEmployers.map(emp => (
                <div key={emp.id} style={{ background: '#fff', borderRadius: 16, padding: '24px', border: '1px solid rgba(25,68,69,0.04)', marginBottom: 12, boxShadow: '0 1px 4px rgba(25,68,69,0.02)' }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: '#0c1e1f', marginBottom: 4 }}>{emp.companyName}</div>
                  <div style={{ fontSize: 12, color: '#93aaa9', marginBottom: 4 }}>{emp.email}</div>
                  <div style={{ fontSize: 11, color: '#93aaa9', marginBottom: 16 }}>
                    Code: {emp.employerCode} · Docs: {emp.docRFC ? '✓' : '✗'}
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      disabled={actionLoading === emp.id}
                      onClick={() => handleApproveEmployer(emp.id)}
                      style={{ flex: 1, background: '#194445', color: '#fff', borderRadius: 60, padding: '12px', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', opacity: actionLoading === emp.id ? 0.5 : 1 }}
                    >
                      {actionLoading === emp.id ? '...' : 'Approve'}
                    </button>
                    <button
                      disabled={actionLoading === emp.id}
                      onClick={() => handleRejectEmployer(emp.id)}
                      style={{ flex: 1, background: 'none', color: '#dc503c', borderRadius: 60, padding: '12px', fontSize: 13, fontWeight: 600, border: '1px solid rgba(220,80,60,0.2)', cursor: 'pointer' }}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Active employers */}
          {activeEmployers.length > 0 && (
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '2.2px', color: '#93aaa9', marginBottom: 16 }}>
                Active ({activeEmployers.length})
              </div>
              {activeEmployers.map(emp => (
                <div key={emp.id} style={{ background: '#fff', borderRadius: 16, padding: '20px 24px', border: '1px solid rgba(25,68,69,0.04)', marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: '#0c1e1f' }}>{emp.companyName}</div>
                  <div style={{ fontSize: 12, color: '#93aaa9' }}>{emp.email} · {emp.employerCode}</div>
                </div>
              ))}
            </div>
          )}
          {loading && <div style={{ textAlign: 'center', padding: 40, color: '#93aaa9' }}>Loading...</div>}
          {!loading && employers.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#93aaa9' }}>No employers registered yet.</div>}
        </div>
      )}

      {tab === 'loans' && (
        <div>
          {pendingLoans.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '2.2px', color: '#a28657', marginBottom: 16 }}>
                Pending Review ({pendingLoans.length})
              </div>
              {pendingLoans.map(loan => (
                <div key={loan.id} style={{ background: '#fff', borderRadius: 16, padding: '24px', border: '1px solid rgba(25,68,69,0.04)', marginBottom: 12, boxShadow: '0 1px 4px rgba(25,68,69,0.02)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 15, color: '#0c1e1f', marginBottom: 4 }}>{loan.employeeName}</div>
                      <div style={{ fontSize: 12, color: '#93aaa9' }}>{loan.employerName}</div>
                    </div>
                    <div style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 22, color: '#0c1e1f' }}>
                      ${fmt(loan.amount)}
                    </div>
                  </div>
                  {loan.mlCreditScore != null && (
                    <div style={{ fontSize: 11, color: '#93aaa9', marginBottom: 16 }}>
                      ML Score: {loan.mlCreditScore} · Default Prob: {((loan.mlDefaultProb || 0) * 100).toFixed(0)}%
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      disabled={actionLoading === loan.id}
                      onClick={() => handleLoanDecision(loan.id, 'approved')}
                      style={{ flex: 1, background: '#194445', color: '#fff', borderRadius: 60, padding: '12px', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', opacity: actionLoading === loan.id ? 0.5 : 1 }}
                    >
                      {actionLoading === loan.id ? '...' : 'Approve Loan'}
                    </button>
                    <button
                      disabled={actionLoading === loan.id}
                      onClick={() => handleLoanDecision(loan.id, 'rejected')}
                      style={{ flex: 1, background: 'none', color: '#dc503c', borderRadius: 60, padding: '12px', fontSize: 13, fontWeight: 600, border: '1px solid rgba(220,80,60,0.2)', cursor: 'pointer' }}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {loans.filter(l => l.status !== 'pending').length > 0 && (
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '2.2px', color: '#93aaa9', marginBottom: 16 }}>
                All Loans ({loans.filter(l => l.status !== 'pending').length})
              </div>
              {loans.filter(l => l.status !== 'pending').map(loan => (
                <div key={loan.id} style={{ background: '#fff', borderRadius: 16, padding: '20px 24px', border: '1px solid rgba(25,68,69,0.04)', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: '#0c1e1f' }}>{loan.employeeName}</div>
                    <div style={{ fontSize: 12, color: '#93aaa9' }}>{loan.employerName} · ${fmt(loan.amount)}</div>
                  </div>
                  <span className={`badge badge-${loan.status}`}>{loan.status}</span>
                </div>
              ))}
            </div>
          )}
          {loans.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#93aaa9' }}>No loan applications yet.</div>}
        </div>
      )}
    </div>
  );
}
