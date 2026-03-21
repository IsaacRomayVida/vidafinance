import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import { db, functions } from '../lib/firebase';
import {
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  increment,
  type DocumentData,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

interface EmployerData {
  name: string;
  companyName: string;
  email: string;
  employerCode: string;
  status: string;
  totalEmployees: number;
  activeLoans: number;
  totalDisbursed: number;
}

interface Loan {
  id: string;
  employeeName: string;
  amount: number;
  repaymentAmount: number;
  termDays: number;
  status: string;
  createdAt: Date | null;
  contractUrl?: string;
  receiptUrl?: string;
  employeeId: string;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function statusBadgeClass(status: string): string {
  return `badge badge-${status}`;
}

const TABS = ['all', 'pending', 'approved', 'active', 'paid', 'rejected'] as const;

export function EmployerDashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [empData, setEmpData] = useState<EmployerData | null>(null);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [toast, setToast] = useState('');
  const [dashStats, setDashStats] = useState<Record<string, number>>({});

  // Load employer data
  useEffect(() => {
    if (!user) return;
    const loadEmployer = async () => {
      const snap = await getDoc(doc(db, 'employers', user.uid));
      if (snap.exists()) {
        const d = snap.data();
        setEmpData({
          name: d.name,
          companyName: d.companyName,
          email: d.email,
          employerCode: d.employerCode || '',
          status: d.status || 'pending_verification',
          totalEmployees: d.totalEmployees || 0,
          activeLoans: d.activeLoans || 0,
          totalDisbursed: d.totalDisbursed || 0,
        });
      }
      setLoading(false);
    };
    loadEmployer();
  }, [user]);

  // Try to get dashboard stats from Cloud Function
  useEffect(() => {
    if (!user) return;
    const fetchStats = async () => {
      try {
        const fn = httpsCallable(functions, 'getEmployerDashboard');
        const result = await fn({});
        const data = result.data as Record<string, number>;
        setDashStats(data);
      } catch {
        // Cloud function may not exist yet, use Firestore data
      }
    };
    fetchStats();
  }, [user]);

  // Real-time loan listener
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'loans'),
      where('employerId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );
    const unsub = onSnapshot(q, (snap) => {
      const loanList: Loan[] = snap.docs.map((d) => {
        const data = d.data() as DocumentData;
        return {
          id: d.id,
          employeeName: data.employeeName || data.applicantName || 'Unknown',
          amount: data.amount || 0,
          repaymentAmount: data.repaymentAmount || data.totalRepaymentAmount || data.total || 0,
          termDays: data.termDays || 30,
          status: data.status || 'pending',
          createdAt: data.createdAt?.toDate?.() || null,
          contractUrl: data.contractUrl,
          receiptUrl: data.receiptUrl,
          employeeId: data.employeeId || data.userId || '',
        };
      });
      setLoans(loanList);
    });
    return unsub;
  }, [user]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const approveLoan = async (loan: Loan) => {
    try {
      await updateDoc(doc(db, 'loans', loan.id), { status: 'approved' });
      showToast(t('toast_loan_approved'));
    } catch {
      showToast('Error approving loan');
    }
  };

  const rejectLoan = async (loan: Loan) => {
    try {
      await updateDoc(doc(db, 'loans', loan.id), { status: 'rejected' });
      // Return credit to employee
      if (loan.employeeId) {
        await updateDoc(doc(db, 'employees', loan.employeeId), {
          availableCredit: increment(loan.amount),
        });
      }
      showToast(t('toast_loan_rejected'));
    } catch {
      showToast('Error rejecting loan');
    }
  };

  const filteredLoans = activeTab === 'all' ? loans : loans.filter((l) => l.status === activeTab);
  const pendingCount = loans.filter((l) => l.status === 'pending').length;
  const activeCount = loans.filter((l) => l.status === 'active').length;

  const totalEmployees = dashStats.totalEmployees ?? empData?.totalEmployees ?? 0;
  const totalDisbursed = dashStats.totalDisbursed ?? empData?.totalDisbursed ?? 0;

  if (loading) {
    return (
      <div className="dash-content" style={{ textAlign: 'center', paddingTop: 100 }}>
        <div className="spinner" />
      </div>
    );
  }

  // Pending verification screen
  if (empData?.status === 'pending_verification') {
    return (
      <>
        <div className="dash-header">
          <h1>{empData.companyName}</h1>
        </div>
        <div className="dash-content" style={{ textAlign: 'center', paddingTop: 60 }}>
          <div className="onb-check-circle" style={{ margin: '0 auto 24px' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 32, height: 32 }}>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <h2 style={{ fontFamily: 'var(--df)', fontSize: 32, color: 'var(--t1)', marginBottom: 12 }}>
            {t('dash_verification_pending')}
          </h2>
          <p style={{ color: 'var(--t3)', fontSize: 15, maxWidth: 400, margin: '0 auto' }}>
            {t('dash_verification_sub')}
          </p>
          <div className="onb-approved-tag" style={{ margin: '32px auto' }}>
            <span className="onb-approved-dot" style={{ background: 'var(--gold)', boxShadow: '0 0 8px rgba(201,168,76,0.4)' }} />
            {t('onb_e_step6_badge')}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="dash-header">
        <h1>{empData?.companyName || t('dash_dashboard')}</h1>
        <div className="dash-user">
          <span>{empData?.name}</span>
          <div className="dash-avatar">{(empData?.name || '?')[0].toUpperCase()}</div>
        </div>
      </div>
      <div className="dash-content">
        {/* Employer Code */}
        {empData?.employerCode && (
          <div style={{ marginBottom: 24, padding: '16px 24px', background: 'var(--bg2)', borderRadius: 12, display: 'inline-flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('dash_employer_code')}</span>
            <span style={{ fontFamily: 'var(--db)', fontSize: 22, fontWeight: 700, letterSpacing: 6, color: 'var(--t1)' }}>
              {empData.employerCode}
            </span>
          </div>
        )}

        {/* Stat cards */}
        <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <div className="stat-card">
            <div className="stat-label">{t('dash_total_employees')}</div>
            <div className="stat-value">{totalEmployees}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t('dash_active_loans')}</div>
            <div className="stat-value">{activeCount}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t('dash_pending_requests')}</div>
            <div className="stat-value">{pendingCount}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t('dash_total_disbursed')}</div>
            <div className="stat-value">${fmt(totalDisbursed)}</div>
          </div>
        </div>

        {/* Loans table */}
        <div className="card" style={{ marginTop: 32 }}>
          <h2 className="card-title">{t('dash_recent_loans')}</h2>

          {/* Tabs */}
          <div className="dash-tabs" style={{ display: 'flex', gap: 0, borderBottom: '1px solid rgba(25,68,69,0.06)', marginBottom: 20 }}>
            {TABS.map((tab) => (
              <button
                key={tab}
                className={`dash-tab-btn ${activeTab === tab ? 'dash-tab-active' : ''}`}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  background: 'none',
                  color: activeTab === tab ? 'var(--t1)' : 'var(--t3)',
                  borderBottom: activeTab === tab ? '2px solid var(--brand)' : '2px solid transparent',
                  marginBottom: -1,
                  cursor: 'pointer',
                  fontFamily: 'var(--db)',
                }}
              >
                {t(`tab_${tab}`)}
              </button>
            ))}
          </div>

          {filteredLoans.length === 0 ? (
            <div className="empty-state">
              <p>{t('dash_no_loans_employer')}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th>{t('dash_th_employee')}</th>
                    <th>{t('dash_th_amount')}</th>
                    <th>{t('dash_th_term')}</th>
                    <th>{t('dash_th_status')}</th>
                    <th>{t('dash_th_docs')}</th>
                    <th>{t('dash_th_action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLoans.map((loan) => (
                    <tr key={loan.id}>
                      <td>{loan.employeeName}</td>
                      <td>${fmt(loan.amount)}</td>
                      <td>
                        {loan.termDays} {t('dash_days')}
                      </td>
                      <td>
                        <span className={statusBadgeClass(loan.status)}>
                          {t(`status_${loan.status}`, loan.status)}
                        </span>
                      </td>
                      <td>
                        {loan.contractUrl && (
                          <a href={loan.contractUrl} target="_blank" rel="noopener noreferrer" className="doc-link">
                            {t('dash_doc_contract')}
                          </a>
                        )}
                      </td>
                      <td>
                        {loan.status === 'pending' && (
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn-sm btn-approve" onClick={() => approveLoan(loan)}>
                              {t('dash_approve')}
                            </button>
                            <button className="btn-sm btn-reject" onClick={() => rejectLoan(loan)}>
                              {t('dash_reject')}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="toast show" style={{ position: 'fixed', bottom: 24, right: 24, background: 'var(--brand)', color: '#fff', padding: '12px 24px', borderRadius: 10, fontSize: 14, zIndex: 2000 }}>
          {toast}
        </div>
      )}
    </>
  );
}
