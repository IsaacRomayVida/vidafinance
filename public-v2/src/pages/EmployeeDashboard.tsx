import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc, collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { signOut } from 'firebase/auth';
import { auth, db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

interface EmployeeData {
  name?: string;
  email?: string;
  employerName?: string;
  creditLimit: number;
  availableCredit: number;
}

interface Loan {
  id: string;
  amount: number;
  termDays?: number;
  repaymentAmount?: number;
  total?: number;
  status: string;
  createdAt?: { seconds: number };
  dueDate?: { seconds: number };
  [key: string]: unknown;
}

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

export function EmployeeDashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [employee, setEmployee] = useState<EmployeeData | null>(null);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [pageState, setPageState] = useState<'loading' | 'verify_email' | 'dashboard'>('loading');

  // Fetch employee doc
  useEffect(() => {
    if (!user) return;

    if (!user.emailVerified) {
      setPageState('verify_email');
      return;
    }

    const uid = user.uid;

    (async () => {
      const empDoc = await getDoc(doc(db, 'employees', uid));
      if (!empDoc.exists()) {
        navigate('/employer', { replace: true });
        return;
      }
      setEmployee(empDoc.data() as EmployeeData);
      setPageState('dashboard');
    })();
  }, [user, navigate]);

  // Real-time loans listener
  useEffect(() => {
    if (!user || pageState !== 'dashboard') return;

    const q = query(
      collection(db, 'loans'),
      where('employeeId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsub = onSnapshot(q, (snap) => {
      setLoans(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan)));
      setLoading(false);
    });

    return unsub;
  }, [user, pageState]);

  const handleLoanSubmitted = useCallback(() => {
    setShowModal(false);
    // Employee data will refresh via Firestore listener on next fetch
    if (user) {
      getDoc(doc(db, 'employees', user.uid)).then((snap) => {
        if (snap.exists()) setEmployee(snap.data() as EmployeeData);
      });
    }
  }, [user]);

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

  if (!employee) return null;

  const utilized = employee.creditLimit - employee.availableCredit;
  const utilPct = employee.creditLimit > 0 ? Math.round((utilized / employee.creditLimit) * 100) : 0;

  // Find next repayment from active loans
  const activeLoans = loans.filter((l) => l.status === 'active' || l.status === 'overdue');
  const nextRepayment = activeLoans
    .filter((l) => l.dueDate)
    .sort((a, b) => (a.dueDate!.seconds - b.dueDate!.seconds))
    [0];

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-teal-900">
            {t('dash_welcome')}, {employee.name || user?.displayName || user?.email}
          </h1>
          {employee.employerName && (
            <p className="mt-1 text-sm text-gray-500">{employee.employerName}</p>
          )}
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-100 text-sm font-bold text-teal-800">
          {employee.name?.charAt(0) || 'E'}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_available_credit')}</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">${fmt(employee.availableCredit)}</p>
          <p className="mt-0.5 text-xs text-gray-400">MXN</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_credit_limit')}</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">${fmt(employee.creditLimit)}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_utilization')}</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">{utilPct}%</p>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-teal-600 transition-all"
              style={{ width: `${Math.min(utilPct, 100)}%` }}
            />
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">{t('dash_quick_action')}</p>
          <button
            onClick={() => setShowModal(true)}
            disabled={employee.availableCredit < 500}
            className="mt-2 w-full rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {t('dash_request_funds')}
          </button>
        </div>
      </div>

      {/* Next Repayment */}
      {nextRepayment && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-amber-800">{t('modal_due_date')}</p>
              <p className="text-lg font-bold text-amber-900">
                {new Date(nextRepayment.dueDate!.seconds * 1000).toLocaleDateString()}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm font-medium text-amber-800">{t('dash_th_repayment')}</p>
              <p className="text-lg font-bold text-amber-900">
                ${fmt(nextRepayment.repaymentAmount || nextRepayment.total || 0)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Loans Table */}
      <div className="mt-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-teal-900">{t('dash_your_loans')}</h2>

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
          </div>
        ) : loans.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">
            <svg className="mx-auto mb-3 h-12 w-12 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            <p>{t('dash_no_loans_employee')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs font-medium uppercase text-gray-400">
                  <th className="py-3 pr-4">{t('dash_th_amount')}</th>
                  <th className="py-3 pr-4">{t('dash_th_term')}</th>
                  <th className="py-3 pr-4">{t('dash_th_repayment')}</th>
                  <th className="py-3 pr-4">{t('dash_th_status')}</th>
                  <th className="py-3 pr-4">{t('dash_th_date')}</th>
                  <th className="py-3 pr-4">{t('dash_th_action')}</th>
                </tr>
              </thead>
              <tbody>
                {loans.map((loan) => (
                  <tr key={loan.id} className="border-b border-gray-50">
                    <td className="py-3 pr-4 font-medium text-teal-900">${fmt(loan.amount)}</td>
                    <td className="py-3 pr-4">{loan.termDays ?? 30} {t('dash_days')}</td>
                    <td className="py-3 pr-4">${fmt(loan.repaymentAmount || loan.total || 0)}</td>
                    <td className="py-3 pr-4">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[loan.status] || 'bg-gray-100 text-gray-600'}`}>
                        {t(`status_${loan.status}`)}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-gray-500">
                      {loan.createdAt ? new Date(loan.createdAt.seconds * 1000).toLocaleDateString() : '—'}
                    </td>
                    <td className="py-3 pr-4">
                      {['active', 'overdue'].includes(loan.status) ? (
                        <PayNowButton loanId={loan.id} label={t('dash_pay_now')} errorLabel={t('dash_pay_error')} />
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Loan Request Modal */}
      {showModal && employee && (
        <LoanModal
          availableCredit={employee.availableCredit}
          onClose={() => setShowModal(false)}
          onSubmitted={handleLoanSubmitted}
        />
      )}
    </div>
  );
}

function PayNowButton({ loanId, label, errorLabel }: { loanId: string; label: string; errorLabel: string }) {
  const [loading, setLoading] = useState(false);

  const handlePay = async () => {
    setLoading(true);
    try {
      const functions = getFunctions();
      const generatePaymentLink = httpsCallable<{ loanId: string }, { paymentUrl: string }>(functions, 'generatePaymentLink');
      const result = await generatePaymentLink({ loanId });
      window.open(result.data.paymentUrl, '_blank');
    } catch {
      alert(errorLabel);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handlePay}
      disabled={loading}
      className="rounded-md bg-teal-700 px-3 py-1 text-xs font-medium text-white hover:bg-teal-800 disabled:opacity-50"
    >
      {loading ? (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border border-white border-t-transparent" />
      ) : (
        label
      )}
    </button>
  );
}

function LoanModal({
  availableCredit,
  onClose,
  onSubmitted,
}: {
  availableCredit: number;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(1000);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const fee = Math.round(amount * 0.3);
  const total = amount + fee;
  const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const cat = amount > 0 ? ((Math.pow(1 + fee / amount, 365 / 30) - 1) * 100).toFixed(0) : '0';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (amount > availableCredit) {
      setError(t('modal_exceed'));
      return;
    }
    if (amount < 500) {
      setError(t('modal_minimum'));
      return;
    }

    setSubmitting(true);
    try {
      const functions = getFunctions();
      const requestLoan = httpsCallable(functions, 'requestLoan');
      await requestLoan({ amount, term: 30 });
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-gray-400 hover:text-gray-600"
        >
          ✕
        </button>

        <h3 className="text-lg font-bold text-teal-900">{t('modal_request')}</h3>
        <p className="mt-1 text-sm text-gray-500">
          {t('modal_available')}: ${fmt(availableCredit)} MXN
        </p>

        <form onSubmit={handleSubmit} className="mt-6">
          {/* Amount */}
          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium text-gray-700">{t('modal_amount')}</label>
            <input
              type="number"
              min={500}
              max={availableCredit}
              step={100}
              value={amount}
              onChange={(e) => setAmount(parseInt(e.target.value) || 0)}
              className="w-full rounded-lg border border-gray-200 px-4 py-2 text-sm outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
              required
            />
          </div>

          {/* Terms */}
          <div className="mb-4 flex items-center justify-between text-sm text-gray-500">
            <span>{t('modal_term')}</span>
            <span className="font-semibold text-teal-900">{t('modal_term_30')} · {t('modal_rate')}</span>
          </div>

          {/* Breakdown */}
          <div className="mb-4 space-y-2 border-y border-gray-100 py-4">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">{t('modal_loan_amount')}</span>
              <span className="font-semibold text-teal-900">${fmt(amount)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">{t('modal_fee')}</span>
              <span className="font-semibold text-teal-900">${fmt(fee)}</span>
            </div>
            <div className="border-t border-gray-100 pt-2" />
            <div className="flex justify-between">
              <span className="font-medium text-teal-900">{t('modal_total')}</span>
              <span className="text-lg font-bold text-teal-900">${fmt(total)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">{t('modal_due_date')}</span>
              <span className="font-semibold text-teal-900">{dueDate.toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">CAT (Costo Anual Total)</span>
              <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700">{cat}% anual</span>
            </div>
          </div>

          {/* Terms checkbox */}
          <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-teal-600"
            />
            {t('modal_accept_terms')}
          </label>

          {/* Error */}
          {error && (
            <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          {/* Buttons */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              {t('modal_cancel')}
            </button>
            <button
              type="submit"
              disabled={!termsAccepted || submitting}
              className="flex-1 rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {submitting ? t('modal_submitting') : t('modal_confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
