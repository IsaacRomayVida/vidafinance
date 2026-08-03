import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { classifyError, friendlyError } from '../lib/errors';
import { useAuth } from '../hooks/useAuth';

interface Loan {
  id: string;
  principalAmount?: number;
  amount?: number;
  feeAmount?: number;
  totalRepaymentAmount?: number;
  total?: number;
  status: string;
  createdAt?: { seconds: number };
  requestedAt?: { seconds: number };
  disbursedAt?: { seconds: number };
  dueDate?: { seconds: number };
  contractUrl?: string;
  termDays?: number;
  currency?: string;
  loanPurpose?: string;
  [key: string]: unknown;
}

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

function fmt(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtDate(ts?: { seconds: number }): string {
  if (!ts) return '—';
  return new Date(ts.seconds * 1000).toLocaleDateString();
}

function loanPrincipal(loan: Loan): number {
  return loan.principalAmount ?? loan.amount ?? 0;
}

function loanTotal(loan: Loan): number {
  return loan.totalRepaymentAmount ?? loan.total ?? 0;
}

export function MyLoans() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [loans, setLoans] = useState<Loan[]>([]);
  const [repayments, setRepayments] = useState<Repayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedLoanId, setExpandedLoanId] = useState<string | null>(null);

  // Real-time loans listener
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'loans'),
      where('employeeId', '==', user.uid),
      orderBy('createdAt', 'desc'),
    );

    const unsub = onSnapshot(q, (snap) => {
      setLoans(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan)));
      setLoading(false);
    });

    return unsub;
  }, [user]);

  // Real-time repayments listener
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'repayments'),
      where('employeeId', '==', user.uid),
    );

    const unsub = onSnapshot(q, (snap) => {
      setRepayments(
        snap.docs.map((d) => ({ id: d.id, ...d.data() } as Repayment)),
      );
    });

    return unsub;
  }, [user]);

  // Group repayments by loanId
  const repaymentsByLoan = repayments.reduce<Record<string, Repayment[]>>(
    (acc, r) => {
      if (!acc[r.loanId]) acc[r.loanId] = [];
      acc[r.loanId].push(r);
      return acc;
    },
    {},
  );

  function repaymentTotal(loanId: string): number {
    return (repaymentsByLoan[loanId] || []).reduce(
      (sum, r) => sum + (r.amount || 0),
      0,
    );
  }

  function remainingBalance(loan: Loan): number {
    const total = loanTotal(loan);
    if (total <= 0) return 0;
    return Math.max(0, total - repaymentTotal(loan.id));
  }

  const toggleExpand = (loanId: string) => {
    setExpandedLoanId((prev) => (prev === loanId ? null : loanId));
  };

  // Summary stats
  const activeLoans = loans.filter((l) =>
    ['pending', 'under_review', 'approved', 'disbursed', 'active', 'overdue'].includes(l.status),
  );
  const totalOutstanding = activeLoans.reduce(
    (sum, l) => sum + remainingBalance(l),
    0,
  );
  const totalRepaid = repayments.reduce((sum, r) => sum + (r.amount || 0), 0);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
        <span
          className="spinner"
          style={{
            borderColor: 'rgba(25,68,69,0.1)',
            borderTopColor: 'var(--brand)',
          }}
        />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="dash-header">
        <h1>{t('dash_my_loans', 'My Loans')}</h1>
      </div>

      <div className="dash-content">
        {/* Summary Stats */}
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-label">
              {t('loans_total_loans', 'Total Loans')}
            </div>
            <div className="stat-value">{loans.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              {t('loans_active', 'Active')}
            </div>
            <div className="stat-value">{activeLoans.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              {t('loans_outstanding', 'Outstanding')}
            </div>
            <div className="stat-value">${fmt(totalOutstanding)}</div>
            <div className="stat-change">MXN</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              {t('loans_total_repaid', 'Total Repaid')}
            </div>
            <div className="stat-value">${fmt(totalRepaid)}</div>
            <div className="stat-change">MXN</div>
          </div>
        </div>

        {/* Loans List */}
        <div className="card">
          <div className="card-title">
            {t('loans_history', 'Loan History')}
          </div>

          {loans.length === 0 ? (
            <div className="empty-state">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              >
                <rect x="2" y="6" width="20" height="12" rx="2" />
                <path d="M2 10h20" />
              </svg>
              <p>{t('dash_no_loans_employee', 'No active loans.')}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('dash_th_amount', 'Amount')}</th>
                    <th>{t('dash_th_status', 'Status')}</th>
                    <th>{t('loans_th_disbursed', 'Disbursed')}</th>
                    <th>{t('modal_due_date', 'Due Date')}</th>
                    <th>{t('loans_th_balance', 'Balance')}</th>
                    <th>{t('dash_th_action', 'Action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loans.map((loan) => {
                    const loanRepayments = repaymentsByLoan[loan.id] || [];
                    const isExpanded = expandedLoanId === loan.id;
                    const balance = remainingBalance(loan);

                    return (
                      <LoanRow
                        key={loan.id}
                        loan={loan}
                        balance={balance}
                        repayments={loanRepayments}
                        isExpanded={isExpanded}
                        onToggle={() => toggleExpand(loan.id)}
                        t={t}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PayButton({ loanId, t }: { loanId: string; t: ReturnType<typeof useTranslation>['t'] }) {
  const [loading, setLoading] = useState(false);
  const [payUrl, setPayUrl] = useState('');
  const [error, setError] = useState('');

  const handlePay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (payUrl) {
      window.open(payUrl, '_blank');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const functions = getFunctions();
      const genPayLink = httpsCallable<{ loanId: string }, { paymentUrl: string }>(functions, 'generatePaymentLink');
      const result = await genPayLink({ loanId });
      setPayUrl(result.data.paymentUrl);
      window.open(result.data.paymentUrl, '_blank');
    } catch (err) {
      const code = classifyError(err);
      setError(code === 'generic' ? t('dash_pay_error', 'Error') : friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        onClick={handlePay}
        disabled={loading}
        aria-busy={loading}
        className="btn-sm btn-approve"
      >
        {loading ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span className="sr-only">{t('a11y_loading')}</span>
          </>
        ) : (
          t('dash_pay_now', 'Pagar')
        )}
      </button>
      {error && <span style={{ fontSize: 10, color: 'var(--danger)' }}>{error}</span>}
    </div>
  );
}

function LoanRow({
  loan,
  balance,
  repayments,
  isExpanded,
  onToggle,
  t,
}: {
  loan: Loan;
  balance: number;
  repayments: Repayment[];
  isExpanded: boolean;
  onToggle: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const hasPending = repayments.some((r) => r.status === 'pending');
  const hasProcessing = repayments.some((r) => r.status === 'processing');

  return (
    <>
      <tr
        onClick={onToggle}
        style={{ cursor: 'pointer' }}
      >
        <td style={{ fontWeight: 500 }}>
          ${fmt(loanPrincipal(loan))}
          <span style={{ fontSize: 11, color: 'var(--t2)', marginLeft: 4 }}>
            MXN
          </span>
        </td>
        <td>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            <span className={`badge badge-${loan.status}`}>
              {t(`status_${loan.status}`, loan.status)}
            </span>
            {hasPending && (
              <span className="badge badge-pending" style={{ fontSize: 10 }}>
                {t('pay_status_pending', 'Pending')}
              </span>
            )}
            {hasProcessing && (
              <span className="badge badge-approved" style={{ fontSize: 10 }}>
                {t('pay_status_processing', 'Processing')}
              </span>
            )}
          </div>
        </td>
        <td>{fmtDate(loan.disbursedAt)}</td>
        <td>{fmtDate(loan.dueDate)}</td>
        <td style={{ fontWeight: 600 }}>
          {loanTotal(loan) > 0 ? `$${fmt(balance)}` : '—'}
        </td>
        <td>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {['active', 'overdue'].includes(loan.status) && (
              <PayButton loanId={loan.id} t={t} />
            )}
            {loan.contractUrl && (
              <a
                href={loan.contractUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="doc-link"
                onClick={(e) => e.stopPropagation()}
              >
                {t('loans_download_contract', 'Contract')}
              </a>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 16,
                color: 'var(--t3)',
                padding: '4px 8px',
                transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
              }}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              ▾
            </button>
          </div>
        </td>
      </tr>

      {/* Expanded detail row */}
      {isExpanded && (
        <tr>
          <td colSpan={6} style={{ padding: 0, border: 'none' }}>
            <div
              style={{
                background: 'rgba(25,68,69,0.015)',
                borderRadius: 12,
                padding: '20px 24px',
                margin: '4px 0 12px',
              }}
            >
              {/* Loan details */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                  gap: 16,
                  marginBottom: repayments.length > 0 ? 20 : 0,
                }}
              >
                <DetailItem
                  label={t('loans_principal', 'Principal')}
                  value={`$${fmt(loanPrincipal(loan))}`}
                />
                <DetailItem
                  label={t('modal_fee', 'Fee')}
                  value={
                    loan.feeAmount != null ? `$${fmt(loan.feeAmount)}` : '—'
                  }
                />
                <DetailItem
                  label={t('modal_total', 'Total Owed')}
                  value={
                    loanTotal(loan) > 0 ? `$${fmt(loanTotal(loan))}` : '—'
                  }
                />
                <DetailItem
                  label={t('dash_th_term', 'Term')}
                  value={`${loan.termDays ?? 30} ${t('dash_days', 'days')}`}
                />
                <DetailItem
                  label={t('loans_requested', 'Requested')}
                  value={fmtDate(loan.requestedAt || loan.createdAt)}
                />
                {loan.loanPurpose && (
                  <DetailItem
                    label={t('modal_purpose_label', 'Purpose')}
                    value={t(
                      `modal_purpose_${loan.loanPurpose}`,
                      loan.loanPurpose,
                    )}
                  />
                )}
              </div>

              {/* Repayment history */}
              {repayments.length > 0 && (
                <div>
                  <div
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      textTransform: 'uppercase' as const,
                      letterSpacing: 2.2,
                      color: 'var(--gold)',
                      marginBottom: 12,
                    }}
                  >
                    {t('loans_repayment_history', 'Repayment History')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {repayments
                      .sort((a, b) => {
                        const aTime = (a.paidAt || a.createdAt)?.seconds ?? 0;
                        const bTime = (b.paidAt || b.createdAt)?.seconds ?? 0;
                        return bTime - aTime;
                      })
                      .map((r) => (
                        <div
                          key={r.id}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '10px 14px',
                            background: '#fff',
                            borderRadius: 10,
                            border: '1px solid rgba(25,68,69,0.04)',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span
                              style={{
                                fontSize: 14,
                                fontWeight: 600,
                                color: 'var(--t1)',
                              }}
                            >
                              ${fmt(r.amount)}
                            </span>
                            {r.method && (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: 'var(--t3)',
                                }}
                              >
                                {r.method}
                              </span>
                            )}
                            {r.status && (
                              <span
                                className={`badge ${
                                  r.status === 'completed'
                                    ? 'badge-repaid'
                                    : r.status === 'processing'
                                      ? 'badge-approved'
                                      : 'badge-pending'
                                }`}
                                style={{ fontSize: 10 }}
                              >
                                {t(
                                  `pay_status_${r.status}`,
                                  r.status === 'completed'
                                    ? 'Paid'
                                    : r.status === 'processing'
                                      ? 'Processing'
                                      : 'Pending',
                                )}
                              </span>
                            )}
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--t3)' }}>
                            {fmtDate(r.paidAt || r.createdAt)}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DetailItem({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: 'uppercase' as const,
          letterSpacing: 2,
          color: 'var(--t2)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--t1)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
