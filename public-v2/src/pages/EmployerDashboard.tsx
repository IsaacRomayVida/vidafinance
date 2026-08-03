import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc, updateDoc, collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, db, storage } from '../lib/firebase';
import { classifyError, friendlyError } from '../lib/errors';
import { useAuth } from '../hooks/useAuth';
import { signOut } from 'firebase/auth';
import { SkeletonRows } from '../components/ui/SkeletonLine';

interface Loan {
  id: string;
  employeeName?: string;
  amount: number;
  termDays?: number;
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

interface DashStats {
  totalEmployees?: number;
  activeLoans?: number;
  overdueCount?: number;
  totalDisbursed?: number;
  adoptionRate?: string;
  outstandingBalance?: number;
}

type TabKey = 'all' | 'pending' | 'approved' | 'active' | 'paid' | 'rejected';

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
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
      try {
        await updateDoc(doc(db, 'employers', uid), {
          docRFC: uploads['rfc'],
          docId: uploads['id_oficial'],
          docAddress: uploads['comprobante'],
        });
        setAllDone(true);
        setTimeout(onComplete, 3000);
      } catch {
        // Firestore update failed
      }
    })();
  }, [uploadCount, uploads, uid, onComplete]);

  if (allDone) {
    return (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '80px 24px', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(36,122,110,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="#247a6e" strokeWidth="2.5" style={{ width: 28, height: 28 }}>
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <h2 style={{ fontFamily: 'var(--df)', fontSize: 24, color: 'var(--brand)', fontWeight: 400 }}>{t('dash_doc_banner_success')}</h2>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '48px 24px 64px' }}>
      {/* Header section */}
      <div style={{ marginBottom: 40 }}>
        <h2 style={{
          fontFamily: 'var(--df)',
          fontSize: 26,
          color: 'var(--brand)',
          fontWeight: 400,
          letterSpacing: '-0.02em',
          lineHeight: 1.15,
          marginBottom: 16,
        }}>
          {t('dash_doc_banner_h')}
        </h2>
        <p style={{
          fontSize: 14,
          color: 'var(--t2)',
          lineHeight: 1.7,
          maxWidth: 380,
        }}>
          {t('dash_doc_banner_sub')}
        </p>
      </div>

      {/* Document cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {DOC_SLOTS.map((slot) => {
          const done = !!uploads[slot.key];
          const busy = !!uploading[slot.key];
          const error = errors[slot.key];

          return (
            <div
              key={slot.key}
              style={{
                background: '#fff',
                borderRadius: 20,
                padding: '28px 24px',
                border: '1px solid rgba(25,68,69,0.04)',
                boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
              }}
            >
              {/* Icon + Text row */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
                <div style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  background: done ? 'rgba(36,122,110,0.06)' : 'rgba(162,134,87,0.06)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {done ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="#247a6e" strokeWidth="2.5" style={{ width: 20, height: 20 }}><path d="M20 6L9 17l-5-5" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="#a28657" strokeWidth="1.5" style={{ width: 20, height: 20 }}>
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" />
                    </svg>
                  )}
                </div>
                <div style={{ paddingTop: 2 }}>
                  <div style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: 'var(--t1)',
                    marginBottom: 6,
                    letterSpacing: '-0.01em',
                  }}>
                    {t(slot.i18nKey)}
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: 'var(--t3)',
                    lineHeight: 1.4,
                  }}>
                    {t('onb_e_step4_formats')}
                  </div>
                  {error && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>{error}</div>}
                </div>
              </div>

              {/* Button */}
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
              <button
                disabled={done || busy}
                onClick={() => fileRefs.current[slot.key]?.click()}
                style={{
                  width: '100%',
                  background: done ? 'rgba(36,122,110,0.04)' : 'var(--brand)',
                  color: done ? 'var(--success)' : '#fff',
                  borderRadius: 60,
                  padding: '14px 24px',
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  letterSpacing: '0.2px',
                  opacity: busy ? 0.6 : 1,
                  cursor: done ? 'default' : 'pointer',
                  transition: 'all 0.3s',
                }}
              >
                {busy ? t('onb_e_step4_uploading') : done ? t('onb_e_step4_done') : t('onb_e_step4_upload')}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}


const CURP_REGEX = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z\d]\d$/;

function PayrollDeductionCard({ uid, employer, onSubmitted }: { uid: string; employer: EmployerData; onSubmitted: () => void }) {
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
      await updateDoc(doc(db, 'employers', uid), {
        sampleCurps: curps,
        partBStatus: 'pending',
      });
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
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-title">{t('curp_config_title')}</div>
      <p style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.6, marginBottom: 24 }}>
        {t('curp_config_desc')}
      </p>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <button
          onClick={() => { setMode('open'); setSaved(false); }}
          style={{
            flex: 1,
            padding: '14px 16px',
            borderRadius: 16,
            border: mode === 'open' ? '2px solid var(--brand)' : '1.5px solid rgba(25,68,69,0.1)',
            background: mode === 'open' ? 'rgba(25,68,69,0.03)' : '#fff',
            cursor: 'pointer',
            transition: 'all .2s',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', marginBottom: 4 }}>
            {t('curp_config_mode_open')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.4 }}>
            {t('curp_config_mode_open_desc')}
          </div>
        </button>
        <button
          onClick={() => { setMode('allowlist'); setSaved(false); }}
          style={{
            flex: 1,
            padding: '14px 16px',
            borderRadius: 16,
            border: mode === 'allowlist' ? '2px solid var(--brand)' : '1.5px solid rgba(25,68,69,0.1)',
            background: mode === 'allowlist' ? 'rgba(25,68,69,0.03)' : '#fff',
            cursor: 'pointer',
            transition: 'all .2s',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', marginBottom: 4 }}>
            {t('curp_config_mode_allowlist')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.4 }}>
            {t('curp_config_mode_allowlist_desc')}
          </div>
        </button>
      </div>

      {/* Prefix list (only shown when mode is allowlist) */}
      {mode === 'allowlist' && (
        <div style={{ marginBottom: 24 }}>
          <label htmlFor="curp-prefix-input" style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)', display: 'block', marginBottom: 8 }}>
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
              style={{
                flex: 1,
                padding: '12px 16px',
                borderRadius: 12,
                border: inputError ? '1.5px solid var(--danger)' : '1.5px solid rgba(25,68,69,0.1)',
                fontSize: 14,
                fontFamily: 'monospace',
                letterSpacing: '0.1em',
                outline: 'none',
                transition: 'border .2s',
              }}
            />
            <button
              onClick={addPrefix}
              style={{
                padding: '12px 20px',
                borderRadius: 12,
                background: 'var(--brand)',
                color: '#fff',
                border: 'none',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t('curp_config_add')}
            </button>
          </div>
          {inputError && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 8 }}>{inputError}</div>}

          {/* Prefix chips */}
          {prefixes.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {prefixes.map((p, i) => (
                <span
                  key={i}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 14px',
                    borderRadius: 10,
                    background: 'rgba(25,68,69,0.04)',
                    fontSize: 13,
                    fontFamily: 'monospace',
                    fontWeight: 600,
                    color: 'var(--brand)',
                    letterSpacing: '0.05em',
                  }}
                >
                  {p}
                  <button
                    onClick={() => removePrefix(i)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      lineHeight: 1,
                      color: 'var(--t3)',
                      fontSize: 16,
                    }}
                    aria-label={`Remove ${p}`}
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--t3)', fontStyle: 'italic' }}>
              {t('curp_config_no_prefixes')}
            </p>
          )}
        </div>
      )}

      {/* Save button */}
      {error && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 12 }}>{error}</div>}
      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          width: '100%',
          padding: '14px 24px',
          borderRadius: 60,
          background: saved ? 'rgba(36,122,110,0.04)' : 'var(--brand)',
          color: saved ? 'var(--success)' : '#fff',
          border: 'none',
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: '0.2px',
          cursor: saving ? 'default' : 'pointer',
          opacity: saving ? 0.6 : 1,
          transition: 'all .3s',
        }}
      >
        {saving ? t('curp_config_saving') : saved ? t('curp_config_saved') : t('curp_config_save')}
      </button>
    </div>
  );
}


export function EmployerDashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  // Stable ref for navigate — useNavigate() can return a new function
  // on every render with BrowserRouter (non-data router) in react-router v7,
  // which would re-trigger any useEffect that includes it as a dependency.
  const navigateRef = useRef(navigate);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);

  const [employer, setEmployer] = useState<EmployerData | null>(null);
  const [stats, setStats] = useState<DashStats>({});
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

      // Fetch stats from Cloud Function
      try {
        const functions = getFunctions();
        const getEmployerDashboard = httpsCallable<unknown, { stats: DashStats }>(functions, 'getEmployerDashboard');
        const result = await getEmployerDashboard({});
        if (!cancelled) setStats(result.data.stats || {});
      } catch {
        // fallback - stats will be computed from loans
      }

      if (!cancelled) {
        setPageState('dashboard');
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [user, needsEmailVerification]);

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
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
      </div>
    );
  }

  if (needsEmailVerification) {
    return (
      <div className="mx-auto max-w-lg py-12 sm:py-20 px-4 text-center">
        <h2 className="text-lg sm:text-xl font-bold text-teal-900">{t('dash_verify_email')}</h2>
        <p className="mt-3 sm:mt-4 text-sm text-gray-500">{t('dash_verify_email_desc')}</p>
        <button
          onClick={() => signOut(auth).then(() => navigate('/login'))}
          className="mt-6 rounded-lg bg-teal-700 px-6 py-2 text-sm font-medium text-white hover:bg-teal-800"
        >
          {t('dash_back_to_login')}
        </button>
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
      <div className="mx-auto max-w-lg py-12 sm:py-20 px-4 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-full bg-amber-50">
          <svg viewBox="0 0 24 24" fill="none" stroke="#a28657" strokeWidth="2" className="h-7 w-7 sm:h-8 sm:w-8">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </div>
        <h2 className="text-lg sm:text-xl font-bold text-teal-900">{t('dash_account_created')}</h2>
        <p className="mt-3 sm:mt-4 text-sm text-gray-500">{t('dash_pending_verification')}</p>
        <button
          onClick={() => signOut(auth).then(() => navigate('/'))}
          className="mt-6 rounded-lg bg-teal-700 px-6 py-2 text-sm font-medium text-white hover:bg-teal-800"
        >
          {t('dash_back_to_login')}
        </button>
      </div>
    );
  }

  // Compute stats from loans if Cloud Function didn't return them
  const pendingCount = loans.filter((l) => l.status === 'pending').length;
  const activeCount = stats.activeLoans ?? loans.filter((l) => l.status === 'approved' || l.status === 'active').length;
  const totalDisbursed = stats.totalDisbursed ?? loans.filter((l) => l.status !== 'rejected' && l.status !== 'pending').reduce((s, l) => s + l.amount, 0);
  const totalEmployees = stats.totalEmployees ?? employer?.totalEmployees ?? 0;

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

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 8 }} className="dash-header">
        <h1>{employer?.companyName}</h1>
        <div className="dash-user">
          <span>
            {t('dash_employer_code')}: <strong>{employer?.employerCode}</strong>
          </span>
          <div className="dash-avatar">
            {employer?.name?.charAt(0) || 'E'}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="dash-content">
        {/* ── Premium Employer Stats ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 40 }}>
          {[
            {
              label: t('dash_total_employees'),
              value: String(totalEmployees),
              icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a8d5d0" strokeWidth="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>,
              accent: 'rgba(168,213,208,0.1)',
            },
            {
              label: t('dash_active_loans'),
              value: String(activeCount),
              icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#247a6e" strokeWidth="1.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
              accent: 'rgba(36,122,110,0.06)',
            },
            {
              label: t('dash_pending_requests'),
              value: String(pendingCount),
              icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a28657" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>,
              accent: 'rgba(162,134,87,0.06)',
            },
            {
              label: t('dash_total_disbursed'),
              value: '$' + fmt(totalDisbursed),
              sub: 'MXN',
              icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#194445" strokeWidth="1.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
              accent: 'rgba(25,68,69,0.04)',
            },
          ].map((stat, i) => (
            <div key={i} style={{
              background: '#fff', borderRadius: 20, padding: '24px 24px 20px',
              border: '1px solid rgba(25,68,69,0.04)',
              transition: 'all 0.3s cubic-bezier(0.22,1,0.36,1)',
              position: 'relative', overflow: 'hidden',
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12, background: stat.accent,
                display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
              }}>
                {stat.icon}
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase' as const, color: 'var(--gold)', marginBottom: 8 }}>
                {stat.label}
              </div>
              <div style={{ fontFamily: 'var(--df)', fontSize: 36, color: 'var(--t1)', letterSpacing: '-0.03em', lineHeight: 1 }}>
                {stat.value}
              </div>
              {stat.sub && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>{stat.sub}</div>}
            </div>
          ))}
        </div>

        {/* Payroll + CURP config moved below loans */}

        {/* Loans Table */}
        <div className="card">
          <div className="card-title">{t('dash_recent_loans')}</div>

          {/* Tabs */}
          <div className="dash-tabs" style={{ display: 'flex', gap: 0, borderBottom: '1px solid rgba(25,68,69,0.08)', marginBottom: 20 }}>
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`dash-tab-btn${activeTab === tab.key ? ' dash-tab-active' : ''}`}
                style={{
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: activeTab === tab.key ? 700 : 500,
                  color: activeTab === tab.key ? 'var(--brand)' : 'var(--t3)',
                  background: 'none',
                  border: 'none',
                  borderBottom: activeTab === tab.key ? '2px solid var(--brand)' : '2px solid transparent',
                  cursor: 'pointer',
                  transition: 'all .2s',
                }}
              >
                {tab.label} ({tabCount(tab.key)})
              </button>
            ))}
          </div>

          {loading ? (
            <div style={{ padding: 20 }}>
              <SkeletonRows rows={3} />
            </div>
          ) : filteredLoans.length === 0 ? (
            <div className="empty-state">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
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
                      <td>{loan.termDays ?? 30} {t('dash_days')}</td>
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
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              disabled={actionLoading === loan.id}
                              onClick={() => handleLoanAction(loan.id, 'approved')}
                              style={{
                                padding: '5px 12px', fontSize: 12, fontWeight: 600,
                                background: 'var(--brand, var(--brand))', color: '#fff',
                                border: 'none', borderRadius: 8, cursor: 'pointer',
                                opacity: actionLoading === loan.id ? 0.5 : 1,
                              }}
                            >
                              {actionLoading === loan.id ? '...' : t('dash_approve', 'Aprobar')}
                            </button>
                            <button
                              disabled={actionLoading === loan.id}
                              onClick={() => handleLoanAction(loan.id, 'rejected')}
                              style={{
                                padding: '5px 12px', fontSize: 12, fontWeight: 600,
                                background: 'transparent', color: 'var(--danger)',
                                border: '1px solid #c1121f', borderRadius: 8, cursor: 'pointer',
                                opacity: actionLoading === loan.id ? 0.5 : 1,
                              }}
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
        </div>

        {/* Payroll Deduction Setup (Part B) — below loans for cleaner dashboard */}
        {employer?.partBStatus !== 'completed' && (
          <PayrollDeductionCard
            uid={user!.uid}
            employer={employer!}
            onSubmitted={() => setEmployer(prev => prev ? { ...prev, partBStatus: 'pending' } : prev)}
          />
        )}

        {/* CURP Configuration — below loans */}
        <CurpConfigCard
          employer={employer!}
          onUpdated={(config) => setEmployer(prev => prev ? { ...prev, curpConfig: config } : prev)}
        />

      </div>
    </div>
  );
}
