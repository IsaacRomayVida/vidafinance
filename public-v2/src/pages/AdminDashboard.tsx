import { useState, useEffect } from 'react';
import { collection, query, where, orderBy, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

interface Employer {
  id: string;
  companyName: string;
  email: string;
  status: string;
  employerCode: string;
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
  createdAt?: { seconds: number };
  mlCreditScore?: number;
  mlDefaultProb?: number;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function AdminDashboard() {
  const { user } = useAuth();
  const [employers, setEmployers] = useState<Employer[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [tab, setTab] = useState<'employers' | 'loans'>('employers');

  // Real-time employers listener
  useEffect(() => {
    const q = query(collection(db, 'employers'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      setEmployers(snap.docs.map(d => ({ id: d.id, ...d.data() } as Employer)));
      setLoading(false);
    });
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

  const approveEmployer = async (employerId: string) => {
    setActionLoading(employerId);
    try {
      const fn = httpsCallable(getFunctions(), 'approveEmployer');
      await fn({ employerId, decision: 'approved' });
    } catch (e: unknown) {
      console.error('Approve failed:', e);
      alert('Error: ' + (e as Error).message);
    }
    setActionLoading(null);
  };

  const rejectEmployer = async (employerId: string) => {
    setActionLoading(employerId);
    try {
      const fn = httpsCallable(getFunctions(), 'approveEmployer');
      await fn({ employerId, decision: 'rejected', rejectionReason: 'Rejected by admin' });
    } catch (e: unknown) {
      console.error('Reject failed:', e);
      alert('Error: ' + (e as Error).message);
    }
    setActionLoading(null);
  };

  const approveLoan = async (loanId: string) => {
    setActionLoading(loanId);
    try {
      const fn = httpsCallable(getFunctions(), 'submitReviewDecision');
      await fn({ loanId, decision: 'approved' });
    } catch (e: unknown) {
      console.error('Approve loan failed:', e);
      alert('Error: ' + (e as Error).message);
    }
    setActionLoading(null);
  };

  const rejectLoan = async (loanId: string) => {
    setActionLoading(loanId);
    try {
      const fn = httpsCallable(getFunctions(), 'submitReviewDecision');
      await fn({ loanId, decision: 'rejected', reason: 'Rejected by admin' });
    } catch (e: unknown) {
      console.error('Reject loan failed:', e);
      alert('Error: ' + (e as Error).message);
    }
    setActionLoading(null);
  };

  const pendingEmployers = employers.filter(e => e.status === 'pending_verification' || e.status === 'pending_review');
  const activeEmployers = employers.filter(e => e.status === 'active');
  const pendingLoans = loans.filter(l => l.status === 'pending');
  const activeLoans = loans.filter(l => l.status === 'active' || l.status === 'approved' || l.status === 'disbursement_queued');

  const tabStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    color: active ? '#fff' : 'rgba(168,213,208,0.4)',
    textDecoration: 'none',
    padding: '14px 0',
    borderBottom: active ? '2px solid #a28657' : '2px solid transparent',
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
  });

  return (
    <div style={{ maxWidth: 700, margin: '0 auto' }}>
      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Employers</div>
          <div className="stat-value">{employers.length}</div>
          <div className="stat-change">{pendingEmployers.length} pending</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Loans</div>
          <div className="stat-value">{loans.length}</div>
          <div className="stat-change">{pendingLoans.length} pending</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active</div>
          <div className="stat-value">{activeLoans.length}</div>
          <div className="stat-change">${fmt(activeLoans.reduce((s, l) => s + l.amount, 0))} MXN</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 32, marginBottom: 24, borderBottom: '1px solid rgba(25,68,69,0.06)' }}>
        <button onClick={() => setTab('employers')} style={tabStyle(tab === 'employers')}>
          Employers ({pendingEmployers.length} pending)
        </button>
        <button onClick={() => setTab('loans')} style={tabStyle(tab === 'loans')}>
          Loans ({pendingLoans.length} pending)
        </button>
      </div>

      {/* Employer List */}
      {tab === 'employers' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#93aaa9' }}>Loading...</div>
          ) : employers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#93aaa9' }}>No employers yet</div>
          ) : (
            employers.map(emp => (
              <div key={emp.id} style={{
                background: '#fff', borderRadius: 20, padding: '24px 24px',
                border: '1px solid rgba(25,68,69,0.04)', boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: '#0c1e1f', marginBottom: 4 }}>
                      {emp.companyName || 'Unnamed'}
                    </div>
                    <div style={{ fontSize: 12, color: '#93aaa9' }}>{emp.email}</div>
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '4px 12px', borderRadius: 20,
                    letterSpacing: '0.5px', textTransform: 'uppercase',
                    background: emp.status === 'active' ? 'rgba(36,122,110,0.08)' : emp.status === 'rejected' ? 'rgba(220,80,60,0.08)' : 'rgba(162,134,87,0.08)',
                    color: emp.status === 'active' ? '#247a6e' : emp.status === 'rejected' ? '#dc503c' : '#a28657',
                  }}>
                    {emp.status}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#4a6364', marginBottom: 16 }}>
                  Code: <strong>{emp.employerCode}</strong> · Size: {emp.companySize || '—'} · Docs: {emp.docRFC ? '✓' : '—'}
                </div>
                {(emp.status === 'pending_verification' || emp.status === 'pending_review') && (
                  <div style={{ display: 'flex', gap: 12 }}>
                    <button
                      onClick={() => approveEmployer(emp.id)}
                      disabled={actionLoading === emp.id}
                      style={{
                        flex: 1, background: '#194445', color: '#fff', borderRadius: 60,
                        padding: '12px 20px', fontSize: 13, fontWeight: 600, border: 'none',
                        cursor: 'pointer', opacity: actionLoading === emp.id ? 0.5 : 1,
                      }}
                    >
                      {actionLoading === emp.id ? 'Processing...' : 'Approve'}
                    </button>
                    <button
                      onClick={() => rejectEmployer(emp.id)}
                      disabled={actionLoading === emp.id}
                      style={{
                        flex: 1, background: 'rgba(220,80,60,0.06)', color: '#dc503c', borderRadius: 60,
                        padding: '12px 20px', fontSize: 13, fontWeight: 600, border: 'none',
                        cursor: 'pointer', opacity: actionLoading === emp.id ? 0.5 : 1,
                      }}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Loan List */}
      {tab === 'loans' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {loans.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#93aaa9' }}>No loans yet</div>
          ) : (
            loans.map(loan => (
              <div key={loan.id} style={{
                background: '#fff', borderRadius: 20, padding: '24px 24px',
                border: '1px solid rgba(25,68,69,0.04)', boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: '#0c1e1f', marginBottom: 4 }}>
                      {loan.employeeName || 'Unknown'}
                    </div>
                    <div style={{ fontSize: 12, color: '#93aaa9' }}>{loan.employerName}</div>
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '4px 12px', borderRadius: 20,
                    letterSpacing: '0.5px', textTransform: 'uppercase',
                    background: loan.status === 'active' ? 'rgba(36,122,110,0.08)' : loan.status === 'rejected' ? 'rgba(220,80,60,0.08)' : loan.status === 'paid' ? 'rgba(36,122,110,0.08)' : 'rgba(162,134,87,0.08)',
                    color: loan.status === 'active' ? '#247a6e' : loan.status === 'rejected' ? '#dc503c' : loan.status === 'paid' ? '#1a5e3a' : '#a28657',
                  }}>
                    {loan.status}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 24, fontSize: 12, color: '#4a6364', marginBottom: loan.status === 'pending' ? 16 : 0 }}>
                  <span>Amount: <strong>${fmt(loan.amount)}</strong></span>
                  <span>Total: <strong>${fmt(loan.total)}</strong></span>
                  {loan.mlCreditScore && <span>Score: <strong>{loan.mlCreditScore}</strong></span>}
                </div>
                {loan.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 12 }}>
                    <button
                      onClick={() => approveLoan(loan.id)}
                      disabled={actionLoading === loan.id}
                      style={{
                        flex: 1, background: '#194445', color: '#fff', borderRadius: 60,
                        padding: '12px 20px', fontSize: 13, fontWeight: 600, border: 'none',
                        cursor: 'pointer', opacity: actionLoading === loan.id ? 0.5 : 1,
                      }}
                    >
                      {actionLoading === loan.id ? 'Processing...' : 'Approve Loan'}
                    </button>
                    <button
                      onClick={() => rejectLoan(loan.id)}
                      disabled={actionLoading === loan.id}
                      style={{
                        flex: 1, background: 'rgba(220,80,60,0.06)', color: '#dc503c', borderRadius: 60,
                        padding: '12px 20px', fontSize: 13, fontWeight: 600, border: 'none',
                        cursor: 'pointer', opacity: actionLoading === loan.id ? 0.5 : 1,
                      }}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
