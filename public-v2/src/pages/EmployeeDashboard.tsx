import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc, collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { signOut } from 'firebase/auth';
import { auth, db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

interface Repayment {
  id: string;
  loanId: string;
  amount: number;
  paidAt?: { seconds: number };
  createdAt?: { seconds: number };
  method?: string;
  status?: string;
  [key: string]: unknown;
}

interface EmployeeData {
  name?: string;
  email?: string;
  employerName?: string;
  employerId?: string;
  bankClabe?: string;
  creditLimit: number;
  availableCredit: number;
  kycStatus?: string;
  employerCode?: string;
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
  const hasActiveLoan = loans.some(l => ['pending', 'approved', 'active', 'disbursement_queued'].includes(l.status));
  const [repayments, setRepayments] = useState<Repayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [paymentLoan, setPaymentLoan] = useState<Loan | null>(null);
  const [pageState, setPageState] = useState<'loading' | 'dashboard'>('loading');

  const needsEmailVerification = user ? (!user.emailVerified && !user.email?.endsWith('@vida-test.com')) : false;

  // Fetch employee doc
  useEffect(() => {
    if (!user || needsEmailVerification) return;

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
  }, [user, navigate, needsEmailVerification]);

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

  // Real-time repayments listener
  useEffect(() => {
    if (!user || pageState !== 'dashboard') return;

    const q = query(
      collection(db, 'repayments'),
      where('employeeId', '==', user.uid),
    );

    const unsub = onSnapshot(q, (snap) => {
      setRepayments(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Repayment)));
    });

    return unsub;
  }, [user, pageState]);

  // Group repayments by loanId
  const repaymentsByLoan = repayments.reduce<Record<string, Repayment[]>>(
    (acc, r) => {
      if (!acc[r.loanId]) acc[r.loanId] = [];
      acc[r.loanId].push(r);
      return acc;
    },
    {},
  );

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

  if (needsEmailVerification) {
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
    .sort((a, b) => (a.dueDate!.seconds - b.dueDate!.seconds))[0];

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

      {/* KYC pending banner */}
      {employee.kycStatus && employee.kycStatus !== 'approved' && loans.length === 0 && (
        <div style={{
          margin: '0 auto', maxWidth: 960, padding: '0 20px',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '14px 20px', borderRadius: 12,
            background: employee.kycStatus === 'rejected' ? '#fef2f2' : '#fffbeb',
            border: `1px solid ${employee.kycStatus === 'rejected' ? '#fecaca' : '#fde68a'}`,
            marginBottom: 16,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: employee.kycStatus === 'rejected' ? '#fee2e2' : '#fef3c7',
              flexShrink: 0,
            }}>
              {employee.kycStatus === 'rejected' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                </svg>
              )}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: employee.kycStatus === 'rejected' ? '#991b1b' : '#92400e' }}>
                {employee.kycStatus === 'rejected'
                  ? t('dash_kyc_rejected', 'Verificación rechazada')
                  : employee.kycStatus === 'not_started'
                    ? t('dash_kyc_not_started', 'Verificación de identidad pendiente')
                    : t('dash_kyc_pending', 'Verificación en proceso')}
              </div>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
                {employee.kycStatus === 'rejected'
                  ? t('dash_kyc_rejected_desc', 'Tu verificación fue rechazada. Contacta soporte para más información.')
                  : employee.kycStatus === 'not_started'
                    ? t('dash_kyc_not_started_desc', 'Completa tu verificación de identidad para acceder a tu crédito.')
                    : t('dash_kyc_pending_desc', 'Estamos revisando tu documentación. Te notificaremos cuando esté lista.')}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="dash-content">
        {/* ── Premium Credit Hero ── */}
        <div className="credit-hero-grid" style={{
          display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 40,
          marginBottom: 48, alignItems: 'center',
        }}>
          {/* Left: Credit Ring */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 0' }}>
            <div style={{ position: 'relative', width: 200, height: 200 }}>
              <svg width="200" height="200" viewBox="0 0 200 200" style={{ transform: 'rotate(-90deg)' }}>
                {/* Background ring */}
                <circle cx="100" cy="100" r="85" fill="none" stroke="rgba(25,68,69,0.04)" strokeWidth="12" />
                {/* Progress ring */}
                <circle cx="100" cy="100" r="85" fill="none"
                  stroke="url(#creditGrad)" strokeWidth="12" strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 85}
                  strokeDashoffset={2 * Math.PI * 85 * (1 - utilPct / 100)}
                  style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(0.16,1,0.3,1)' }}
                />
                <defs>
                  <linearGradient id="creditGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#194445" />
                    <stop offset="100%" stopColor="#a8d5d0" />
                  </linearGradient>
                </defs>
              </svg>
              {/* Center text */}
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: '#a28657', marginBottom: 6 }}>
                  {t('dash_utilization')}
                </div>
                <div style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 42, color: '#0c1e1f', lineHeight: 1 }}>
                  {utilPct}%
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'center', marginTop: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 6 }}>
                {t('dash_credit_limit')}
              </div>
              <div style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 20, color: '#4a6364' }}>
                ${fmt(employee.creditLimit)} <span style={{ fontSize: 12, color: '#93aaa9', fontFamily: "'DM Sans'" }}>MXN</span>
              </div>
            </div>
          </div>

          {/* Right: Amount + CTA */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2.5, textTransform: 'uppercase', color: '#a28657', marginBottom: 12 }}>
              {t('dash_available_credit')}
            </div>
            <div style={{
              fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 56, color: '#0c1e1f',
              lineHeight: 1, letterSpacing: '-0.03em', marginBottom: 4,
            }}>
              <span style={{ fontSize: 24, color: '#a8d5d0', opacity: 0.6, verticalAlign: 'top', marginRight: 2 }}>$</span>
              {fmt(employee.availableCredit)}
            </div>
            <div style={{ fontSize: 14, color: '#93aaa9', marginBottom: 32 }}>MXN</div>

            <button
              onClick={() => { if (hasActiveLoan) { alert("Ya tienes un préstamo activo. Debes completar tu préstamo actual antes de solicitar otro."); return; } setShowModal(true); }}
              disabled={employee.availableCredit < 500}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 10,
                padding: '18px 36px', borderRadius: 14, border: 'none',
                background: employee.availableCredit >= 500
                  ? 'linear-gradient(135deg, #194445 0%, #1d5253 100%)'
                  : 'rgba(25,68,69,0.08)',
                color: employee.availableCredit >= 500 ? 'white' : '#93aaa9',
                fontSize: 16, fontWeight: 700, fontFamily: "'DM Sans', sans-serif",
                cursor: employee.availableCredit >= 500 ? 'pointer' : 'not-allowed',
                boxShadow: employee.availableCredit >= 500
                  ? '0 4px 20px rgba(25,68,69,0.2), inset 0 1px 0 rgba(255,255,255,0.1)'
                  : 'none',
                transition: 'all 0.35s cubic-bezier(0.22,1,0.36,1)',
                letterSpacing: '0.01em',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
              </svg>
              {t('dash_request_funds')}
            </button>

            {/* Quick stats row */}
            <div style={{ display: 'flex', gap: 32, marginTop: 32, paddingTop: 24, borderTop: '1px solid rgba(25,68,69,0.05)' }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 4 }}>
                  {t('dash_active_loans', 'Préstamos activos')}
                </div>
                <div style={{ fontFamily: "'DM Serif Display'", fontSize: 24, color: '#0c1e1f' }}>
                  {loans.filter(l => l.status === 'active' || l.status === 'approved').length}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 4 }}>
                  {t('dash_total_borrowed', 'Total prestado')}
                </div>
                <div style={{ fontFamily: "'DM Serif Display'", fontSize: 24, color: '#0c1e1f' }}>
                  ${fmt(loans.reduce((s, l) => s + (l.amount || 0), 0))}
                </div>
              </div>
            </div>
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
            <div style={{ padding: 16 }}>
              {[1,2].map(i => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0',
                  borderBottom: '1px solid rgba(25,68,69,0.04)',
                  animation: 'skeletonPulse 1.5s ease-in-out infinite',
                  animationDelay: i * 0.2 + 's',
                }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(25,68,69,0.04)' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ width: '50%', height: 11, borderRadius: 6, background: 'rgba(25,68,69,0.04)', marginBottom: 6 }} />
                    <div style={{ width: '30%', height: 9, borderRadius: 6, background: 'rgba(25,68,69,0.03)' }} />
                  </div>
                  <div style={{ width: 50, height: 20, borderRadius: 10, background: 'rgba(25,68,69,0.04)' }} />
                </div>
              ))}
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
                  {loans.map((loan) => {
                    const loanRepayments = repaymentsByLoan[loan.id] || [];
                    const hasPending = loanRepayments.some((r) => r.status === 'pending');
                    const hasProcessing = loanRepayments.some((r) => r.status === 'processing');
                    const totalPaid = loanRepayments
                      .filter((r) => r.status === 'completed')
                      .reduce((sum, r) => sum + (r.amount || 0), 0);

                    return (
                      <tr key={loan.id}>
                        <td style={{ fontWeight: 500 }}>${fmt(loan.amount)}</td>
                        <td>{loan.termDays ?? 30} {t('dash_days')}</td>
                        <td>${fmt(loan.repaymentAmount || loan.total || 0)}</td>
                        <td>
                          <span className={`badge badge-${loan.status}`}>
                            {t(`status_${loan.status}`)}
                          </span>
                          {hasPending && (
                            <span className="badge badge-pending" style={{ marginLeft: 4, fontSize: 10 }}>
                              {t('pay_status_pending', 'Pending')}
                            </span>
                          )}
                          {hasProcessing && (
                            <span className="badge badge-approved" style={{ marginLeft: 4, fontSize: 10 }}>
                              {t('pay_status_processing', 'Processing')}
                            </span>
                          )}
                          {totalPaid > 0 && !hasPending && !hasProcessing && (
                            <span className="badge badge-repaid" style={{ marginLeft: 4, fontSize: 10 }}>
                              {t('pay_status_paid', 'Paid')}
                            </span>
                          )}
                        </td>
                        <td>
                          {loan.createdAt ? new Date(loan.createdAt.seconds * 1000).toLocaleDateString() : '—'}
                        </td>
                        <td>
                          {['active', 'overdue'].includes(loan.status) ? (
                            <button
                              onClick={() => setPaymentLoan(loan)}
                              className="btn-sm btn-approve"
                            >
                              {t('dash_pay_now')}
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
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
          employerCode={employee.employerCode}
          savedClabe={employee.bankClabe}
          onClose={() => setShowModal(false)}
          onSubmitted={handleLoanSubmitted}
        />
      )}

      {/* Payment Modal */}
      {paymentLoan && (
        <PaymentModal
          loan={paymentLoan}
          repayments={repaymentsByLoan[paymentLoan.id] || []}
          onClose={() => setPaymentLoan(null)}
        />
      )}
    </div>
  );
}

function PaymentModal({
  loan,
  repayments,
  onClose,
}: {
  loan: Loan;
  repayments: Repayment[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');

  const totalOwed = loan.repaymentAmount || loan.total || 0;
  const totalPaid = repayments
    .filter((r) => r.status === 'completed')
    .reduce((sum, r) => sum + (r.amount || 0), 0);
  const remaining = Math.max(0, totalOwed - totalPaid);

  const sortedRepayments = [...repayments].sort((a, b) => {
    const aTime = (a.paidAt || a.createdAt)?.seconds ?? 0;
    const bTime = (b.paidAt || b.createdAt)?.seconds ?? 0;
    return bTime - aTime;
  });

  const handleGenerateLink = async () => {
    setLoading(true);
    setError('');
    try {
      const functions = getFunctions();
      const genPayLink = httpsCallable<{ loanId: string }, { paymentUrl: string; orderId: string; expiresIn: string }>(
        functions,
        'generatePaymentLink',
      );
      const result = await genPayLink({ loanId: loan.id });
      setPaymentUrl(result.data.paymentUrl);
    } catch {
      setError(t('dash_pay_error'));
    } finally {
      setLoading(false);
    }
  };

  const statusBadge = (status?: string) => {
    switch (status) {
      case 'completed':
        return <span className="badge badge-repaid">{t('pay_status_paid', 'Paid')}</span>;
      case 'processing':
        return <span className="badge badge-approved">{t('pay_status_processing', 'Processing')}</span>;
      default:
        return <span className="badge badge-pending">{t('pay_status_pending', 'Pending')}</span>;
    }
  };

  return (
    <div
      className="modal-overlay show"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal" style={{ position: 'relative', maxWidth: 480 }}>
        <div className="modal-close" onClick={onClose}>✕</div>

        <h3>{t('pay_modal_title', 'Make a Payment')}</h3>
        <p className="modal-sub" style={{ marginBottom: 20 }}>
          {t('pay_modal_subtitle', 'Loan')} · ${fmt(loan.amount)} MXN
        </p>

        {/* Payment summary */}
        <div style={{
          borderTop: '1px solid rgba(25,68,69,0.06)',
          borderBottom: '1px solid rgba(25,68,69,0.06)',
          padding: '20px 0',
          marginBottom: 20,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
            <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('pay_total_owed', 'Total Owed')}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(totalOwed)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
            <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('pay_total_paid', 'Total Paid')}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--success)' }}>${fmt(totalPaid)}</span>
          </div>
          <div style={{ height: 1, background: 'rgba(25,68,69,0.06)', margin: '4px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
            <span style={{ fontFamily: 'var(--df)', fontSize: 15, color: 'var(--t1)' }}>
              {t('pay_remaining', 'Remaining Balance')}
            </span>
            <span style={{ fontFamily: 'var(--df)', fontSize: 18, color: remaining > 0 ? 'var(--t1)' : 'var(--success)' }}>
              ${fmt(remaining)}
            </span>
          </div>
          {loan.dueDate && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_due_date')}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: loan.status === 'overdue' ? 'var(--danger)' : 'var(--t1)' }}>
                {new Date(loan.dueDate.seconds * 1000).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>

        {/* Payment action */}
        {!paymentUrl ? (
          <>
            {error && (
              <div className="auth-error show" style={{ marginBottom: 12 }}>{error}</div>
            )}
            <button
              onClick={handleGenerateLink}
              disabled={loading}
              className="btn-primary"
            >
              {loading ? (
                <><span className="spinner" /> {t('pay_generating', 'Generating link...')}</>
              ) : (
                t('pay_generate_link', 'Generate Payment Link')
              )}
            </button>
          </>
        ) : (
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{
              background: 'var(--bg2)',
              borderRadius: 12,
              padding: '20px 16px',
              marginBottom: 16,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2, color: 'var(--gold)', marginBottom: 10 }}>
                {t('pay_checkout_ready', 'Checkout Ready')}
              </div>
              <p style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 16 }}>
                {t('pay_checkout_desc', 'Click below to complete your payment via Conekta.')}
              </p>
              <a
                href={paymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary"
                style={{ display: 'inline-block', textDecoration: 'none', textAlign: 'center' }}
              >
                {t('pay_open_checkout', 'Open Checkout')}
              </a>
            </div>
            <button
              onClick={() => { setPaymentUrl(''); setError(''); }}
              style={{ background: 'none', border: 'none', color: 'var(--t3)', fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}
            >
              {t('pay_generate_new', 'Generate new link')}
            </button>
          </div>
        )}

        {/* Payment history */}
        {sortedRepayments.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{
              fontSize: 10.5,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 2.2,
              color: 'var(--gold)',
              marginBottom: 12,
            }}>
              {t('pay_history', 'Payment History')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sortedRepayments.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 14px',
                    background: 'var(--bg2)',
                    borderRadius: 10,
                    border: '1px solid rgba(25,68,69,0.04)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>
                      ${fmt(r.amount)}
                    </span>
                    {statusBadge(r.status)}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 12, color: 'var(--t3)' }}>
                      {r.paidAt || r.createdAt
                        ? new Date(((r.paidAt || r.createdAt)!.seconds) * 1000).toLocaleDateString()
                        : '—'}
                    </div>
                    {r.method && (
                      <div style={{ fontSize: 10, color: 'var(--t3)' }}>{r.method}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LoanModal({
  availableCredit,
  employerId,
  employerCode: initialEmployerCode,
  savedClabe,
  onClose,
  onSubmitted,
}: {
  availableCredit: number;
  employerId?: string;
  employerCode?: string;
  savedClabe?: string;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(1000);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [employerCode, setEmployerCode] = useState(initialEmployerCode || '');
  const [loadingEmployer, setLoadingEmployer] = useState(true);
  const [clabe, setClabe] = useState(savedClabe || '');
  const [editingClabe, setEditingClabe] = useState(!savedClabe);
  const [loanPurpose, setLoanPurpose] = useState('');

  // Fetch employer code from employer doc (skip if already provided)
  useEffect(() => {
    if (initialEmployerCode) {
      setLoadingEmployer(false);
      return;
    }
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
      // Force token refresh to pick up role claim set by onEmployeeDocCreated trigger
      if (auth.currentUser) await auth.currentUser.getIdToken(true);
      const functions = getFunctions();
      const requestLoan = httpsCallable(functions, 'requestLoan');
      await requestLoan({
        amount,
        term: 30,
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
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_cat_label')}</span>
              <span className="cat-highlight">{cat}{t('modal_cat_annual')}</span>
            </div>
            <p className="cat-note">
              {t('modal_cat_note')}{' '}
              <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener noreferrer">{t('modal_cat_condusef')}</a>
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
