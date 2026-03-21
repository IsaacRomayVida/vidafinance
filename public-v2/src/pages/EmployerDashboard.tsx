import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc, collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';
import { signOut } from 'firebase/auth';

interface Loan {
  id: string;
  employeeName?: string;
  amount: number;
  termDays?: number;
  repaymentAmount?: number;
  status: string;
  createdAt?: { seconds: number };
  [key: string]: unknown;
}

interface EmployerData {
  companyName?: string;
  name?: string;
  email?: string;
  employerCode?: string;
  status?: string;
  totalEmployees?: number;
}

interface DashStats {
  totalEmployees?: number;
  activeLoans?: number;
  overdueCount?: number;
  totalDisbursed?: number;
  adoptionRate?: string;
  outstandingBalance?: number;
}

type TabKey = 'all' | 'pending' | 'approved' | 'active' | 'paid' | 'rejected';

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function EmployerDashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [employer, setEmployer] = useState<EmployerData | null>(null);
  const [stats, setStats] = useState<DashStats>({});
  const [loans, setLoans] = useState<Loan[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [loading, setLoading] = useState(true);
  const [pageState, setPageState] = useState<'loading' | 'verify_email' | 'pending_verification' | 'dashboard'>('loading');

  // Fetch employer doc and dashboard stats
  useEffect(() => {
    if (!user) return;

    if (!user.emailVerified) {
      setPageState('verify_email');
      return;
    }

    const uid = user.uid;

    (async () => {
      const empDoc = await getDoc(doc(db, 'employers', uid));
      if (!empDoc.exists()) {
        navigate('/employee', { replace: true });
        return;
      }
      const emp = empDoc.data() as EmployerData;
      setEmployer(emp);

      if (emp.status === 'pending_verification') {
        setPageState('pending_verification');
        return;
      }
      if (emp.status && emp.status !== 'active' && emp.status !== 'pending_verification') {
        navigate('/', { replace: true });
        return;
      }

      // Fetch stats from Cloud Function
      try {
        const functions = getFunctions();
        const getEmployerDashboard = httpsCallable<unknown, { stats: DashStats }>(functions, 'getEmployerDashboard');
        const result = await getEmployerDashboard({});
        setStats(result.data.stats || {});
      } catch {
        // fallback - stats will be computed from loans
      }

      setPageState('dashboard');
      setLoading(false);
    })();
  }, [user, navigate]);

  // Real-time loans listener
  useEffect(() => {
    if (!user || pageState !== 'dashboard') return;

    const q = query(
      collection(db, 'loans'),
      where('employerId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsub = onSnapshot(q, (snap) => {
      const loanData = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan));
      setLoans(loanData);
      setLoading(false);
    });

    return unsub;
  }, [user, pageState]);

  if (pageState === 'loading') {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
      </div>
    );
  }

  if (pageState === 'verify_email') {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h2 className="text-xl font-bold text-teal-900">{t('dash_verify_email')}</h2>
        <p className="mt-4 text-sm text-gray-500">{t('dash_verify_email_desc')}</p>
        <button
          onClick={() => signOut(auth).then(() => navigate('/login'))}
          className="mt-6 rounded-lg bg-teal-700 px-6 py-2 text-sm font-medium text-white hover:bg-teal-800"
        >
          {t('dash_back_to_login')}
        </button>
      </div>
    );
  }

  if (pageState === 'pending_verification') {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-50">
          <svg viewBox="0 0 24 24" fill="none" stroke="#c9a84c" strokeWidth="2" className="h-8 w-8">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-teal-900">{t('dash_account_created')}</h2>
        <p className="mt-4 text-sm text-gray-500">{t('dash_pending_verification')}</p>
        <button
          onClick={() => signOut(auth).then(() => navigate('/'))}
          className="mt-6 rounded-lg bg-teal-700 px-6 py-2 text-sm font-medium text-white hover:bg-teal-800"
        >
          {t('dash_back_to_login')}
        </button>
      </div>
    );
  }

  // Compute stats from loans if Cloud Function didn't return them
  const pendingCount = loans.filter((l) => l.status === 'pending').length;
  const activeCount = stats.activeLoans ?? loans.filter((l) => l.status === 'approved' || l.status === 'active').length;
  const totalDisbursed = stats.totalDisbursed ?? loans.filter((l) => l.status !== 'rejected' && l.status !== 'pending').reduce((s, l) => s + l.amount, 0);
  const totalEmployees = stats.totalEmployees ?? employer?.totalEmployees ?? 0;

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'all', label: t('dash_tab_all') },
    { key: 'pending', label: t('dash_tab_pending') },
    { key: 'approved', label: t('dash_tab_approved') },
    { key: 'active', label: t('dash_tab_active') },
    { key: 'paid', label: t('dash_tab_paid') },
    { key: 'rejected', label: t('dash_tab_rejected') },
  ];

  const filteredLoans = (() => {
    if (activeTab === 'all') return loans;
    if (activeTab === 'approved') return loans.filter((l) => l.status === 'approved' || l.status === 'disbursement_queued');
    return loans.filter((l) => l.status === activeTab);
  })();

  function tabCount(key: TabKey): number {
    if (key === 'all') return loans.length;
    if (key === 'approved') return loans.filter((l) => l.status === 'approved' || l.status === 'disbursement_queued').length;
    return loans.filter((l) => l.status === key).length;
  }

  return (
    <div>
      {/* Header */}
      <div className="dash-header">
        <h1>{employer?.companyName}</h1>
        <div className="dash-user">
          <span>
            {t('dash_employer_code')}: <strong>{employer?.employerCode}</strong>
          </span>
          <div className="dash-avatar">
            {employer?.name?.charAt(0) || 'E'}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="dash-content">
        {/* Stats Grid */}
        <div className="stat-grid">
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
            <div className="stat-change">MXN</div>
          </div>
        </div>

        {/* Loans Table */}
        <div className="card">
          <div className="card-title">{t('dash_recent_loans')}</div>

          {/* Tabs */}
          <div className="dash-tabs" style={{ display: 'flex', gap: 0, borderBottom: '1px solid rgba(25,68,69,0.08)', marginBottom: 20 }}>
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`dash-tab-btn${activeTab === tab.key ? ' dash-tab-active' : ''}`}
                style={{
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: activeTab === tab.key ? 700 : 500,
                  color: activeTab === tab.key ? 'var(--brand)' : 'var(--t3)',
                  background: 'none',
                  border: 'none',
                  borderBottom: activeTab === tab.key ? '2px solid var(--brand)' : '2px solid transparent',
                  cursor: 'pointer',
                  transition: 'all .2s',
                }}
              >
                {tab.label} ({tabCount(tab.key)})
              </button>
            ))}
          </div>

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <span className="spinner" style={{ borderColor: 'rgba(25,68,69,0.1)', borderTopColor: 'var(--brand)' }} />
            </div>
          ) : filteredLoans.length === 0 ? (
            <div className="empty-state">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
              <p>
                {t('dash_no_loans_employer')} <strong>{employer?.employerCode}</strong> {t('dash_no_loans_employer_2')}
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('dash_th_employee')}</th>
                    <th>{t('dash_th_amount')}</th>
                    <th>{t('dash_th_term')}</th>
                    <th>{t('dash_th_status')}</th>
                    <th>{t('dash_th_date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLoans.map((loan) => (
                    <tr key={loan.id}>
                      <td style={{ fontWeight: 500 }}>{loan.employeeName || '—'}</td>
                      <td>${fmt(loan.amount)}</td>
                      <td>{loan.termDays ?? 30} {t('dash_days')}</td>
                      <td>
                        <span className={`badge badge-${loan.status}`}>
                          {t(`status_${loan.status}`)}
                        </span>
                      </td>
                      <td>
                        {loan.createdAt ? new Date(loan.createdAt.seconds * 1000).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
