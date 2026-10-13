import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { collection, getDocs } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { friendlyError } from '../lib/errors';
import { formatCents } from '../lib/money';
import {
  REMITTANCE_LIMIT_MAX,
  REMITTANCE_PAGE_SIZE,
  formatInstantInMexicoCity,
  formatIsoDate,
  readRemittanceRefusal,
  remittanceRefusalText,
  totalsOf,
  type ListRemittancesInput,
  type ListRemittancesResult,
  type RecordRemittanceResult,
  type Remittance,
  type RemittanceReceipt,
  type RemittanceStatus,
  type VoidReceiptResult,
} from '../lib/remittance';
import { RemittanceRecordDialog } from '../components/ops/RemittanceRecordDialog';
import { RemittanceVoidDialog } from '../components/ops/RemittanceVoidDialog';

/* ── helpers ──────────────────────────────────────────────────────────────── */

/**
 * One call to listPayrollRemittances. `cursor: null` is page one and replaces
 * the list; a cursor is "the page after what is on screen" and appends to it.
 */
interface ListRequest {
  view: 'outstanding' | 'all';
  overdueOnly: boolean;
  cursor: string | null;
  limit: number;
  /** Bumped so that asking for the same thing again is still a new request. */
  nonce: number;
}

/** What the last answered page said about the list as a whole. */
interface ListMeta {
  asOf: string;
  graceDays: number;
  nextCursor: string | null;
}

/** Green only for money that has fully arrived. */
function statusClass(status: RemittanceStatus): string {
  if (status === 'received') return ' g';
  if (status === 'partial' || status === 'overpaid') return ' warn';
  return '';
}

/** Up to 15 days late is a warning; beyond that it is the soft red. */
function agingClass(remittance: Remittance): string {
  if (!remittance.aging.overdue) return ' mute';
  return remittance.aging.bucket === 'overdue_1_15' ? ' warn' : ' bad';
}

const money = (cents: number) => `$${formatCents(cents)}`;

/* ── component ───────────────────────────────────────────────────────────── */

/**
 * Ops view of the payroll remittance ledger (E18): per batch, what payroll
 * deducted against what has reached the bank, how late the difference is, and
 * the receipts behind it. Recording and voiding go through callables; the page
 * never writes to Firestore itself.
 *
 * The list is paged by the server (one ordered query, `nextCursor`). The
 * figures at the top are sums of the rows on screen, and say so whenever
 * there is another page.
 */
export function PayrollRemittances() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'en' ? 'en-US' : 'es-MX';

  const [request, setRequest] = useState<ListRequest>({
    view: 'outstanding',
    overdueOnly: false,
    cursor: null,
    limit: REMITTANCE_PAGE_SIZE,
    nonce: 0,
  });
  const [rows, setRows] = useState<Remittance[] | null>(null);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [employerNames, setEmployerNames] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [recording, setRecording] = useState<Remittance | null>(null);
  const [voiding, setVoiding] = useState<{ remittance: Remittance; receipt: RemittanceReceipt } | null>(null);

  // Every change to `request` is a new call. The cleanup flag is what stops a
  // slow answer to an older request (a filter the user has since left, or a
  // "load more" for a list that has since been reloaded) from landing on top
  // of the newer one.
  useEffect(() => {
    let stale = false;
    const fn = httpsCallable<ListRemittancesInput, ListRemittancesResult>(getFunctions(), 'listPayrollRemittances');
    const input: ListRemittancesInput = { view: request.view, limit: request.limit };
    if (request.overdueOnly) input.overdueOnly = true;
    if (request.cursor !== null) input.cursor = request.cursor;
    const appending = request.cursor !== null;
    fn(input)
      .then((result) => {
        if (stale) return;
        const page = result.data;
        setRows((current) => {
          if (!appending || current === null) return page.remittances;
          // The server's order is total, so a page never repeats a row. The
          // filter is for the one case it cannot rule out: a record that moved
          // (its period dates were rewritten) between two pages.
          const seen = new Set(current.map((r) => r.batchId));
          return [...current, ...page.remittances.filter((r) => !seen.has(r.batchId))];
        });
        setMeta({ asOf: page.asOf, graceDays: page.graceDays, nextCursor: page.nextCursor ?? null });
        setLoadError(null);
        setMoreError(null);
      })
      .catch((err: unknown) => {
        if (stale) return;
        const text = remittanceRefusalText(readRemittanceRefusal(err), t, locale) ?? friendlyError(err);
        if (appending) setMoreError(text);
        else setLoadError(text);
      })
      .finally(() => {
        if (stale) return;
        setLoading(false);
        setLoadingMore(false);
      });
    return () => {
      stale = true;
    };
    // `t` and `locale` only word an error; a language switch must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // Employer names are a convenience over the ids the ledger stores. If the
  // read fails the list still works — it shows the id.
  useEffect(() => {
    let stale = false;
    getDocs(collection(db, 'employers'))
      .then((snap) => {
        if (stale) return;
        const names: Record<string, string> = {};
        snap.docs.forEach((d) => {
          const name = (d.data() as { companyName?: unknown }).companyName;
          if (typeof name === 'string' && name) names[d.id] = name;
        });
        setEmployerNames(names);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  /**
   * Page one again. A filter change starts from a fresh page; a refresh (or
   * the reload after a write) asks for as many rows as are already on screen,
   * so ops does not lose their place in a list they had paged through.
   */
  const reload = (filters: Partial<Pick<ListRequest, 'view' | 'overdueOnly'>> = {}) => {
    const filterChanged = Object.keys(filters).length > 0;
    const loaded = rows?.length ?? 0;
    const limit = filterChanged ? REMITTANCE_PAGE_SIZE : Math.min(REMITTANCE_LIMIT_MAX, Math.max(REMITTANCE_PAGE_SIZE, loaded));
    setLoading(true);
    setLoadingMore(false);
    setMoreError(null);
    setRequest((q) => ({ ...q, ...filters, cursor: null, limit, nonce: q.nonce + 1 }));
  };

  const loadMore = () => {
    const cursor = meta?.nextCursor;
    if (!cursor || loading || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    setRequest((q) => ({ ...q, cursor, limit: REMITTANCE_PAGE_SIZE, nonce: q.nonce + 1 }));
  };

  const employerLabel = (r: Remittance): string =>
    (r.employerId && employerNames[r.employerId]) || r.employerId || t('remit_employer_unknown');

  const statusLabel = (status: RemittanceStatus): string => t(`remit_status_${status}`);

  const agingLabel = (r: Remittance): string | null => {
    if (r.aging.bucket === 'settled') return null;
    if (r.aging.overdue) return t('remit_aging_overdue', { count: r.aging.daysOverdue });
    if (r.aging.daysSincePeriodEnd === null) return t('remit_aging_no_period');
    return t('remit_aging_current');
  };

  const onRecorded = (result: RecordRemittanceResult, amountCents: number) => {
    setRecording(null);
    setToast(t('remit_toast_recorded', { amount: formatCents(amountCents), status: statusLabel(result.status) }));
    reload();
  };

  const onVoided = (result: VoidReceiptResult) => {
    setVoiding(null);
    setToast(
      t(result.alreadyVoided ? 'remit_toast_already_voided' : 'remit_toast_voided', { status: statusLabel(result.status) }),
    );
    reload();
  };

  const remittances = rows ?? [];
  const totals = rows ? totalsOf(rows) : null;
  const hasMore = Boolean(meta?.nextCursor);
  // Oldest first whenever the list is outstanding-only; `overdueOnly` implies it.
  const oldestFirst = request.view === 'outstanding' || request.overdueOnly;
  const emptyKey = request.overdueOnly ? 'remit_empty_overdue' : request.view === 'all' ? 'remit_empty_all' : 'remit_empty_outstanding';

  /* ── render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="ops-page">
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_ops')}</div>
          <h1 className="ops-title">{t('remit_title')}</h1>
          <p className="ops-sub">{t('remit_subtitle')}</p>
        </div>
        <button type="button" className="ops-go flush" onClick={() => reload()} disabled={loading}>
          <i aria-hidden="true" />{loading ? t('remit_refreshing') : t('remit_refresh')}
        </button>
      </div>

      {toast && (
        <div role="status" className="ops-toast success">{toast}</div>
      )}

      {loadError && (
        <div role="alert" className="ops-toast error ops-toast-row">
          <span>{t('remit_load_error', { detail: loadError })}</span>
          <button type="button" className="ops-btn sm ghost" onClick={() => reload()} disabled={loading}>
            {t('remit_retry')}
          </button>
        </div>
      )}

      <div className="ops-kpis four flush">
        <div className="ops-kpi">
          <small>{t('remit_kpi_expected')}</small>
          <b>{totals ? money(totals.expectedCents) : '—'}</b>
        </div>
        <div className="ops-kpi">
          <small>{t('remit_kpi_received')}</small>
          <b>{totals ? money(totals.receivedCents) : '—'}</b>
        </div>
        <div className="ops-kpi">
          <small>{t('remit_kpi_outstanding')}</small>
          <b>{totals ? money(totals.outstandingCents) : '—'}</b>
        </div>
        <div className={`ops-kpi${totals && totals.overdueCount > 0 ? ' warn' : ''}`}>
          <small>{t('remit_kpi_overdue')}</small>
          <b>{totals ? money(totals.overdueCents) : '—'}</b>
          {totals && totals.overdueCount > 0 && <em>{t('remit_kpi_overdue_count', { count: totals.overdueCount })}</em>}
        </div>
      </div>

      {rows && hasMore && (
        <p role="status" className="ops-toast" data-testid="remit-totals-partial">{t('remit_totals_partial')}</p>
      )}

      <div className="ops-card quiet ops-filterbar">
        <span className="ops-label">{t('remit_filter_label')}</span>
        <div className="ops-chips">
          <button
            type="button"
            className={`ops-chip${request.view === 'outstanding' ? ' on' : ''}`}
            aria-pressed={request.view === 'outstanding'}
            onClick={() => reload({ view: 'outstanding' })}
          >
            {t('remit_filter_outstanding')}
          </button>
          <button
            type="button"
            className={`ops-chip${request.view === 'all' ? ' on' : ''}`}
            aria-pressed={request.view === 'all'}
            onClick={() => reload({ view: 'all' })}
          >
            {t('remit_filter_all')}
          </button>
          <button
            type="button"
            className={`ops-chip${request.overdueOnly ? ' on' : ''}`}
            aria-pressed={request.overdueOnly}
            onClick={() => reload({ overdueOnly: !request.overdueOnly })}
          >
            {t('remit_filter_overdue')}
          </button>
        </div>
      </div>

      <section className="ops-card" aria-busy={loading || loadingMore}>
        {loading && !rows && (
          <div className="empty-state">
            <p>{t('remit_loading')}</p>
          </div>
        )}

        {rows && meta && remittances.length === 0 && !hasMore && (
          <div className="empty-state">
            <p>{t(emptyKey)}</p>
          </div>
        )}

        {rows && meta && (remittances.length > 0 || hasMore) && (
          <>
            <h2 className="ops-h3">
              {t(hasMore ? 'remit_list_title_partial' : 'remit_list_title', { count: remittances.length })}
            </h2>
            <p className="ops-note ops-remit-asof">
              {t('remit_as_of', { date: formatIsoDate(meta.asOf, locale), days: meta.graceDays })}{' '}
              {t(oldestFirst ? 'remit_order_outstanding' : 'remit_order_all')}
            </p>
          </>
        )}

        {remittances.map((r) => {
          const aging = agingLabel(r);
          const period =
            r.payPeriodStart || r.payPeriodEnd
              ? t('remit_period', { start: formatIsoDate(r.payPeriodStart, locale), end: formatIsoDate(r.payPeriodEnd, locale) })
              : t('remit_period_unknown');

          return (
            <div key={r.batchId} className="ops-batch ops-remit" data-testid={`remittance-${r.batchId}`}>
              {/* Folder glyph is green only once the money has fully arrived */}
              <span className={`fl${r.status === 'received' ? ' g' : ''}`} aria-hidden="true" />
              <span className="t">
                <span className="ops-remit-head">
                  <b>{employerLabel(r)}</b>
                  <span className={`ops-status${statusClass(r.status)}`}>{statusLabel(r.status)}</span>
                  {aging && <span className={`ops-status${agingClass(r)}`}>{aging}</span>}
                </span>
                <small>{period}</small>
                <small>
                  {t('remit_batch', { batch: r.batchId })} · {t('remit_deductions', { count: r.deductionCount })}
                </small>
              </span>

              <span className="ops-remit-figures">
                <span className="p">{money(r.expectedCents)}<small>{t('remit_col_expected')}</small></span>
                <span className="p">{money(r.receivedCents)}<small>{t('remit_col_received')}</small></span>
                <span className={`p${r.aging.overdue ? ' late' : ''}`}>
                  {money(r.aging.outstandingCents)}<small>{t('remit_col_outstanding')}</small>
                </span>
              </span>

              <span className="ops-actions">
                <button
                  type="button"
                  className="ops-btn sm"
                  aria-label={t('remit_record_aria', { batch: r.batchId })}
                  onClick={() => { setToast(null); setRecording(r); }}
                >
                  {t('remit_record')}
                </button>
              </span>

              <div className="ops-remit-receipts">
                {r.receipts.length === 0 ? (
                  <p className="ops-note">{t('remit_receipts_none')}</p>
                ) : (
                  <>
                    <p className="ops-label">{t('remit_receipts_title')}</p>
                    <ul>
                      {r.receipts.map((receipt) => {
                        const reference = receipt.bankReference ?? t('remit_receipt_no_reference');
                        return (
                          <li
                            key={receipt.receiptId}
                            data-testid={`receipt-${receipt.receiptId}`}
                            data-voided={receipt.voided ? 'true' : 'false'}
                            className={receipt.voided ? 'voided' : undefined}
                          >
                            <span className="amt">{money(receipt.amountCents)}</span>
                            <span className="when">{formatIsoDate(receipt.receivedOn, locale)}</span>
                            <span className="ops-status mono ref">{t('remit_receipt_reference', { reference })}</span>
                            {receipt.voided ? (
                              <>
                                <span className="ops-status bad">{t('remit_receipt_voided')}</span>
                                <span className="ops-note why">
                                  {receipt.voidReason && t('remit_receipt_void_reason', { reason: receipt.voidReason })}
                                  {receipt.voidReason && receipt.voidedAt && ' · '}
                                  {/* An instant, shown as the day it was in Mexico City — not the UTC day. */}
                                  {receipt.voidedAt &&
                                    t('remit_receipt_voided_on', { date: formatInstantInMexicoCity(receipt.voidedAt, locale) })}
                                </span>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="ops-btn sm ghost danger void"
                                aria-label={t('remit_void_aria', { reference, batch: r.batchId })}
                                onClick={() => { setToast(null); setVoiding({ remittance: r, receipt }); }}
                              >
                                {t('remit_void')}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            </div>
          );
        })}

        {rows && (hasMore || moreError) && (
          <div className="ops-remit-more">
            {moreError && (
              <div role="alert" className="ops-toast error">{t('remit_load_more_error', { detail: moreError })}</div>
            )}
            <div className="ops-actions">
              {hasMore && (
                <button type="button" className="ops-btn" onClick={loadMore} disabled={loading || loadingMore}>
                  {loadingMore ? t('remit_loading_more') : t('remit_load_more')}
                </button>
              )}
              {moreError && (
                <button type="button" className="ops-btn ghost" onClick={() => reload()} disabled={loading}>
                  {t('remit_reload_from_start')}
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {recording && (
        <RemittanceRecordDialog
          remittance={recording}
          employerLabel={employerLabel(recording)}
          onClose={() => setRecording(null)}
          onRecorded={onRecorded}
        />
      )}

      {voiding && (
        <RemittanceVoidDialog
          remittance={voiding.remittance}
          receipt={voiding.receipt}
          onClose={() => setVoiding(null)}
          onVoided={onVoided}
        />
      )}
    </div>
  );
}
