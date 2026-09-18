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
import { OUTSTANDING_STATUSES } from '../lib/loanStatus';
import { useAuth } from '../hooks/useAuth';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { costLine, fmtShortDate, initials } from '../components/employee/types';
import type { ScheduledDeduction } from '../components/employee/types';

interface Loan {
  id: string;
  principalAmount?: number;
  amount?: number;
  fee?: number;
  totalRepaymentAmount?: number;
  total?: number;
  status: string;
  createdAt?: { seconds: number };
  requestedAt?: { seconds: number };
  disbursedAt?: { seconds: number };
  dueDate?: { seconds: number };
  contractUrl?: string;
  term?: number;
  currency?: string;
  loanPurpose?: string;
  // Cost fields written once at requestLoan time (functions/src/index.ts) and
  // READ here for the disclosure line — never recomputed.
  catPercent?: number;
  repaymentSchedule?: ScheduledDeduction[];
  employerName?: string;
  borrowerSnapshot?: { payFrequency?: string };
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

/** The statuses generatePaymentLink.ts accepts — the only ones that get Pagar. */
const PAYABLE_STATUSES = ['active', 'overdue', 'disbursed'];

/** Which scheduled deductions the money already paid covers, in order. */
function scheduleSteps(schedule: ScheduledDeduction[] | undefined, paid: number) {
  if (!schedule || schedule.length === 0) return [];
  let cumulative = 0;
  let nextFound = false;
  return schedule.map((s) => {
    cumulative += s.amount || 0;
    const done = paid >= cumulative - 0.005;
    const now = !done && !nextFound;
    if (now) nextFound = true;
    return { ...s, done, now };
  });
}

export function MyLoans() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();

  const [loans, setLoans] = useState<Loan[]>([]);
  const [repayments, setRepayments] = useState<Repayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loansError, setLoansError] = useState('');
  const [repaymentsError, setRepaymentsError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const [expandedLoanId, setExpandedLoanId] = useState<string | null>(null);

  // Errors are cleared here, in the event handler, rather than in the effect
  // bodies below: a synchronous setState inside an effect triggers a cascading
  // re-render (`react-hooks/set-state-in-effect`, a CI-blocking lint error).
  // Each listener's success callback clears its own error too, so a failure
  // that resolves on its own also clears without a click.
  const retry = () => {
    setLoansError('');
    setRepaymentsError('');
    setRetryToken((n) => n + 1);
  };

  // Real-time loans listener. Without an error callback here, a permission
  // error, a missing index or an offline client left `loading` stuck at
  // `true` forever — indistinguishable from "still loading" (F7).
  useEffect(() => {
    if (!user) return;

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
  }, [user, retryToken]);

  // Real-time repayments listener. A failure here doesn't block the page —
  // the loans list is still usable — but it silently understates every
  // balance and "Total Repaid" figure, so it needs its own visible error.
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'repayments'),
      where('employeeId', '==', user.uid),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        setRepayments(
          snap.docs.map((d) => ({ id: d.id, ...d.data() } as Repayment)),
        );
        setRepaymentsError('');
      },
      (err) => setRepaymentsError(friendlyError(err)),
    );

    return unsub;
  }, [user, retryToken]);

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
  const activeLoans = loans.filter((l) => OUTSTANDING_STATUSES.includes(l.status));
  const totalOutstanding = activeLoans.reduce(
    (sum, l) => sum + remainingBalance(l),
    0,
  );
  const totalRepaid = repayments.reduce((sum, r) => sum + (r.amount || 0), 0);

  // The board: the credit still being repaid (newest first, as the listener
  // orders them). Everything else is history below it.
  const featured = activeLoans[0];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
        <span
          className="spinner"
          style={{ borderColor: 'rgba(30,32,29,0.1)', borderTopColor: 'var(--ink)' }}
        />
      </div>
    );
  }

  if (loansError) {
    return (
      <div className="bo-screen paper" style={{ minHeight: 0 }}>
        <ErrorBanner message={loansError} style={{ textAlign: 'left', marginBottom: 16 }} />
        <div>
          <button type="button" onClick={retry} className="bo-ghost">
            {t('loans_retry', 'Reintentar')}
          </button>
        </div>
      </div>
    );
  }

  const avatar = initials(user?.displayName || user?.email?.split('@')[0], 'FP');

  return (
    <div className="bo-screen paper wide">
      {/* Header */}
      <div className="bo-head">
        <span className="dot">{t('dash_my_loans')}</span>
        <span className="bo-av">{avatar}</span>
      </div>

      {repaymentsError && (
        <div style={{ marginTop: 16 }}>
          <ErrorBanner
            style={{ borderRadius: 20, background: '#fbeeed', border: '1px solid rgba(139,32,32,.12)', color: '#8b2020' }}
            message={t(
              'loans_repayments_error',
              'No pudimos cargar tu historial de pagos. Los saldos mostrados podrían estar incompletos.',
            )}
          />
          <button type="button" onClick={retry} className="bo-btn text" style={{ marginTop: 6 }}>
            {t('loans_retry', 'Reintentar')}
          </button>
        </div>
      )}

      {featured ? (
        <RepaymentBoard
          loan={featured}
          paid={repaymentTotal(featured.id)}
          remaining={remainingBalance(featured)}
          t={t}
          lang={i18n.language}
        />
      ) : (
        <div className="bo-center">
          <h2 className="money">{fmt(totalRepaid)}<small style={{ fontSize: 18, fontWeight: 300, color: 'var(--ink-soft)', marginLeft: 6 }}>MXN</small></h2>
          <p>{loans.length === 0 ? t('dash_no_loans_employee') : t('loans_all_settled')}</p>
        </div>
      )}

      {/* History */}
      <div className="bo-history">
        <span className="dot">{t('loans_history', 'Historial')}</span>
        {loans.length > 0 && (
          <p className="bo-note" style={{ marginTop: 4 }}>
            {t('loans_summary_line', {
              count: loans.length,
              outstanding: fmt(totalOutstanding),
              repaid: fmt(totalRepaid),
            })}
          </p>
        )}

        {loans.length === 0 ? (
          <div className="bo-empty">{t('dash_no_loans_employee')}</div>
        ) : (
          <div className="bo-table-wrap">
            <table className="bo-table">
              <thead>
                <tr>
                  <th>{t('dash_th_amount', 'Monto')}</th>
                  <th>{t('dash_th_status', 'Estado')}</th>
                  <th>{t('loans_th_disbursed', 'Desembolso')}</th>
                  <th>{t('modal_due_date', 'Vence')}</th>
                  <th>{t('loans_th_balance', 'Saldo')}</th>
                  <th>{t('dash_th_action', 'Acción')}</th>
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
                      // The featured credit's Pagar lives on the board above —
                      // one green control per screen, and the count of Pagar
                      // controls on the page stays one per payable loan.
                      payOnBoard={featured?.id === loan.id}
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
  );
}

/**
 * The Repayment board: amount as the 40px title, the term as the quiet second
 * line, a summary naming the employer as the deductor and stating the early
 * payoff terms exactly as the loan data has them (the fee is fixed at request
 * time, so paying early changes nothing about the total), the disclosure line,
 * then the scheduled deductions as pills — done, now, upcoming.
 */
function RepaymentBoard({
  loan,
  paid,
  remaining,
  t,
  lang,
}: {
  loan: Loan;
  paid: number;
  remaining: number;
  t: ReturnType<typeof useTranslation>['t'];
  lang: string;
}) {
  const total = loanTotal(loan);
  const steps = scheduleSteps(loan.repaymentSchedule, paid);
  const next = steps.find((s) => s.now) ?? null;
  const nextDate = next ? fmtShortDate(next.dueDate ?? loan.dueDate, lang) : null;
  const quincenal = loan.borrowerSnapshot?.payFrequency === 'semimonthly';
  const employer = loan.employerName || t('dash_your_employer');
  const cat = typeof loan.catPercent === 'number' ? loan.catPercent : null;

  const first = steps[0] ? fmtShortDate(steps[0].dueDate, lang) : null;
  const last = steps[steps.length - 1] ? fmtShortDate(steps[steps.length - 1].dueDate, lang) : null;
  const dueDate = fmtShortDate(loan.dueDate, lang);
  const termLine =
    steps.length > 0
      ? `${
          steps.length === 1
            ? t(quincenal ? 'loans_term_one_quincena' : 'loans_term_one')
            : t(quincenal ? 'loans_term_quincenas' : 'loans_term_many', { count: steps.length })
        } · ${steps.length === 1 || !first || !last || first === last ? (first ?? dueDate ?? '') : `${first} – ${last}`}`
      : dueDate
        ? t('loans_plan_due', { date: dueDate })
        : t('wiz_term_pending');

  const shown = steps.slice(0, 4);
  const hidden = steps.slice(4);
  const hiddenAmount = hidden.reduce((s, x) => s + (x.amount || 0), 0);

  return (
    <>
      <h2 className="bo-plan-title money">
        {fmt(loanPrincipal(loan))}<small>MXN</small>
        <span>{termLine}</span>
      </h2>

      <p className="bo-plan-sum">
        <b>{t('loans_sum_deductor', { employer })}</b> {t('loans_sum_before')}{' '}
        <b>
          {next && nextDate
            ? t('loans_sum_next', { amount: fmt(next.amount), date: nextDate })
            : t('loans_sum_remaining', { amount: fmt(remaining) })}
        </b>{' '}
        {total > 0 ? t('loans_sum_early', { total: fmt(total) }) : t('loans_sum_early_no_total')}
      </p>

      <p className="bo-disc">
        <b>{t('cost_label')}</b>{' '}
        {costLine(t, {
          total: total > 0 ? total : null,
          deduction: next ? next.amount : null,
          cat,
          quincenal,
        })}
      </p>

      {steps.length > 0 && (
        <div className="bo-timeline" aria-label={t('loans_repayment_history', 'Descuentos')}>
          {shown.map((s, i) => (
            <div key={s.number ?? i} className={`bo-step${s.done ? ' done' : s.now ? ' now' : ''}`}>
              <span className="d" aria-hidden="true">{s.done ? '✓' : s.number ?? i + 1}</span>
              <span className="l">
                {fmtShortDate(s.dueDate, lang) ?? '—'}
                <small>
                  {t(quincenal ? 'loans_step_quincena' : 'loans_step_deduction', { n: s.number ?? i + 1 })}
                  {s.now ? ` · ${t('loans_step_next')}` : ''}
                </small>
              </span>
              <span className="v money">{fmt(s.amount || 0)}</span>
            </div>
          ))}
          {hidden.length > 0 && (
            <div className="bo-step more">
              {t('loans_more_steps', { count: hidden.length, amount: fmt(hiddenAmount) })}
            </div>
          )}
        </div>
      )}

      {PAYABLE_STATUSES.includes(loan.status) && (
        <div className="bo-plan-actions">
          <PayButton loanId={loan.id} t={t} className="bo-cta money" label={t('loans_pay_amount', { amount: fmt(remaining) })} />
        </div>
      )}
    </>
  );
}

function PayButton({
  loanId,
  t,
  className = 'bo-btn light',
  label,
}: {
  loanId: string;
  t: ReturnType<typeof useTranslation>['t'];
  className?: string;
  label?: string;
}) {
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
        type="button"
        onClick={handlePay}
        disabled={loading}
        aria-busy={loading}
        className={className}
      >
        {loading ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span className="sr-only">{t('a11y_loading')}</span>
          </>
        ) : (
          label ?? t('dash_pay_now', 'Pagar')
        )}
      </button>
      {error && <span className="bo-pay-err">{error}</span>}
    </div>
  );
}

function LoanRow({
  loan,
  balance,
  repayments,
  isExpanded,
  onToggle,
  payOnBoard,
  t,
}: {
  loan: Loan;
  balance: number;
  repayments: Repayment[];
  isExpanded: boolean;
  onToggle: () => void;
  payOnBoard: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const hasPending = repayments.some((r) => r.status === 'pending');
  const hasProcessing = repayments.some((r) => r.status === 'processing');

  return (
    <>
      <tr onClick={onToggle} className={`bo-tr${isExpanded ? ' open' : ''}`}>
        <td className="money" style={{ fontWeight: 600 }}>
          ${fmt(loanPrincipal(loan))}
          <span style={{ fontSize: 11, color: 'var(--ink-soft)', marginLeft: 4 }}>
            MXN
          </span>
        </td>
        <td>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            <span className={`bo-badge ${loan.status}`}>
              {t(`status_${loan.status}`, loan.status)}
            </span>
            {hasPending && (
              <span className="bo-badge">
                {t('pay_status_pending', 'Pendiente')}
              </span>
            )}
            {hasProcessing && (
              <span className="bo-badge">
                {t('pay_status_processing', 'Procesando')}
              </span>
            )}
          </div>
        </td>
        <td>{fmtDate(loan.disbursedAt)}</td>
        <td>{fmtDate(loan.dueDate)}</td>
        <td className="money" style={{ fontWeight: 600 }}>
          {loanTotal(loan) > 0 ? `$${fmt(balance)}` : '—'}
        </td>
        <td>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
            {!payOnBoard && PAYABLE_STATUSES.includes(loan.status) && (
              <PayButton loanId={loan.id} t={t} />
            )}
            {loan.contractUrl && (
              <a
                href={loan.contractUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="bo-btn text"
                onClick={(e) => e.stopPropagation()}
              >
                {t('loans_download_contract', 'Contrato')}
              </a>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className={`bo-chev${isExpanded ? ' open' : ''}`}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? t('loans_collapse') : t('loans_expand')}
            >
              ▾
            </button>
          </div>
        </td>
      </tr>

      {/* Expanded detail row */}
      {isExpanded && (
        <tr>
          <td colSpan={6} className="detail">
            <div className="bo-detail">
              <DetailItem
                label={t('loans_principal', 'Principal')}
                value={`$${fmt(loanPrincipal(loan))}`}
              />
              <DetailItem
                label={t('modal_fee', 'Comisión')}
                value={
                  loan.fee != null ? `$${fmt(loan.fee)}` : '—'
                }
              />
              <DetailItem
                label={t('modal_total', 'Total a pagar')}
                value={
                  loanTotal(loan) > 0 ? `$${fmt(loanTotal(loan))}` : '—'
                }
              />
              <DetailItem
                label={t('dash_th_term', 'Plazo')}
                value={`${loan.term ?? 30} ${t('dash_days', 'días')}`}
              />
              <DetailItem
                label={t('loans_requested', 'Solicitado')}
                value={fmtDate(loan.requestedAt || loan.createdAt)}
              />
              {typeof loan.catPercent === 'number' && (
                <DetailItem
                  label={t('modal_cat_label')}
                  value={`${loan.catPercent}% · ${t('cost_cat_suffix')}`}
                />
              )}
              {loan.loanPurpose && (
                <DetailItem
                  label={t('modal_purpose_label', 'Propósito')}
                  value={t(
                    `modal_purpose_${loan.loanPurpose}`,
                    loan.loanPurpose,
                  )}
                />
              )}
            </div>

            {/* Repayment history */}
            {repayments.length > 0 && (
              <div className="bo-hist">
                <span className="dot">{t('loans_repayment_history', 'Historial de pagos')}</span>
                {repayments
                  .sort((a, b) => {
                    const aTime = (a.paidAt || a.createdAt)?.seconds ?? 0;
                    const bTime = (b.paidAt || b.createdAt)?.seconds ?? 0;
                    return bTime - aTime;
                  })
                  .map((r) => (
                    <div key={r.id} className="bo-hrow">
                      <div className="meta">
                        <span className="money" style={{ fontWeight: 600 }}>
                          ${fmt(r.amount)}
                        </span>
                        {r.method && (
                          <span className="how">{r.method}</span>
                        )}
                        {r.status && (
                          <span className={`bo-badge${r.status === 'completed' ? ' paid' : ''}`}>
                            {t(
                              `pay_status_${r.status}`,
                              r.status === 'completed'
                                ? 'Pagado'
                                : r.status === 'processing'
                                  ? 'Procesando'
                                  : 'Pendiente',
                            )}
                          </span>
                        )}
                      </div>
                      <span className="when">
                        {fmtDate(r.paidAt || r.createdAt)}
                      </span>
                    </div>
                  ))}
              </div>
            )}
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
    <div className="bo-kv">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}
