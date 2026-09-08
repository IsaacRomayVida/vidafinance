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
import { fmt, fmtShortDate, initials, nextScheduledDeduction } from '../components/employee/types';

const IN_FLIGHT_STATUSES = [
  'pending', 'under_review', 'approved', 'active',
  'disbursement_queued', 'disbursed', 'escalated', 'overdue',
];
const SETTLED_STATUSES = ['paid', 'repaid', 'completed'];

type LoanFilter = 'all' | 'active' | 'paid';

/**
 * The companion card: acetate, opened by the user, three chips that are
 * facts or offers — never questions back to the borrower. Every figure on a
 * chip is read from the employee document or the loan document; a chip whose
 * figure cannot be read is not shown. The sparkle on the open button is the
 * one sparkle in the product.
 */
function Companion({
  employee,
  activeLoan,
  totalPaid,
}: {
  employee: EmployeeData;
  activeLoan: Loan | undefined;
  totalPaid: number;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);

  const limit = employee.creditLimit ?? 0;
  const available = employee.availableCredit ?? 0;
  const used = Math.max(0, limit - available);
  const employer = employee.employerName || activeLoan?.employerName || t('dash_your_employer');

  // Next deduction: the first scheduled step not yet covered by what was paid.
  const next = activeLoan ? nextScheduledDeduction(activeLoan.repaymentSchedule, totalPaid) : null;
  const nextAmount = next ? next.amount : null;
  const nextDate = next && activeLoan ? fmtShortDate(next.dueDate ?? activeLoan.dueDate, i18n.language) : null;
  const totalOwed = activeLoan ? activeLoan.repaymentAmount || activeLoan.total || 0 : 0;

  const chips: { chip: string; fact: string }[] = [];
  if (activeLoan && nextAmount !== null && nextDate) {
    chips.push({
      chip: t('dash_chip_next_deduction', { amount: fmt(nextAmount), date: nextDate }),
      fact: t('dash_fact_next_deduction', { amount: fmt(nextAmount), date: nextDate, employer }),
    });
  } else if (!activeLoan) {
    chips.push({
      chip: t('dash_chip_available', { available: fmt(available), limit: fmt(limit) }),
      fact: t('dash_fact_available', { available: fmt(available) }),
    });
  }
  chips.push({
    chip: t('dash_chip_why_limit', { limit: fmt(limit) }),
    fact: t('dash_fact_why_limit', { limit: fmt(limit), used: fmt(used), available: fmt(available) }),
  });
  chips.push({
    chip: t('dash_chip_deducted_by', { employer }),
    fact:
      activeLoan && totalOwed > 0
        ? t('dash_fact_deducted_by_active', { employer, total: fmt(totalOwed) })
        : t('dash_fact_deducted_by', { employer }),
  });

  return (
    <section className="bo-companion" aria-label={t('dash_companion')}>
      <div className="top">
        <span className="dot">{t('dash_companion')}</span>
        <button
          type="button"
          className="bo-exp"
          aria-expanded={open}
          aria-controls="bo-companion-facts"
          aria-label={t('dash_companion')}
          onClick={() => setOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z" />
          </svg>
        </button>
      </div>
      <div className="bo-qs">
        {chips.map((c) => (
          <button
            key={c.chip}
            type="button"
            className="bo-q"
            aria-expanded={open}
            aria-controls="bo-companion-facts"
            onClick={() => setOpen((o) => !o)}
          >
            {c.chip}
          </button>
        ))}
      </div>
      {open && (
        <div className="bo-facts" id="bo-companion-facts">
          {chips.map((c) => (
            <div key={c.chip} className="bo-fact">{c.fact}</div>
          ))}
        </div>
      )}
    </section>
  );
}

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
  const [filter, setFilter] = useState<LoanFilter>('all');
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

  const completedPaid = (loanId: string) =>
    (repaymentsByLoan[loanId] || [])
      .filter((r) => r.status === 'completed')
      .reduce((sum, r) => sum + (r.amount || 0), 0);

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
      <div className="bo-screen paper" style={{ minHeight: 0 }}>
        <ErrorBanner message={dashboardError} style={{ textAlign: 'left', marginBottom: 16 }} />
        <div>
          <button type="button" onClick={retry} className="bo-ghost">
            {t('dash_retry', 'Reintentar')}
          </button>
        </div>
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
      <div className="bo-screen paper">
        <div className="bo-head"><span className="dot">{t('dash_home_label')}</span></div>
        <div className="bo-center">
          <h2>{t('dash_verify_email')}</h2>
          <p>{t('dash_verify_email_desc')}</p>
        </div>
        <div className="bo-actions">
          <button
            type="button"
            onClick={() => signOut(auth).then(() => navigate('/login'))}
            className="bo-ghost"
          >
            {t('dash_back_to_login')}
          </button>
        </div>
      </div>
    );
  }

  if (!employee) return null;

  const activeLoan = loans.find((l) => l.status === 'active' || l.status === 'overdue');
  const counts: Record<LoanFilter, number> = {
    all: loans.length,
    active: loans.filter((l) => IN_FLIGHT_STATUSES.includes(l.status)).length,
    paid: loans.filter((l) => SETTLED_STATUSES.includes(l.status)).length,
  };
  const visibleLoans =
    filter === 'active'
      ? loans.filter((l) => IN_FLIGHT_STATUSES.includes(l.status))
      : filter === 'paid'
        ? loans.filter((l) => SETTLED_STATUSES.includes(l.status))
        : loans;
  const filters: { key: LoanFilter; label: string }[] = [
    { key: 'all', label: t('dash_filter_all') },
    { key: 'active', label: t('dash_filter_active') },
    { key: 'paid', label: t('dash_filter_paid') },
  ];

  return (
    <div className="bo-screen leaf">
      {/* Header */}
      <div className="bo-head">
        <span className="dot">{t('dash_home_label')}</span>
        <span className="bo-av" aria-label={employee.name || user?.displayName || user?.email || ''}>
          {initials(employee.name || user?.displayName, 'FP')}
        </span>
      </div>

      {/* KYC Banner */}
      {employee.kycStatus && employee.kycStatus !== 'approved' && loans.length === 0 && (
        <KYCBanner kycStatus={employee.kycStatus} />
      )}

      {repaymentsError && (
        <div style={{ marginTop: 16 }}>
          <ErrorBanner
            style={{ borderRadius: 20, background: '#fbeeed', border: '1px solid rgba(139,32,32,.12)', color: '#8b2020' }}
            message={t(
              'dash_repayments_error',
              'No pudimos cargar tu historial de pagos. Los saldos mostrados podrían estar incompletos.',
            )}
          />
        </div>
      )}

      {/* Capture first: the available credit, then the one green control */}
      <CreditWidget
        employee={employee}
        loans={loans}
        hasActiveLoan={hasActiveLoan}
        onOpenModal={goToApply}
      />

      {/* The credit in flight (or the last settled one), as a frosted chip */}
      {statusCardLoan && (
        <LoanStatusCard
          loan={statusCardLoan}
          totalPaid={completedPaid(statusCardLoan.id)}
          onRequestAnother={
            ['paid', 'repaid', 'completed'].includes(statusCardLoan.status)
              ? goToApply
              : undefined
          }
        />
      )}

      {/* The companion works after: a card the user opens */}
      <Companion
        employee={employee}
        activeLoan={activeLoan}
        totalPaid={activeLoan ? completedPaid(activeLoan.id) : 0}
      />

      {/* Filter pills + the credit list */}
      <div className="bo-pills" role="group" aria-label={t('dash_your_loans')}>
        {filters.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            className={`bo-pill${filter === key ? ' on' : ''}`}
            onClick={() => setFilter(key)}
          >
            {filter === key && <span className="bo-cnt">{counts[key]}</span>}
            {label}
          </button>
        ))}
      </div>
      <LoanTable
        loans={visibleLoans}
        repaymentsByLoan={repaymentsByLoan}
        loading={loading}
        onOpenModal={goToApply}
        onPayLoan={setPaymentLoan}
      />

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
