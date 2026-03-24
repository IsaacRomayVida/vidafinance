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
  employerId?: string;
  bankClabe?: string;
  creditLimit: number;
  availableCredit: number;
}

const LOAN_PURPOSES = [
  'emergency',
  'medical',
  'education',
  'home_repair',
  'transportation',
  'debt_consolidation',
  'other',
] as const;

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
      <div className="dash-header">
        <h1>
          {t('dash_welcome')}, {employee.name || user?.displayName || user?.email}
        </h1>
        <div className="dash-user">
          <span>{employee.employerName}</span>
          <div className="dash-avatar">
            {employee.name?.charAt(0) || 'E'}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="dash-content">
        {/* Stats Grid */}
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-label">{t('dash_available_credit')}</div>
            <div className="stat-value">${fmt(employee.availableCredit)}</div>
            <div className="stat-change">MXN</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t('dash_credit_limit')}</div>
            <div className="stat-value">${fmt(employee.creditLimit)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t('dash_utilization')}</div>
            <div className="stat-value">{utilPct}%</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t('dash_quick_action')}</div>
            <button
              onClick={() => setShowModal(true)}
              disabled={employee.availableCredit < 500}
              className="btn-primary"
              style={{ marginTop: 8 }}
            >
              {t('dash_request_funds')}
            </button>
          </div>
        </div>

        {/* Next Repayment */}
        {nextRepayment && (
          <div style={{
            borderTop: '1px solid rgba(25,68,69,0.06)',
            borderBottom: '1px solid rgba(25,68,69,0.06)',
            padding: '20px 0',
            marginBottom: 24,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
          }}>
            <div>
              <div className="stat-label" style={{ marginBottom: 4 }}>{t('modal_due_date')}</div>
              <div style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>
                {new Date(nextRepayment.dueDate!.seconds * 1000).toLocaleDateString()}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="stat-label" style={{ marginBottom: 4 }}>{t('dash_th_repayment')}</div>
              <div style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>
                ${fmt(nextRepayment.repaymentAmount || nextRepayment.total || 0)}
              </div>
            </div>
          </div>
        )}

        {/* Loans Table */}
        <div className="card">
          <div className="card-title">{t('dash_your_loans')}</div>

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <span className="spinner" style={{ borderColor: 'rgba(25,68,69,0.1)', borderTopColor: 'var(--brand)' }} />
            </div>
          ) : loans.length === 0 ? (
            <div className="empty-state">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              <p>{t('dash_no_loans_employee')}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('dash_th_amount')}</th>
                    <th>{t('dash_th_term')}</th>
                    <th>{t('dash_th_repayment')}</th>
                    <th>{t('dash_th_status')}</th>
                    <th>{t('dash_th_date')}</th>
                    <th>{t('dash_th_action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loans.map((loan) => (
                    <tr key={loan.id}>
                      <td style={{ fontWeight: 500 }}>${fmt(loan.amount)}</td>
                      <td>{loan.termDays ?? 30} {t('dash_days')}</td>
                      <td>${fmt(loan.repaymentAmount || loan.total || 0)}</td>
                      <td>
                        <span className={`badge badge-${loan.status}`}>
                          {t(`status_${loan.status}`)}
                        </span>
                      </td>
                      <td>
                        {loan.createdAt ? new Date(loan.createdAt.seconds * 1000).toLocaleDateString() : '—'}
                      </td>
                      <td>
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
      </div>

      {/* Loan Request Modal */}
      {showModal && employee && (
        <LoanModal
          availableCredit={employee.availableCredit}
          employerId={employee.employerId}
          savedClabe={employee.bankClabe}
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
      className="btn-sm btn-approve"
    >
      {loading ? (
        <span className="spinner" />
      ) : (
        label
      )}
    </button>
  );
}

function LoanModal({
  availableCredit,
  employerId,
  savedClabe,
  onClose,
  onSubmitted,
}: {
  availableCredit: number;
  employerId?: string;
  savedClabe?: string;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(1000);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [employerCode, setEmployerCode] = useState('');
  const [loadingEmployer, setLoadingEmployer] = useState(true);
  const [clabe, setClabe] = useState(savedClabe || '');
  const [editingClabe, setEditingClabe] = useState(!savedClabe);
  const [loanPurpose, setLoanPurpose] = useState('');

  // Fetch employer code from employer doc
  useEffect(() => {
    if (!employerId) {
      setLoadingEmployer(false);
      return;
    }
    (async () => {
      try {
        const empDoc = await getDoc(doc(db, 'employers', employerId));
        if (empDoc.exists()) {
          setEmployerCode(empDoc.data().employerCode || '');
        }
      } catch {
        // employer code will be empty, submit will fail with server validation
      } finally {
        setLoadingEmployer(false);
      }
    })();
  }, [employerId]);

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
    if (!employerCode) {
      setError(t('modal_no_employer'));
      return;
    }
    if (!/^\d{18}$/.test(clabe)) {
      setError(t('modal_clabe_invalid'));
      return;
    }

    setSubmitting(true);
    try {
      const functions = getFunctions();
      const requestLoan = httpsCallable(functions, 'requestLoan');
      await requestLoan({
        amount,
        bankAccountClabe: clabe,
        employerCode,
        termsAccepted: true,
        ...(loanPurpose ? { loanPurpose } : {}),
      });
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-overlay show"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal" style={{ position: 'relative' }}>
        <div className="modal-close" onClick={onClose}>✕</div>

        <h3>{t('modal_request')}</h3>
        <p className="modal-sub">
          {t('modal_available')}: ${fmt(availableCredit)} MXN
        </p>

        <form onSubmit={handleSubmit}>
          {/* Amount */}
          <div className="form-group">
            <label>{t('modal_amount')}</label>
            <input
              type="number"
              min={500}
              max={availableCredit}
              step={100}
              value={amount}
              onChange={(e) => setAmount(parseInt(e.target.value) || 0)}
              required
            />
          </div>

          {/* CLABE */}
          <div className="form-group">
            <label>{t('modal_clabe_label')}</label>
            {savedClabe && !editingClabe ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, color: 'var(--t1)', fontFamily: 'var(--mono, monospace)' }}>
                  {'****' + savedClabe.slice(-4)}
                </span>
                <button
                  type="button"
                  onClick={() => { setEditingClabe(true); setClabe(''); }}
                  style={{ fontSize: 12, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                >
                  {t('modal_clabe_edit')}
                </button>
              </div>
            ) : (
              <input
                type="text"
                inputMode="numeric"
                maxLength={18}
                placeholder={t('modal_clabe_placeholder')}
                value={clabe}
                onChange={(e) => setClabe(e.target.value.replace(/\D/g, '').slice(0, 18))}
                required
              />
            )}
          </div>

          {/* Loan Purpose */}
          <div className="form-group">
            <label>{t('modal_purpose_label')}</label>
            <select
              value={loanPurpose}
              onChange={(e) => setLoanPurpose(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">{t('modal_purpose_none')}</option>
              {LOAN_PURPOSES.map((p) => (
                <option key={p} value={p}>{t(`modal_purpose_${p}`)}</option>
              ))}
            </select>
          </div>

          {/* Terms */}
          <div className="form-group" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0' }}>
            <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_term')}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{t('modal_term_30')} · {t('modal_rate')}</span>
          </div>

          {/* Breakdown */}
          <div style={{ borderTop: '1px solid rgba(25,68,69,0.06)', borderBottom: '1px solid rgba(25,68,69,0.06)', padding: '20px 0', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_loan_amount')}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(amount)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_fee')}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(fee)}</span>
            </div>
            <div style={{ height: 1, background: 'rgba(25,68,69,0.06)', margin: '4px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontFamily: 'var(--df)', fontSize: 15, color: 'var(--t1)' }}>{t('modal_total')}</span>
              <span style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>${fmt(total)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_due_date')}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{dueDate.toLocaleDateString()}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>CAT (Costo Anual Total)</span>
              <span className="cat-highlight">{cat}{t('loan_cat_annual')}</span>
            </div>
            <p className="cat-note">
              {t('loan_cat_description')}{' '}
              <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener noreferrer">{t('loan_condusef_ref')}</a>
            </p>
          </div>

          {/* Terms checkbox */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, cursor: 'pointer', fontSize: 13, color: 'var(--t2)' }}>
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
            />
            <span>{t('modal_accept_terms')}</span>
          </label>

          {/* Error */}
          {error && (
            <div className="auth-error show" style={{ marginBottom: 12 }}>{error}</div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={!termsAccepted || submitting || loadingEmployer}
            className="btn-primary"
          >
            {submitting ? (
              <><span className="spinner" />{t('modal_submitting')}</>
            ) : (
              t('modal_confirm')
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
