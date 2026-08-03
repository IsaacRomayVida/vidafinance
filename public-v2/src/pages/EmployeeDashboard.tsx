import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'motion/react';
import { doc, getDoc, collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { signOut } from 'firebase/auth';
import { auth, db } from '../lib/firebase';
import { friendlyError } from '../lib/errors';
import { useAuth } from '../hooks/useAuth';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { LoanStatusCard } from '../components/LoanStatusCard';
import { KYCBanner } from '../components/employee/KYCBanner';
import { CreditWidget } from '../components/employee/CreditWidget';
import { LoanTable } from '../components/employee/LoanTable';
import { PaymentModal } from '../components/employee/PaymentModal';
import type { EmployeeData, Loan, Repayment } from '../components/employee/types';
import { fmt } from '../components/employee/types';

const IN_FLIGHT_STATUSES = [
  'pending', 'under_review', 'approved', 'active',
  'disbursement_queued', 'disbursed', 'escalated', 'overdue',
];

export function EmployeeDashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [employee, setEmployee] = useState<EmployeeData | null>(null);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [repayments, setRepayments] = useState<Repayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [paymentLoan, setPaymentLoan] = useState<Loan | null>(null);
  const [pageState, setPageState] = useState<'loading' | 'dashboard'>('loading');
  // Two independent reads can take this page down — the employee document and
  // the loans listener — and each owns its OWN error string. They used to
  // share one, which was safe only while the clear happened synchronously at
  // the top of each effect. That clear is no longer allowed there
  // (`react-hooks/set-state-in-effect`, a CI-blocking lint error), so it moved
  // onto the success paths — and the employee read's success path is async.
  // With a shared string that reordering is a race: the loans listener writes
  // its error during the commit, then the employee read's microtask resolves
  // and wipes it, leaving the borrower on a dashboard that silently failed to
  // load their loans. Separate owners make that wipe impossible no matter
  // which read settles first.
  const [employeeError, setEmployeeError] = useState('');
  const [loansError, setLoansError] = useState('');
  const [repaymentsError, setRepaymentsError] = useState('');
  const [retryToken, setRetryToken] = useState(0);

  // Whichever blocking read failed takes the page down; the employee document
  // gates everything else, so it wins when both are broken.
  const dashboardError = employeeError || loansError;

  // Cleared here, in the event handler, not in the effect bodies below (same
  // lint rule). The success paths clear their own error too, so a failure that
  // resolves on its own also clears without a click.
  const retry = () => {
    setEmployeeError('');
    setLoansError('');
    setRepaymentsError('');
    setRetryToken((n) => n + 1);
  };

  const hasActiveLoan = loans.some(l => IN_FLIGHT_STATUSES.includes(l.status));
  const statusCardLoan =
    loans.find(l => IN_FLIGHT_STATUSES.includes(l.status)) ||
    loans.find(l => ['paid', 'repaid', 'completed', 'rejected'].includes(l.status));

  const needsEmailVerification = user
    ? (!user.emailVerified && !user.email?.endsWith('@vida-test.com'))
    : false;

  // The employee document gates the whole page: `pageState` only leaves
  // 'loading' on the success path. Without a catch, a rejected read (offline
  // client, transient permission error) left the borrower on a spinner
  // forever — indistinguishable from "still loading" — plus an unhandled
  // promise rejection (F7).
  useEffect(() => {
    if (!user || needsEmailVerification) return;
    (async () => {
      try {
        const empDoc = await getDoc(doc(db, 'employees', user.uid));
        if (!empDoc.exists()) {
          navigate('/employer', { replace: true });
          return;
        }
        setEmployee(empDoc.data() as EmployeeData);
        setPageState('dashboard');
        setEmployeeError('');
      } catch (err) {
        setEmployeeError(friendlyError(err));
      }
    })();
  }, [user, navigate, needsEmailVerification, retryToken]);

  // Same failure shape as the employee read: `setLoading(false)` lived only on
  // the success path, so a listener error left the loan list spinning (F7).
  useEffect(() => {
    if (!user || pageState !== 'dashboard') return;
    const q = query(
      collection(db, 'loans'),
      where('employeeId', '==', user.uid),
      orderBy('createdAt', 'desc'),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setLoans(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan)));
        setLoading(false);
        setLoansError('');
      },
      (err) => {
        setLoading(false);
        setLoansError(friendlyError(err));
      },
    );
    return unsub;
  }, [user, pageState, retryToken]);

  // A repayments failure doesn't block the page — the loan list is still
  // usable — but it silently understates every balance shown, so it gets its
  // own non-blocking banner rather than taking the page down.
  useEffect(() => {
    if (!user || pageState !== 'dashboard') return;
    const q = query(collection(db, 'repayments'), where('employeeId', '==', user.uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setRepayments(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Repayment)));
        setRepaymentsError('');
      },
      (err) => setRepaymentsError(friendlyError(err)),
    );
    return unsub;
  }, [user, pageState, retryToken]);

  const repaymentsByLoan = repayments.reduce<Record<string, Repayment[]>>((acc, r) => {
    if (!acc[r.loanId]) acc[r.loanId] = [];
    acc[r.loanId].push(r);
    return acc;
  }, {});

  // Requesting a loan navigates to the wizard rather than opening a modal
  // (#446). There is one priced surface, so there is one place a borrower can
  // be quoted a fee, a due date and a CAT. The dashboard reloads the employee
  // document on mount, so returning from the wizard refreshes the balance
  // without a callback threaded through the request UI.
  const goToApply = () => navigate('/employee/apply');

  // Checked BEFORE the spinner: on a failed read `pageState` never leaves
  // 'loading', so an error branch placed after it would be unreachable.
  if (dashboardError) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <ErrorBanner message={dashboardError} style={{ textAlign: 'left', marginBottom: 16 }} />
        <button onClick={retry} className="btn-primary">
          {t('dash_retry', 'Reintentar')}
        </button>
      </div>
    );
  }

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

      {/* KYC Banner */}
      {employee.kycStatus && employee.kycStatus !== 'approved' && loans.length === 0 && (
        <KYCBanner kycStatus={employee.kycStatus} />
      )}

      {/* Content */}
      <div className="dash-content">
        {repaymentsError && (
          <div style={{ marginBottom: 20 }}>
            <ErrorBanner
              message={t(
                'dash_repayments_error',
                'No pudimos cargar tu historial de pagos. Los saldos mostrados podrían estar incompletos.',
              )}
            />
          </div>
        )}

        <CreditWidget
          employee={employee}
          loans={loans}
          hasActiveLoan={hasActiveLoan}
          onOpenModal={goToApply}
        />

        {/* Loan Status Card */}
        {statusCardLoan && (
          <LoanStatusCard
            loan={statusCardLoan}
            totalPaid={
              (repaymentsByLoan[statusCardLoan.id] || [])
                .filter((r) => r.status === 'completed')
                .reduce((sum, r) => sum + (r.amount || 0), 0)
            }
            onRequestAnother={
              ['paid', 'repaid', 'completed'].includes(statusCardLoan.status)
                ? goToApply
                : undefined
            }
          />
        )}

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
                {new Date(nextRepayment.dueDate!.seconds * 1000).toLocaleDateString('es-MX')}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="stat-label" style={{ marginBottom: 4 }}>{t('dash_th_repayment')}</div>
              <div className="money" style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>
                ${fmt(nextRepayment.repaymentAmount || nextRepayment.total || 0)}
              </div>
            </div>
          </div>
        )}

        {/* Loans Table */}
        <LoanTable
          loans={loans}
          repaymentsByLoan={repaymentsByLoan}
          loading={loading}
          onOpenModal={goToApply}
          onPayLoan={setPaymentLoan}
        />
      </div>

      {/* Modals */}
      <AnimatePresence>
        {paymentLoan && (
          <PaymentModal
            key={paymentLoan.id}
            loan={paymentLoan}
            repayments={repaymentsByLoan[paymentLoan.id] || []}
            onClose={() => setPaymentLoan(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
