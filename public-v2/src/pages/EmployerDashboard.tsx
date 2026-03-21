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

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-blue-100 text-blue-800',
  disbursement_queued: 'bg-blue-100 text-blue-800',
  active: 'bg-green-100 text-green-800',
  overdue: 'bg-red-100 text-red-800',
  paid: 'bg-gray-100 text-gray-600',
  rejected: 'bg-red-100 text-red-800',
};

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
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-teal-900">{employer?.companyName}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {t('dash_employer_code')}: <span className="font-semibold text-teal-800">{employer?.employerCode}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-100 text-sm font-bold text-teal-800">
            {employer?.name?.charAt(0) || 'E'}
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t('dash_total_employees')} value={String(totalEmployees)} />
        <StatCard label={t('dash_active_loans')} value={String(activeCount)} />
        <StatCard label={t('dash_pending_requests')} value={String(pendingCount)} />
        <StatCard label={t('dash_total_disbursed')} value={`$${fmt(totalDisbursed)}`} sub="MXN" />
      </div>

      {/* Loans Table */}
      <div className="mt-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-teal-900">{t('dash_recent_loans')}</h2>

        {/* Tabs */}
        <div className="mb-4 flex gap-0 overflow-x-auto border-b border-gray-100">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'border-teal-700 text-teal-900'
                  : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              {tab.label} ({tabCount(tab.key)})
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
          </div>
        ) : filteredLoans.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">
            <svg className="mx-auto mb-3 h-12 w-12 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <p>
              {t('dash_no_loans_employer')} <strong>{employer?.employerCode}</strong> {t('dash_no_loans_employer_2')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs font-medium uppercase text-gray-400">
                  <th className="py-3 pr-4">{t('dash_th_employee')}</th>
                  <th className="py-3 pr-4">{t('dash_th_amount')}</th>
                  <th className="py-3 pr-4">{t('dash_th_term')}</th>
                  <th className="py-3 pr-4">{t('dash_th_status')}</th>
                  <th className="py-3 pr-4">{t('dash_th_date')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredLoans.map((loan) => (
                  <tr key={loan.id} className="border-b border-gray-50">
                    <td className="py-3 pr-4 font-medium text-teal-900">{loan.employeeName || '—'}</td>
                    <td className="py-3 pr-4">${fmt(loan.amount)}</td>
                    <td className="py-3 pr-4">{loan.termDays ?? 30} {t('dash_days')}</td>
                    <td className="py-3 pr-4">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[loan.status] || 'bg-gray-100 text-gray-600'}`}>
                        {t(`status_${loan.status}`)}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-gray-500">
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
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-teal-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}
