import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { collection, getDocs } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { friendlyError } from '../lib/errors';
import { formatCents } from '../lib/money';
import {
  classifyRemittanceError,
  formatIsoDate,
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

interface ListQuery {
  view: 'outstanding' | 'all';
  overdueOnly: boolean;
  /** Bumped to re-run the same query (refresh button, after a write). */
  nonce: number;
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
 */
export function PayrollRemittances() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'en' ? 'en-US' : 'es-MX';

  const [query, setQuery] = useState<ListQuery>({ view: 'outstanding', overdueOnly: false, nonce: 0 });
  const [data, setData] = useState<ListRemittancesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [employerNames, setEmployerNames] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [recording, setRecording] = useState<Remittance | null>(null);
  const [voiding, setVoiding] = useState<{ remittance: Remittance; receipt: RemittanceReceipt } | null>(null);

  // Every change to `query` is a new request. The cleanup flag is what stops
  // a slow answer to an older query (a filter the user has since left) from
  // overwriting the newer one.
  useEffect(() => {
    let stale = false;
    const fn = httpsCallable<ListRemittancesInput, ListRemittancesResult>(getFunctions(), 'listPayrollRemittances');
    const input: ListRemittancesInput = { view: query.view };
    if (query.overdueOnly) input.overdueOnly = true;
    fn(input)
      .then((result) => {
        if (stale) return;
        setData(result.data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (stale) return;
        const kind = classifyRemittanceError(err);
        setLoadError(kind.kind === 'invalid' ? kind.detail : friendlyError(err));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [query]);

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

  const runQuery = (next: Partial<Omit<ListQuery, 'nonce'>>) => {
    setLoading(true);
    setQuery((q) => ({ ...q, ...next, nonce: q.nonce + 1 }));
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
    runQuery({});
  };

  const onVoided = (result: VoidReceiptResult) => {
    setVoiding(null);
    setToast(
      t(result.alreadyVoided ? 'remit_toast_already_voided' : 'remit_toast_voided', { status: statusLabel(result.status) }),
    );
    runQuery({});
  };

  const remittances = data?.remittances ?? [];
  const totals = data?.totals;
  const emptyKey = query.overdueOnly ? 'remit_empty_overdue' : query.view === 'all' ? 'remit_empty_all' : 'remit_empty_outstanding';

  /* ── render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="ops-page">
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_ops')}</div>
          <h1 className="ops-title">{t('remit_title')}</h1>
          <p className="ops-sub">{t('remit_subtitle')}</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <button type="button" className="ops-go" style={{ marginTop: 0 }} onClick={() => runQuery({})} disabled={loading}>
            <i aria-hidden="true" />{loading ? t('remit_refreshing') : t('remit_refresh')}
          </button>
        </div>
      </div>

      {toast && (
        <div role="status" className="ops-toast success">{toast}</div>
      )}

      {loadError && (
        <div role="alert" className="ops-toast error">
          {t('remit_load_error', { detail: loadError })}{' '}
          <button type="button" className="ops-btn sm ghost" onClick={() => runQuery({})} disabled={loading}>
            {t('remit_retry')}
          </button>
        </div>
      )}

      <div className="ops-kpis four" style={{ marginTop: 0, marginBottom: 10 }}>
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

      <div className="ops-card quiet" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '14px 16px' }}>
        <span className="ops-label">{t('remit_filter_label')}</span>
        <div className="ops-chips">
          <button
            type="button"
            className={`ops-chip${query.view === 'outstanding' ? ' on' : ''}`}
            aria-pressed={query.view === 'outstanding'}
            onClick={() => runQuery({ view: 'outstanding' })}
          >
            {t('remit_filter_outstanding')}
          </button>
          <button
            type="button"
            className={`ops-chip${query.view === 'all' ? ' on' : ''}`}
            aria-pressed={query.view === 'all'}
            onClick={() => runQuery({ view: 'all' })}
          >
            {t('remit_filter_all')}
          </button>
          <button
            type="button"
            className={`ops-chip${query.overdueOnly ? ' on' : ''}`}
            aria-pressed={query.overdueOnly}
            onClick={() => runQuery({ overdueOnly: !query.overdueOnly })}
          >
            {t('remit_filter_overdue')}
          </button>
        </div>
      </div>

      <section className="ops-card" aria-busy={loading}>
        {loading && !data && (
          <div className="empty-state">
            <p>{t('remit_loading')}</p>
          </div>
        )}

        {data && remittances.length === 0 && (
          <div className="empty-state">
            <p>{t(emptyKey)}</p>
          </div>
        )}

        {data && remittances.length > 0 && (
          <>
            <h2 className="ops-h3">{t('remit_list_title', { count: remittances.length })}</h2>
            <p className="ops-note" style={{ marginBottom: 12 }}>
              {t('remit_as_of', { date: formatIsoDate(data.asOf, locale), days: data.graceDays })}
            </p>
            {data.truncated && (
              <p role="status" className="ops-toast">{t('remit_truncated')}</p>
            )}
          </>
        )}

        {remittances.map((r) => {
          const aging = agingLabel(r);
          const period =
            r.payPeriodStart || r.payPeriodEnd
              ? t('remit_period', { start: formatIsoDate(r.payPeriodStart, locale), end: formatIsoDate(r.payPeriodEnd, locale) })
              : t('remit_period_unknown');

          return (
            <div
              key={r.batchId}
              className="ops-batch"
              data-testid={`remittance-${r.batchId}`}
              style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}
            >
              {/* Folder glyph is green only once the money has fully arrived */}
              <span className={`fl${r.status === 'received' ? ' g' : ''}`} aria-hidden="true" style={{ marginTop: 2 }} />
              <span className="t" style={{ whiteSpace: 'normal', flex: '1 1 240px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 500 }}>{employerLabel(r)}</span>
                  <span className={`ops-status${statusClass(r.status)}`}>{statusLabel(r.status)}</span>
                  {aging && <span className={`ops-status${agingClass(r)}`}>{aging}</span>}
                </span>
                <small style={{ whiteSpace: 'normal' }}>{period}</small>
                <small style={{ whiteSpace: 'normal' }}>
                  {t('remit_batch', { batch: r.batchId })} · {t('remit_deductions', { count: r.deductionCount })}
                </small>
              </span>

              <span className="p">{money(r.expectedCents)}<small>{t('remit_col_expected')}</small></span>
              <span className="p">{money(r.receivedCents)}<small>{t('remit_col_received')}</small></span>
              <span className="p" style={r.aging.overdue ? { color: '#f2c4a0' } : undefined}>
                {money(r.aging.outstandingCents)}<small>{t('remit_col_outstanding')}</small>
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

              <div style={{ flex: '1 1 100%', paddingLeft: 44 }}>
                {r.receipts.length === 0 ? (
                  <p className="ops-note">{t('remit_receipts_none')}</p>
                ) : (
                  <>
                    <p className="ops-label" style={{ margin: '4px 0 6px' }}>{t('remit_receipts_title')}</p>
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {r.receipts.map((receipt) => {
                        const reference = receipt.bankReference ?? t('remit_receipt_no_reference');
                        return (
                          <li
                            key={receipt.receiptId}
                            data-testid={`receipt-${receipt.receiptId}`}
                            data-voided={receipt.voided ? 'true' : 'false'}
                            style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid rgba(255,255,255,.06)', fontSize: 13 }}
                          >
                            <span
                              style={{
                                fontVariantNumeric: 'tabular-nums',
                                minWidth: 110,
                                ...(receipt.voided ? { textDecoration: 'line-through', opacity: 0.7 } : {}),
                              }}
                            >
                              {money(receipt.amountCents)}
                            </span>
                            <span style={receipt.voided ? { opacity: 0.7 } : undefined}>{formatIsoDate(receipt.receivedOn, locale)}</span>
                            <span className="ops-status mono">{t('remit_receipt_reference', { reference })}</span>
                            {receipt.voided ? (
                              <>
                                <span className="ops-status bad">{t('remit_receipt_voided')}</span>
                                <span className="ops-note" style={{ flex: '1 1 100%' }}>
                                  {receipt.voidReason && t('remit_receipt_void_reason', { reason: receipt.voidReason })}
                                  {receipt.voidReason && receipt.voidedAt && ' · '}
                                  {receipt.voidedAt && t('remit_receipt_voided_on', { date: formatIsoDate(receipt.voidedAt, locale) })}
                                </span>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="ops-btn sm ghost danger"
                                style={{ marginLeft: 'auto' }}
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
