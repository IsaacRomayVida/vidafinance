import { useState, useEffect, useRef } from 'react';
import { Icon, type IconName } from '../components/shared/Icons';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc, collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, db, storage } from '../lib/firebase';
import { classifyError, friendlyError } from '../lib/errors';
import { useAuth } from '../hooks/useAuth';
import { signOut } from 'firebase/auth';
import { SkeletonRows } from '../components/ui/SkeletonLine';
import { ErrorBanner } from '../components/ui/ErrorBanner';

interface Loan {
  id: string;
  employeeName?: string;
  amount: number;
  // The persisted field is `term` (functions/src/index.ts:839); `termDays` is
  // only the requestLoan request-payload name and is never written to the
  // document — see MyLoans.tsx / LoanTable.tsx, which read the same field.
  term?: number;
  repaymentAmount?: number;
  status: string;
  createdAt?: { seconds: number };
  [key: string]: unknown;
}

interface CurpConfig {
  prefixes: string[];
  mode: 'allowlist' | 'open';
}

interface EmployerData {
  companyName?: string;
  name?: string;
  email?: string;
  employerCode?: string;
  status?: string;
  totalEmployees?: number;
  docRFC?: string | null;
  docId?: string | null;
  docAddress?: string | null;
  sampleCurps?: string[];
  partBStatus?: string;
  curpConfig?: CurpConfig;
}

// Mirrors EmployerDashboardStats in
// functions/src/employers/computeEmployerDashboardStats.ts — the server always
// returns every field (zeroed, not omitted), so none of these are optional.
interface DashStats {
  totalEmployees: number;
  activeLoans: number;
  overdueCount: number;
  totalDisbursed: number;
  outstandingBalance: number;
  adoptionRate: string;
}

type TabKey = 'all' | 'pending' | 'approved' | 'active' | 'paid' | 'rejected';

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/* ── quincena helpers (presentation only) ─────────────────────────────────
   A quincena is the 1st–15th or the 16th–end of a month. The board names its
   folders and rows after these periods; nothing here prices, schedules or
   dates a deduction — that stays on the server. */
function quincenaStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() >= 16 ? 16 : 1);
}
function quincenaKey(start: Date): string {
  return `${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`;
}
/** n quincenas before (negative) or after (positive) `start`. */
function shiftQuincena(start: Date, n: number): Date {
  let m = start.getMonth();
  let day = start.getDate();
  for (let i = 0; i < Math.abs(n); i++) {
    if (n < 0) { if (day === 16) day = 1; else { day = 16; m -= 1; } }
    else { if (day === 1) day = 16; else { day = 1; m += 1; } }
  }
  return new Date(start.getFullYear(), m, day);
}
function monthShort(d: Date, lang: string): string {
  return d.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short' }).replace('.', '');
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];

interface DocSlot {
  key: string;
  firestoreField: 'docRFC' | 'docId' | 'docAddress';
  i18nKey: string;
}

const DOC_SLOTS: DocSlot[] = [
  { key: 'rfc', firestoreField: 'docRFC', i18nKey: 'onb_e_step4_rfc' },
  { key: 'id_oficial', firestoreField: 'docId', i18nKey: 'onb_e_step4_id' },
  { key: 'comprobante', firestoreField: 'docAddress', i18nKey: 'onb_e_step4_address' },
];

function DocUploadBanner({ uid, onComplete }: { uid: string; onComplete: () => void }) {
  const { t } = useTranslation();
  const [uploads, setUploads] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [allDone, setAllDone] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const uploadCount = Object.keys(uploads).length;

  async function handleFile(slot: DocSlot, file: File) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setErrors(prev => ({ ...prev, [slot.key]: t('onb_e_step4_error') }));
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setErrors(prev => ({ ...prev, [slot.key]: t('onb_e_step4_error') }));
      return;
    }

    setUploading(prev => ({ ...prev, [slot.key]: true }));
    setErrors(prev => { const n = { ...prev }; delete n[slot.key]; return n; });

    try {
      const storageRef = ref(storage, `onboarding/employer_docs/${uid}/${slot.key}`);
      const task = uploadBytesResumable(storageRef, file);
      await task;
      const url = await getDownloadURL(task.snapshot.ref);
      setUploads(prev => {
        const next = { ...prev, [slot.key]: url };
        return next;
      });
    } catch {
      setErrors(prev => ({ ...prev, [slot.key]: t('onb_e_step4_error') }));
    } finally {
      setUploading(prev => ({ ...prev, [slot.key]: false }));
    }
  }

  useEffect(() => {
    if (uploadCount < 3) return;
    (async () => {
      setSubmitError('');
      try {
        const functions = getFunctions();
        const submitDocs = httpsCallable<
          { docRFC: string; docId: string; docAddress: string },
          { success: boolean }
        >(functions, 'submitEmployerDocs');
        await submitDocs({
          docRFC: uploads['rfc'],
          docId: uploads['id_oficial'],
          docAddress: uploads['comprobante'],
        });
        setAllDone(true);
        setTimeout(onComplete, 3000);
      } catch (err) {
        const code = classifyError(err);
        setSubmitError(code === 'generic' ? t('onb_e_step4_error') : friendlyError(err));
      }
    })();
  }, [uploadCount, uploads, uid, onComplete, t]);

  if (allDone) {
    return (
      <div className="ops-page">
        <div className="ops-card" style={{ textAlign: 'center', padding: '64px 24px' }}>
          <div className="ops-check" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 24, height: 24 }}>
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <h2 className="ops-title sm">{t('dash_doc_banner_success')}</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="ops-page">
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_verifying')}</div>
          <h2 className="ops-title">{t('dash_doc_banner_h')}</h2>
          <p className="ops-sub">{t('dash_doc_banner_sub')}</p>
        </div>
      </div>

      {/* Document folders — the glyph turns green only once the file is received */}
      <div className="ops-card">
        {DOC_SLOTS.map((slot) => {
          const done = !!uploads[slot.key];
          const busy = !!uploading[slot.key];
          const error = errors[slot.key];

          return (
            <div key={slot.key} className="ops-batch" style={{ flexWrap: 'wrap' }}>
              <span className={`fl${done ? ' g' : ''}`} aria-hidden="true" />
              <span className="t">
                {t(slot.i18nKey)}
                <small>{error ? <span className="ops-error">{error}</span> : t('onb_e_step4_formats')}</small>
              </span>
              <input
                ref={(el) => { fileRefs.current[slot.key] = el; }}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,image/*,application/pdf"
                aria-label={`${t('a11y_file_upload')}: ${t(slot.i18nKey)}`}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(slot, file);
                }}
              />
              {done ? (
                <span className="ops-status g">{t('onb_e_step4_done')}</span>
              ) : (
                <button
                  type="button"
                  className="ops-btn sm"
                  disabled={busy}
                  onClick={() => fileRefs.current[slot.key]?.click()}
                >
                  {busy ? t('onb_e_step4_uploading') : t('onb_e_step4_upload')}
                </button>
              )}
            </div>
          );
        })}
        {submitError && <div className="ops-error" style={{ marginTop: 12 }}>{submitError}</div>}
      </div>
    </div>
  );
}


const CURP_REGEX = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z\d]\d$/;

function PayrollDeductionCard({ employer, onSubmitted }: { employer: EmployerData; onSubmitted: () => void }) {
  const { t } = useTranslation();
  const [curps, setCurps] = useState<[string, string, string]>(['', '', '']);
  const [errors, setErrors] = useState<[string, string, string]>(['', '', '']);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Already submitted — show pending state
  if (employer.partBStatus === 'pending' || submitted) {
    return (
      <div className="card partb-card">
        <div className="card-title">{t('dash_partb_title')}</div>
        <div className="partb-pending">
          <div className="partb-pending-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="#a28657" strokeWidth="2" width="24" height="24">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <p>{submitted ? t('dash_partb_success') : t('dash_partb_pending')}</p>
        </div>
      </div>
    );
  }

  function handleChange(idx: number, value: string) {
    const upper = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 18);
    setCurps(prev => { const next = [...prev] as [string, string, string]; next[idx] = upper; return next; });
    setErrors(prev => { const next = [...prev] as [string, string, string]; next[idx] = ''; return next; });
    setSubmitError('');
  }

  function validate(): boolean {
    const next: [string, string, string] = ['', '', ''];
    let valid = true;

    for (let i = 0; i < 3; i++) {
      const c = curps[i].trim();
      if (!CURP_REGEX.test(c)) {
        next[i] = t('dash_partb_curp_invalid');
        valid = false;
      }
    }

    // Check duplicates only if format is valid
    if (valid) {
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        if (seen.has(curps[i])) {
          next[i] = t('dash_partb_curp_duplicate');
          valid = false;
        }
        seen.add(curps[i]);
      }
    }

    setErrors(next);
    return valid;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const functions = getFunctions();
      const submitSetup = httpsCallable<{ curps: string[] }, { success: boolean }>(
        functions,
        'submitPayrollDeductionSetup'
      );
      await submitSetup({ curps });
      setSubmitted(true);
      onSubmitted();
    } catch {
      setSubmitError(t('dash_partb_error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card partb-card">
      <div className="card-title">{t('dash_partb_title')}</div>
      <p className="partb-sub">{t('dash_partb_sub')}</p>

      <div className="partb-fields">
        {curps.map((curp, i) => (
          <div key={i} className="partb-field">
            <label className="partb-label" htmlFor={`partb-curp-${i}`}>{t('dash_partb_curp_label', { n: i + 1 })}</label>
            <input
              id={`partb-curp-${i}`}
              type="text"
              className={`partb-input${errors[i] ? ' partb-input-error' : ''}`}
              value={curp}
              onChange={(e) => handleChange(i, e.target.value)}
              placeholder={t('dash_partb_curp_placeholder')}
              maxLength={18}
              spellCheck={false}
              autoComplete="off"
            />
            {errors[i] && <div className="partb-error">{errors[i]}</div>}
          </div>
        ))}
      </div>

      {submitError && <div className="partb-error partb-submit-error">{submitError}</div>}

      <button
        className="partb-btn"
        onClick={handleSubmit}
        disabled={submitting}
      >
        {submitting ? t('dash_partb_submitting') : t('dash_partb_submit')}
      </button>
    </div>
  );
}

const CURP_PREFIX_REGEX = /^[A-Z]{2}\d{2}$/;

function CurpConfigCard({ employer, onUpdated }: { employer: EmployerData; onUpdated: (config: CurpConfig) => void }) {
  const { t } = useTranslation();
  const existing = employer.curpConfig;
  const [mode, setMode] = useState<'allowlist' | 'open'>(existing?.mode ?? 'open');
  const [prefixInput, setPrefixInput] = useState('');
  const [prefixes, setPrefixes] = useState<string[]>(existing?.prefixes ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [inputError, setInputError] = useState('');

  async function handleSave() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const functions = getFunctions();
      const updateCurpConfig = httpsCallable<{ prefixes: string[]; mode: string }, { success: boolean }>(
        functions,
        'updateEmployerCurpConfig'
      );
      await updateCurpConfig({ prefixes, mode });
      setSaved(true);
      onUpdated({ prefixes, mode });
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      const code = classifyError(err);
      setError(code === 'generic' ? t('curp_config_error') : friendlyError(err));
    } finally {
      setSaving(false);
    }
  }

  function addPrefix() {
    const val = prefixInput.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (val.length !== 4) {
      setInputError(t('curp_config_prefix_invalid'));
      return;
    }
    if (!CURP_PREFIX_REGEX.test(val)) {
      setInputError(t('curp_config_prefix_invalid'));
      return;
    }
    if (prefixes.includes(val)) {
      setInputError(t('curp_config_prefix_duplicate'));
      return;
    }
    setPrefixes(prev => [...prev, val]);
    setPrefixInput('');
    setInputError('');
    setSaved(false);
  }

  function removePrefix(idx: number) {
    setPrefixes(prev => prev.filter((_, i) => i !== idx));
    setSaved(false);
  }

  return (
    <section className="ops-card" aria-labelledby="curp-config-title">
      <h2 id="curp-config-title" className="ops-h3">{t('curp_config_title')}</h2>
      <p className="ops-sub" style={{ marginBottom: 20 }}>
        {t('curp_config_desc')}
      </p>

      {/* Mode toggle */}
      <div className="ops-choices">
        <button
          type="button"
          onClick={() => { setMode('open'); setSaved(false); }}
          className={`ops-choice${mode === 'open' ? ' on' : ''}`}
          aria-pressed={mode === 'open'}
        >
          <b>{t('curp_config_mode_open')}</b>
          <small>{t('curp_config_mode_open_desc')}</small>
        </button>
        <button
          type="button"
          onClick={() => { setMode('allowlist'); setSaved(false); }}
          className={`ops-choice${mode === 'allowlist' ? ' on' : ''}`}
          aria-pressed={mode === 'allowlist'}
        >
          <b>{t('curp_config_mode_allowlist')}</b>
          <small>{t('curp_config_mode_allowlist_desc')}</small>
        </button>
      </div>

      {/* Prefix list (only shown when mode is allowlist) */}
      {mode === 'allowlist' && (
        <div style={{ marginBottom: 20 }}>
          <label htmlFor="curp-prefix-input" className="ops-label" style={{ display: 'block', marginBottom: 8 }}>
            {t('curp_config_prefixes_label')}
          </label>

          {/* Input row */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              id="curp-prefix-input"
              type="text"
              value={prefixInput}
              onChange={(e) => {
                setPrefixInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4));
                setInputError('');
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPrefix(); } }}
              placeholder={t('curp_config_prefix_placeholder')}
              maxLength={4}
              spellCheck={false}
              autoComplete="off"
              className={`ops-input mono${inputError ? ' error' : ''}`}
              style={{ flex: 1 }}
            />
            <button type="button" onClick={addPrefix} className="ops-btn">
              {t('curp_config_add')}
            </button>
          </div>
          {inputError && <div className="ops-error" style={{ marginBottom: 8 }}>{inputError}</div>}

          {/* Prefix chips */}
          {prefixes.length > 0 ? (
            <div className="ops-chips">
              {prefixes.map((p, i) => (
                <span key={i} className="ops-status mono">
                  {p}
                  <button
                    type="button"
                    onClick={() => removePrefix(i)}
                    className="ops-x"
                    aria-label={`Remove ${p}`}
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="ops-note">
              {t('curp_config_no_prefixes')}
            </p>
          )}
        </div>
      )}

      {/* Save button */}
      {error && <div className="ops-error" style={{ marginBottom: 12 }}>{error}</div>}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className={`ops-btn${saved ? ' g' : ''}`}
      >
        {saving ? t('curp_config_saving') : saved ? t('curp_config_saved') : t('curp_config_save')}
      </button>
    </section>
  );
}



export function EmployerDashboard() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  // Stable ref for navigate — useNavigate() can return a new function
  // on every render with BrowserRouter (non-data router) in react-router v7,
  // which would re-trigger any useEffect that includes it as a dependency.
  const navigateRef = useRef(navigate);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);

  const [employer, setEmployer] = useState<EmployerData | null>(null);
  // null means "not loaded" — either still loading or the read failed. Never
  // defaulted to {} on failure: a stats read failure must surface as an
  // error, not as a plausible-looking wrong number (E4, AUDIT_EMPLOYER_PATH.md).
  const [stats, setStats] = useState<DashStats | null>(null);
  const [statsError, setStatsError] = useState('');
  const [statsRetryToken, setStatsRetryToken] = useState(0);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [pageState, setPageState] = useState<'loading' | 'pending_verification' | 'dashboard'>('loading');

  const needsEmailVerification = user ? (!user.emailVerified && !user.email?.endsWith('@vida-test.com')) : false;

  // Fetch employer doc and dashboard stats
  useEffect(() => {
    if (!user || needsEmailVerification) return;

    let cancelled = false;
    const uid = user.uid;

    (async () => {
      const empDoc = await getDoc(doc(db, 'employers', uid));
      if (cancelled) return;

      if (!empDoc.exists()) {
        navigateRef.current('/employee', { replace: true });
        return;
      }
      const emp = empDoc.data() as EmployerData;
      setEmployer(emp);

      if (emp.status === 'pending_verification') {
        setPageState('pending_verification');
        return;
      }
      if (emp.status && emp.status !== 'active' && emp.status !== 'pending_verification') {
        navigateRef.current('/', { replace: true });
        return;
      }

      // Fetch stats from Cloud Function. A failure here does not block the
      // rest of the dashboard — the loans listener below is independent and
      // still useful — but it must not be papered over with a recomputed
      // number either, so it gets its own error state instead of a fallback.
      try {
        const functions = getFunctions();
        const getEmployerDashboard = httpsCallable<unknown, { stats: DashStats }>(functions, 'getEmployerDashboard');
        const result = await getEmployerDashboard({});
        if (!cancelled) {
          setStats(result.data.stats);
          setStatsError('');
        }
      } catch (err) {
        if (!cancelled) setStatsError(friendlyError(err));
      }

      if (!cancelled) {
        setPageState('dashboard');
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [user, needsEmailVerification, statsRetryToken]);

  // Real-time loans listener
  useEffect(() => {
    if (!user || pageState !== 'dashboard') return;

    const q = query(
      collection(db, 'loans'),
      where('employerId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsub = onSnapshot(q, (snap) => {
      const loanData = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan));
      setLoans(loanData);
      setLoading(false);
    }, () => {
      // Query error (e.g. missing composite index) — stop loading
      setLoading(false);
    });

    return unsub;
  }, [user, pageState]);

  if (pageState === 'loading') {
    return (
      <div className="ops-card" style={{ display: 'grid', placeItems: 'center', padding: 80 }} aria-busy="true">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      </div>
    );
  }

  if (needsEmailVerification) {
    return (
      <div className="ops-page">
        <div className="ops-card" style={{ textAlign: 'center', padding: '56px 24px' }}>
          <h2 className="ops-title sm">{t('dash_verify_email')}</h2>
          <p className="ops-sub" style={{ margin: '10px auto 24px' }}>{t('dash_verify_email_desc')}</p>
          <button
            type="button"
            className="ops-go"
            style={{ marginTop: 0 }}
            onClick={() => signOut(auth).then(() => navigate('/login'))}
          >
            <i aria-hidden="true" />{t('dash_back_to_login')}
          </button>
        </div>
      </div>
    );
  }

  if (pageState === 'pending_verification') {
    const needsDocs = !employer?.docRFC || employer.docRFC === '';
    if (needsDocs) {
      return <DocUploadBanner uid={user!.uid} onComplete={() => {
        setEmployer(prev => prev ? { ...prev, docRFC: 'pending', docId: 'pending', docAddress: 'pending' } : prev);
      }} />;
    }
    return (
      <div className="ops-page">
        <div className="ops-card" style={{ textAlign: 'center', padding: '56px 24px' }}>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_verifying')}</div>
          <h2 className="ops-title sm">{t('dash_account_created')}</h2>
          <p className="ops-sub" style={{ margin: '10px auto 24px' }}>{t('dash_pending_verification')}</p>
          <button
            type="button"
            className="ops-go"
            style={{ marginTop: 0 }}
            onClick={() => signOut(auth).then(() => navigate('/'))}
          >
            <i aria-hidden="true" />{t('dash_back_to_login')}
          </button>
        </div>
      </div>
    );
  }

  const pendingCount = loans.filter((l) => l.status === 'pending').length;

  const retryStats = () => {
    setStatsError('');
    setStatsRetryToken((n) => n + 1);
  };

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'all', label: t('dash_tab_all') },
    { key: 'pending', label: t('dash_tab_pending') },
    { key: 'approved', label: t('dash_tab_approved') },
    { key: 'active', label: t('dash_tab_active') },
    { key: 'paid', label: t('dash_tab_paid') },
    { key: 'rejected', label: t('dash_tab_rejected') },
  ];

  // Approve or reject a pending loan
  const handleLoanAction = async (loanId: string, status: 'approved' | 'rejected') => {
    const msg = status === 'approved'
      ? '¿Estás seguro de aprobar este préstamo? Se autorizará la deducción de nómina.'
      : '¿Estás seguro de rechazar este préstamo?';
    if (!window.confirm(msg)) return;
    setActionLoading(loanId);
    try {
      const functions = getFunctions();
      const updateLoanStatus = httpsCallable(functions, 'updateLoanStatus');
      await updateLoanStatus({ loanId, status });
    } catch (e: unknown) {
      alert('Error: ' + ((e as Error)?.message || 'Unknown error'));
    } finally {
      setActionLoading(null);
    }
  };


  const filteredLoans = (() => {
    if (activeTab === 'all') return loans;
    if (activeTab === 'approved') return loans.filter((l) => l.status === 'approved' || l.status === 'disbursement_queued');
    return loans.filter((l) => l.status === activeTab);
  })();

  function tabCount(key: TabKey): number {
    if (key === 'all') return loans.length;
    if (key === 'approved') return loans.filter((l) => l.status === 'approved' || l.status === 'disbursement_queued').length;
    return loans.filter((l) => l.status === key).length;
  }

  /* ── the board: everything below is derived from `employer`, `stats` and
     `loans` — the reads above — and names real objects in the operation:
     this employer, its last quincenas, the CURP and IMSS files. ── */
  const lang = i18n.language;
  const cur = quincenaStart(new Date());
  const curKey = quincenaKey(cur);
  const label = (start: Date) => t('ops_quincena', { day: start.getDate(), month: monthShort(start, lang) });
  const curLabel = label(cur);
  const prev1 = shiftQuincena(cur, -1);
  const prev2 = shiftQuincena(cur, -2);

  const byPeriod = new Map<string, { start: Date; loans: Loan[] }>();
  for (const l of loans) {
    if (!l.createdAt) continue;
    const start = quincenaStart(new Date(l.createdAt.seconds * 1000));
    const key = quincenaKey(start);
    const g = byPeriod.get(key) ?? { start, loans: [] };
    g.loans.push(l);
    byPeriod.set(key, g);
  }
  const countIn = (start: Date) => byPeriod.get(quincenaKey(start))?.loans.length ?? 0;
  const isApproved = (l: Loan) => ['approved', 'disbursement_queued', 'active', 'disbursed', 'repaid', 'paid'].includes(l.status);
  const periodRows = [
    { start: cur, loans: byPeriod.get(curKey)?.loans ?? [], current: true },
    ...[...byPeriod.values()]
      .filter((g) => quincenaKey(g.start) !== curKey)
      .sort((a, b) => b.start.getTime() - a.start.getTime())
      .slice(0, 3)
      .map((g) => ({ ...g, current: false })),
  ];

  const onSchedule = stats ? Math.max(0, stats.activeLoans - stats.overdueCount) : 0;
  const pct = stats && stats.activeLoans > 0 ? Math.round((onSchedule / stats.activeLoans) * 100) : null;

  const folders: { i: number; label: string; n: number; lit?: boolean; kind: IconName }[] = [
    { i: -3, label: employer?.companyName ?? '', n: stats?.totalEmployees ?? employer?.totalEmployees ?? 0, kind: 'empleador' },
    { i: -2, label: label(prev2), n: countIn(prev2), kind: 'quincena' },
    { i: -1, label: label(prev1), n: countIn(prev1), kind: 'quincena' },
    { i: 0, label: curLabel, n: countIn(cur), lit: true, kind: 'quincena' },
    { i: 1, label: t('ops_folder_curp'), n: employer?.curpConfig?.prefixes?.length ?? 0, kind: 'kyc' },
    { i: 2, label: t('ops_folder_imss'), n: employer?.sampleCurps?.length ?? 0, kind: 'contrato' },
  ];

  const partB = employer?.partBStatus;

  return (
    <div>
      <div className="ops-board">
        {/* ── stage ── */}
        <section className="ops-panel stage" aria-labelledby="emp-stage-title">
          <div className="dot ops-eyebrow">{t('ops_eyebrow_payroll')} · {curLabel}</div>
          <h1 id="emp-stage-title" className="ops-title">{employer?.companyName}</h1>
          <p className="ops-sub">
            {t('dash_employer_code')} · <strong>{employer?.employerCode}</strong>
          </p>

          <div className="ops-objects" aria-hidden="true">
            {folders.map((f) => (
              <div key={f.i} className={`ops-object${f.lit ? ' lit' : ''}`}>
                <Icon name={f.kind} size={26} />
                <b>{f.n}</b>
                <span>{f.label}</span>
              </div>
            ))}
          </div>

          <div className="ops-prog">
            <div className="h"><span>{curLabel}</span><span aria-hidden="true">↗</span></div>
            <div className="d">
              {pct === null
                ? t('ops_prog_none')
                : t('ops_prog_on_schedule', { ok: onSchedule, total: stats!.activeLoans })}
            </div>
            <div className="v">{pct === null ? '—' : <>{pct}<b>%</b></>}</div>
            <span className="dotg" aria-hidden="true" />
          </div>
        </section>

        {/* ── data ── */}
        <section className="ops-panel data" aria-labelledby="emp-data-title">
          <span className="ops-tag" id="emp-data-title"><i aria-hidden="true" />{t('ops_live_payroll')}</span>

          {statsError ? (
            <div style={{ marginTop: 22 }}>
              <ErrorBanner message={`${t('dash_stats_error')} ${statsError}`} />
              <button type="button" onClick={retryStats} className="ops-btn" style={{ marginTop: 12 }}>
                {t('dash_retry')}
              </button>
            </div>
          ) : (
            <>
              <div className="ops-kpis">
                <div className="ops-kpi">
                  <small>{t('dash_outstanding_balance')}</small>
                  <b>{stats ? '$' + fmt(stats.outstandingBalance) : '—'}<span>MXN</span></b>
                </div>
                <div className="ops-kpi">
                  <small>{t('dash_active_loans')}</small>
                  <b>{stats ? String(stats.activeLoans) : '—'}</b>
                </div>
                <div className={`ops-kpi${stats && stats.overdueCount > 0 ? ' warn' : ''}`}>
                  <small>{t('dash_overdue_count')}</small>
                  <b>{stats ? String(stats.overdueCount) : '—'}</b>
                </div>
              </div>
              <div className="ops-kpi-line">
                {t('dash_total_disbursed')} <span>{stats ? '$' + fmt(stats.totalDisbursed) : '—'}</span> MXN
                {' · '}{t('dash_total_employees')} <span>{stats ? String(stats.totalEmployees) : '—'}</span>
                {' · '}{t('dash_adoption_rate')} <span>{stats ? stats.adoptionRate : '—'}</span>
                {' · '}{t('dash_pending_requests')} <span>{pendingCount}</span>
              </div>
            </>
          )}

          <h2 className="ops-h3">{t('ops_requests_by_period')}</h2>
          {periodRows.map((g) => {
            const approved = g.loans.filter(isApproved).length;
            const sum = g.loans.reduce((s, l) => s + (Number(l.amount) || 0), 0);
            return (
              <div className="ops-batch" key={quincenaKey(g.start)}>
                <span className={`fl${g.current ? ' g' : ''}`} aria-hidden="true" />
                <span className="t">
                  {label(g.start)}
                  <small>{t('ops_row_requests', { count: g.loans.length, approved })}</small>
                </span>
                <span className={`p${g.current ? ' g' : ''}`}>{g.loans.length > 0 ? '$' + fmt(sum) : '—'}</span>
              </div>
            );
          })}

          {partB !== 'completed' && (
            <div className="ops-due">
              <i aria-hidden="true" />
              <span>
                {t('ops_due_imss')}
                <small>{partB === 'pending' ? t('ops_due_imss_review') : t('ops_due_imss_pending')}</small>
              </span>
            </div>
          )}

          <button type="button" className="ops-go" onClick={() => navigate('/employer/payroll')}>
            <i aria-hidden="true" />{t('ops_go_upload_payroll', { period: curLabel })}
          </button>
        </section>
      </div>

      {/* ── requests ── */}
      <section className="ops-card" aria-labelledby="emp-loans-title">
        <div className="ops-card-head">
          <h2 id="emp-loans-title" className="ops-h3">{t('dash_recent_loans')}</h2>
          <div className="ops-chips">
            {tabs.map((tab) => {
              const on = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`ops-chip${on ? ' on' : ''}`}
                  aria-pressed={on}
                >
                  {tab.label}<span className="cnt">{tabCount(tab.key)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 20 }}>
            <SkeletonRows rows={3} />
          </div>
        ) : filteredLoans.length === 0 ? (
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <p>
              {t('dash_no_loans_employer')} <strong>{employer?.employerCode}</strong> {t('dash_no_loans_employer_2')}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('dash_th_employee')}</th>
                  <th>{t('dash_th_amount')}</th>
                  <th>{t('dash_th_term')}</th>
                  <th>{t('dash_th_status')}</th>
                  <th>{t('dash_th_date')}</th>
                  <th>{t('dash_th_action', 'Acción')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredLoans.map((loan) => (
                  <tr key={loan.id}>
                    <td style={{ fontWeight: 500 }}>{loan.employeeName || '—'}</td>
                    <td>${fmt(loan.amount)}</td>
                    <td>{loan.term ?? 30} {t('dash_days')}</td>
                    <td>
                      <span className={`badge badge-${loan.status}`}>
                        {t(`status_${loan.status}`, loan.status)}
                      </span>
                    </td>
                    <td>
                      {loan.createdAt ? new Date(loan.createdAt.seconds * 1000).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      {loan.status === 'pending' ? (
                        <div className="ops-actions">
                          <button
                            type="button"
                            className="ops-btn sm"
                            disabled={actionLoading === loan.id}
                            onClick={() => handleLoanAction(loan.id, 'approved')}
                          >
                            {actionLoading === loan.id ? '...' : t('dash_approve', 'Aprobar')}
                          </button>
                          <button
                            type="button"
                            className="ops-btn sm ghost danger"
                            disabled={actionLoading === loan.id}
                            onClick={() => handleLoanAction(loan.id, 'rejected')}
                          >
                            {t('dash_reject', 'Rechazar')}
                          </button>
                        </div>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Payroll Deduction Setup (Part B) — below requests */}
      {employer?.partBStatus !== 'completed' && (
        <PayrollDeductionCard
          employer={employer!}
          onSubmitted={() => setEmployer(prev => prev ? { ...prev, partBStatus: 'pending' } : prev)}
        />
      )}

      {/* CURP Configuration — below requests */}
      <CurpConfigCard
        employer={employer!}
        onUpdated={(config) => setEmployer(prev => prev ? { ...prev, curpConfig: config } : prev)}
      />
    </div>
  );
}
