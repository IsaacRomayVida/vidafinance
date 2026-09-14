import { useState, useCallback, useRef, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Papa from 'papaparse';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useAuth } from '../hooks/useAuth';

type PayrollRow = {
  employeeId: string;
  grossSalary: number;
  netSalary: number;
  payPeriod: string;
  deductionAmount?: number;
};

/** The row outcomes processPayroll returns (functions/src/payroll/processPayroll.ts). */
const ROW_STATUSES = ['deducted', 'skipped', 'error', 'already_processed'] as const;
type RowStatus = (typeof ROW_STATUSES)[number];

type RowResult = {
  employeeId: string;
  // Widened to `string`, deliberately: this is a value off the wire. The server
  // returned no `status` at all for a while, and i18next is configured with no
  // parseMissingKeyHandler (see i18n/index.ts), so `t('payroll_status_' + s)`
  // rendered the literal `payroll_status_undefined` in every badge. Anything
  // the client doesn't recognise now falls back to a generic label.
  status?: string;
  deductionAmount?: number;
  newBalance?: number;
  error?: string;
};

function isKnownRowStatus(status: string | undefined): status is RowStatus {
  return status != null && (ROW_STATUSES as readonly string[]).includes(status);
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const REQUIRED_HEADERS = ['employeeId', 'grossSalary', 'netSalary', 'payPeriod'];

export function PayrollUpload() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<PayrollRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [processing, setProcessing] = useState(false);
  const [results, setResults] = useState<RowResult[] | null>(null);
  const [apiError, setApiError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');

  const resetState = () => {
    setRows([]);
    setParseErrors([]);
    setPeriodStart('');
    setPeriodEnd('');
    setResults(null);
    setApiError('');
    setFileName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onFile = useCallback((file: File) => {
    if (file.size > MAX_FILE_SIZE) {
      setParseErrors([t('payroll_error_file_size')]);
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseErrors([t('payroll_error_file_type')]);
      return;
    }
    setFileName(file.name);
    setResults(null);
    setApiError('');

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        // Validate headers
        const headers = res.meta.fields || [];
        const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
        if (missing.length > 0) {
          setParseErrors([t('payroll_error_missing_cols', { cols: missing.join(', ') })]);
          setRows([]);
          return;
        }

        const errs: string[] = [];
        const parsed: PayrollRow[] = [];
        res.data.forEach((row, i) => {
          const lineNum = i + 2; // header is line 1
          const employeeId = (row.employeeId || '').trim();
          const gross = parseFloat(row.grossSalary || '');
          const net = parseFloat(row.netSalary || '');
          const period = (row.payPeriod || '').trim();
          const dedStr = (row.deductionAmount || '').trim();
          const ded = dedStr ? parseFloat(dedStr) : undefined;

          if (!employeeId) {
            errs.push(t('payroll_error_row', { line: lineNum, msg: t('payroll_error_empty_id') }));
          } else if (!Number.isFinite(gross) || gross <= 0) {
            errs.push(t('payroll_error_row', { line: lineNum, msg: t('payroll_error_invalid_gross') }));
          } else if (!Number.isFinite(net) || net <= 0) {
            errs.push(t('payroll_error_row', { line: lineNum, msg: t('payroll_error_invalid_net') }));
          } else if (!period) {
            errs.push(t('payroll_error_row', { line: lineNum, msg: t('payroll_error_empty_period') }));
          } else if (ded !== undefined && (!Number.isFinite(ded) || ded < 0)) {
            errs.push(t('payroll_error_row', { line: lineNum, msg: t('payroll_error_invalid_deduction') }));
          } else {
            parsed.push({ employeeId, grossSalary: gross, netSalary: net, payPeriod: period, deductionAmount: ded });
          }
        });
        setRows(parsed);
        setParseErrors(errs);
      },
      error: (e) => {
        setParseErrors([t('payroll_error_parse', { msg: e.message })]);
        setRows([]);
      },
    });
  }, [t]);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }, [onFile]);

  const submit = async () => {
    if (!rows.length) return;
    if (!periodStart || !periodEnd) {
      setApiError(t('payroll_error_dates'));
      return;
    }
    setProcessing(true);
    setApiError('');
    setResults(null);
    try {
      const fn = httpsCallable<
        { employerId: string; payPeriodStart: string; payPeriodEnd: string; rows: PayrollRow[] },
        { processedCount: number; results: RowResult[] }
      >(getFunctions(), 'processPayroll');
      const out = await fn({ employerId: user!.uid, payPeriodStart: periodStart, payPeriodEnd: periodEnd, rows });
      setResults(out.data.results);
    } catch (e: unknown) {
      setApiError(e instanceof Error ? e.message : t('payroll_error_unknown'));
    } finally {
      setProcessing(false);
    }
  };

  const deductedCount = results?.filter(r => r.status === 'deducted').length ?? 0;
  const skippedCount = results?.filter(r => r.status === 'skipped').length ?? 0;
  const errorCount = results?.filter(r => r.status === 'error').length ?? 0;
  const totalDeducted = results
    ?.filter(r => r.status === 'deducted')
    .reduce((sum, r) => sum + (r.deductionAmount ?? 0), 0) ?? 0;

  const canSubmit = !processing && !!periodStart && !!periodEnd;

  return (
    <div className="ops-page">
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_payroll')}</div>
          <h1 className="ops-title">{t('payroll_title')}</h1>
          <p className="ops-sub">{t('payroll_subtitle')}</p>
        </div>
      </div>

      {!results && (
        <>
          {/* Drop zone \u2014 the folder glyph turns green once a file is received */}
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`ops-drop${dragging ? ' on' : ''}${fileName ? ' has' : ''}`}
            style={{ marginBottom: 10 }}
          >
            <span className={`ops-file${fileName ? ' g' : ''}`} aria-hidden="true" />
            <b>{fileName || t('payroll_drop_label')}</b>
            <small>{t('payroll_drop_hint')}</small>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              aria-label={t('payroll_drop_label')}
              style={{ display: 'none' }}
              onChange={e => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </div>

          {/* Parse errors */}
          {parseErrors.length > 0 && (
            <div className="ops-card" role="alert">
              <strong>{t('payroll_errors_title', { count: parseErrors.length })}:</strong>
              <ul style={{ margin: '8px 0 0 16px', padding: 0, fontSize: 13, lineHeight: 1.6 }}>
                {parseErrors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
              </ul>
              {parseErrors.length > 10 && (
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  {t('payroll_errors_more', { count: parseErrors.length - 10 })}
                </div>
              )}
            </div>
          )}

          {/* Preview table */}
          {rows.length > 0 && (
            <section className="ops-card">
              <h2 className="ops-h3">{t('payroll_preview', { count: rows.length })}</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('payroll_col_id')}</th>
                      <th className="num">{t('payroll_col_gross')}</th>
                      <th className="num">{t('payroll_col_net')}</th>
                      <th>{t('payroll_col_period')}</th>
                      <th className="num">{t('payroll_col_deduction')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 20).map((r, i) => (
                      <tr key={i}>
                        <td>{r.employeeId}</td>
                        <td className="num">${r.grossSalary.toLocaleString('es-MX')}</td>
                        <td className="num">${r.netSalary.toLocaleString('es-MX')}</td>
                        <td>{r.payPeriod}</td>
                        <td className="num">{r.deductionAmount != null ? `$${r.deductionAmount.toLocaleString('es-MX')}` : '\u2014'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 20 && (
                <p className="ops-note" style={{ marginTop: 8 }}>
                  {t('payroll_preview_more', { count: rows.length - 20 })}
                </p>
              )}

              {/* Date pickers */}
              <div className="ops-fields" style={{ marginTop: 20 }}>
                <label className="ops-field">
                  <span>{t('payroll_period_start')}</span>
                  <input
                    type="date"
                    className="ops-input"
                    value={periodStart}
                    onChange={e => setPeriodStart(e.target.value)}
                  />
                </label>
                <label className="ops-field">
                  <span>{t('payroll_period_end')}</span>
                  <input
                    type="date"
                    className="ops-input"
                    value={periodEnd}
                    onChange={e => setPeriodEnd(e.target.value)}
                  />
                </label>
              </div>

              {/* Submit \u2014 the one white action on this page */}
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="ops-go"
              >
                <i aria-hidden="true" />
                {processing ? t('payroll_processing') : t('payroll_submit', { count: rows.length })}
              </button>

              {/* Progress line */}
              {processing && (
                <div className="ops-bar" style={{ marginTop: 16 }} aria-hidden="true">
                  <i className="run" />
                </div>
              )}

              {apiError && (
                <div className="ops-error" role="alert" style={{ marginTop: 16, padding: '12px 16px' }}>
                  {apiError}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {/* Results */}
      {results && (
        <div>
          {/* Summary */}
          <section className="ops-card">
            <h2 className="ops-h3">{t('payroll_results_title')}</h2>
            <p className="ops-sub">
              {t('payroll_results_summary', {
                total: results.length,
                deducted: deductedCount,
                skipped: skippedCount,
                errors: errorCount,
                amount: totalDeducted.toLocaleString('es-MX'),
              })}
            </p>
          </section>

          {/* Results table */}
          <section className="ops-card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('payroll_col_id')}</th>
                    <th>{t('payroll_res_status')}</th>
                    <th className="num">{t('payroll_res_deduction')}</th>
                    <th className="num">{t('payroll_res_balance')}</th>
                    <th>{t('payroll_res_note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i}>
                      <td>{r.employeeId}</td>
                      <td>
                        <span className={`ops-status${statusClass(r.status)}`}>
                          {isKnownRowStatus(r.status)
                            ? t(`payroll_status_${r.status}`)
                            : t('payroll_status_unknown')}
                        </span>
                      </td>
                      <td className="num">{r.deductionAmount != null ? `$${r.deductionAmount.toLocaleString('es-MX')}` : '\u2014'}</td>
                      <td className="num">{r.newBalance != null ? `$${r.newBalance.toLocaleString('es-MX')}` : '\u2014'}</td>
                      <td style={{ color: r.error ? '#f4a9a1' : 'rgba(242,245,240,.75)', whiteSpace: 'normal' }}>{r.error || '\u2014'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <button type="button" onClick={resetState} className="ops-btn">
            {t('payroll_upload_another')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Green only for the outcome that means the deduction landed. */
function statusClass(status: string | undefined): string {
  switch (status) {
    case 'deducted': return ' g';
    case 'skipped': return ' warn';
    case 'already_processed': return ' mute';
    case 'error': return ' bad';
    default: return ' mute';
  }
}
