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

type RowResult = {
  employeeId: string;
  status: 'deducted' | 'skipped' | 'error' | 'already_processed';
  deductionAmount?: number;
  newBalance?: number;
  error?: string;
};

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

  return (
    <div>
      <h1 style={{ fontFamily: 'var(--df)', fontSize: 'clamp(20px, 3vw, 28px)', color: 'var(--t1)', marginBottom: 8 }}>
        {t('payroll_title')}
      </h1>
      <p style={{ color: 'var(--t2)', fontSize: 14, marginBottom: 28, lineHeight: 1.6 }}>
        {t('payroll_subtitle')}
      </p>

      {!results && (
        <>
          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragging ? 'var(--gold)' : 'rgba(25,68,69,0.12)'}`,
              borderRadius: 16,
              padding: '40px 24px',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragging ? 'rgba(162,134,87,0.04)' : '#fff',
              transition: 'all 0.2s',
              marginBottom: 24,
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>
              {fileName ? '\u2705' : '\uD83D\uDCC4'}
            </div>
            <div style={{ fontWeight: 600, color: 'var(--t1)', fontSize: 15, marginBottom: 4 }}>
              {fileName || t('payroll_drop_label')}
            </div>
            <div style={{ fontSize: 13, color: 'var(--t3)' }}>
              {t('payroll_drop_hint')}
            </div>
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
            <div style={{
              background: 'rgba(220,80,60,0.06)',
              border: '1px solid rgba(220,80,60,0.15)',
              borderRadius: 12,
              padding: '16px 20px',
              marginBottom: 24,
              fontSize: 13,
              color: 'var(--danger)',
            }}>
              <strong>{t('payroll_errors_title', { count: parseErrors.length })}:</strong>
              <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>
                {parseErrors.slice(0, 10).map((e, i) => <li key={i} style={{ marginBottom: 2 }}>{e}</li>)}
              </ul>
              {parseErrors.length > 10 && (
                <div style={{ marginTop: 8, fontStyle: 'italic' }}>
                  {t('payroll_errors_more', { count: parseErrors.length - 10 })}
                </div>
              )}
            </div>
          )}

          {/* Preview table */}
          {rows.length > 0 && (
            <>
              <h2 style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)', marginBottom: 12 }}>
                {t('payroll_preview', { count: rows.length })}
              </h2>
              <div style={{ overflowX: 'auto', marginBottom: 24, borderRadius: 12, border: '1px solid rgba(25,68,69,0.06)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)', textAlign: 'left' }}>
                      <th style={thStyle}>{t('payroll_col_id')}</th>
                      <th style={thStyle}>{t('payroll_col_gross')}</th>
                      <th style={thStyle}>{t('payroll_col_net')}</th>
                      <th style={thStyle}>{t('payroll_col_period')}</th>
                      <th style={thStyle}>{t('payroll_col_deduction')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 20).map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid rgba(25,68,69,0.04)' }}>
                        <td style={tdStyle}>{r.employeeId}</td>
                        <td style={tdStyle}>${r.grossSalary.toLocaleString('es-MX')}</td>
                        <td style={tdStyle}>${r.netSalary.toLocaleString('es-MX')}</td>
                        <td style={tdStyle}>{r.payPeriod}</td>
                        <td style={tdStyle}>{r.deductionAmount != null ? `$${r.deductionAmount.toLocaleString('es-MX')}` : '\u2014'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 20 && (
                <p style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>
                  {t('payroll_preview_more', { count: rows.length - 20 })}
                </p>
              )}

              {/* Date pickers */}
              <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
                <label style={labelStyle}>
                  {t('payroll_period_start')}
                  <input
                    type="date"
                    value={periodStart}
                    onChange={e => setPeriodStart(e.target.value)}
                    style={dateInputStyle}
                  />
                </label>
                <label style={labelStyle}>
                  {t('payroll_period_end')}
                  <input
                    type="date"
                    value={periodEnd}
                    onChange={e => setPeriodEnd(e.target.value)}
                    style={dateInputStyle}
                  />
                </label>
              </div>

              {/* Submit */}
              <button
                onClick={submit}
                disabled={processing || !periodStart || !periodEnd}
                style={{
                  background: processing || !periodStart || !periodEnd ? 'var(--t3)' : 'var(--brand)',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 14,
                  border: 'none',
                  borderRadius: 12,
                  padding: '14px 32px',
                  cursor: processing || !periodStart || !periodEnd ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  width: '100%',
                  maxWidth: 360,
                }}
              >
                {processing ? t('payroll_processing') : t('payroll_submit', { count: rows.length })}
              </button>

              {/* Progress bar */}
              {processing && (
                <div style={{ marginTop: 16, height: 4, borderRadius: 2, background: 'rgba(25,68,69,0.06)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    background: 'var(--gold)',
                    borderRadius: 2,
                    animation: 'payroll-progress 2s ease-in-out infinite',
                    width: '40%',
                  }} />
                  <style>{`@keyframes payroll-progress { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }`}</style>
                </div>
              )}

              {apiError && (
                <div style={{
                  marginTop: 16,
                  background: 'rgba(220,80,60,0.06)',
                  border: '1px solid rgba(220,80,60,0.15)',
                  borderRadius: 12,
                  padding: '12px 16px',
                  fontSize: 13,
                  color: 'var(--danger)',
                }}>
                  {apiError}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Results */}
      {results && (
        <div>
          {/* Summary card */}
          <div style={{
            background: '#fff',
            border: '1px solid rgba(25,68,69,0.06)',
            borderRadius: 16,
            padding: '20px 24px',
            marginBottom: 24,
          }}>
            <h2 style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)', marginBottom: 12 }}>
              {t('payroll_results_title')}
            </h2>
            <p style={{ fontSize: 14, color: 'var(--t2)', lineHeight: 1.8 }}>
              {t('payroll_results_summary', {
                total: results.length,
                deducted: deductedCount,
                skipped: skippedCount,
                errors: errorCount,
                amount: totalDeducted.toLocaleString('es-MX'),
              })}
            </p>
          </div>

          {/* Results table */}
          <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid rgba(25,68,69,0.06)', marginBottom: 24 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg2)', textAlign: 'left' }}>
                  <th style={thStyle}>{t('payroll_col_id')}</th>
                  <th style={thStyle}>{t('payroll_res_status')}</th>
                  <th style={thStyle}>{t('payroll_res_deduction')}</th>
                  <th style={thStyle}>{t('payroll_res_balance')}</th>
                  <th style={thStyle}>{t('payroll_res_note')}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(25,68,69,0.04)' }}>
                    <td style={tdStyle}>{r.employeeId}</td>
                    <td style={tdStyle}>
                      <span style={{
                        display: 'inline-block',
                        padding: '3px 10px',
                        borderRadius: 20,
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '0.3px',
                        background: statusColor(r.status).bg,
                        color: statusColor(r.status).text,
                      }}>
                        {t(`payroll_status_${r.status}`)}
                      </span>
                    </td>
                    <td style={tdStyle}>{r.deductionAmount != null ? `$${r.deductionAmount.toLocaleString('es-MX')}` : '\u2014'}</td>
                    <td style={tdStyle}>{r.newBalance != null ? `$${r.newBalance.toLocaleString('es-MX')}` : '\u2014'}</td>
                    <td style={{ ...tdStyle, color: r.error ? 'var(--danger)' : 'var(--t3)' }}>{r.error || '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={resetState}
            style={{
              background: 'var(--brand)',
              color: '#fff',
              fontWeight: 700,
              fontSize: 14,
              border: 'none',
              borderRadius: 12,
              padding: '14px 32px',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {t('payroll_upload_another')}
          </button>
        </div>
      )}
    </div>
  );
}

function statusColor(status: string): { bg: string; text: string } {
  switch (status) {
    case 'deducted': return { bg: 'rgba(36,122,110,0.1)', text: 'var(--success)' };
    case 'skipped': return { bg: 'rgba(162,134,87,0.1)', text: 'var(--gold)' };
    case 'already_processed': return { bg: 'rgba(147,170,169,0.15)', text: 'var(--t2)' };
    case 'error': return { bg: 'rgba(220,80,60,0.08)', text: 'var(--danger)' };
    default: return { bg: 'rgba(147,170,169,0.1)', text: 'var(--t3)' };
  }
}

const thStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--t3)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 14px',
  color: 'var(--t1)',
  whiteSpace: 'nowrap',
};

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--t2)',
};

const dateInputStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid rgba(25,68,69,0.12)',
  fontSize: 14,
  fontFamily: 'var(--db)',
  color: 'var(--t1)',
  outline: 'none',
};
