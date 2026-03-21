import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import {
  doc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  limit,
  serverTimestamp,
  increment,
} from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { auth, db, storage } from '../lib/firebase';
import { VidaLogo } from '../components/shared/VidaLogo';
import i18n from '../i18n';

type Role = 'employer' | 'employee' | null;

interface OnboardingState {
  company: string;
  name: string;
  email: string;
  size: string;
  payroll: string;
  salary: number;
  credit: number;
  code: string;
}

interface EmployerDoc {
  id: string;
  companyName: string;
}

const PAYROLL_SYSTEMS = ['Nomipaq', 'Aspel NOI', 'CONTPAQi', 'Workday', 'ADP'];
const SIZE_OPTIONS = ['1-50', '50-200', '200-500', '500+'];

function generateEmployerCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function passwordStrength(pw: string): { level: 'weak' | 'medium' | 'strong'; score: number } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length < 6 || score === 0) return { level: 'weak', score };
  if (score <= 2) return { level: 'medium', score };
  return { level: 'strong', score };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function parseMoney(s: string): number {
  return Number(s.replace(/[^0-9]/g, '')) || 0;
}

function RichText({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Onboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [, setPrevStep] = useState(-1);
  const [role, setRole] = useState<Role>(null);
  const [data, setData] = useState<OnboardingState>({
    company: '',
    name: '',
    email: '',
    size: '',
    payroll: '',
    salary: 0,
    credit: 0,
    code: '',
  });

  // Employer doc uploads
  const [docs, setDocs] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Employee employer lookup
  const [employerDoc, setEmployerDoc] = useState<EmployerDoc | null>(null);
  const [codeStatus, setCodeStatus] = useState<'idle' | 'searching' | 'found' | 'not_found'>('idle');
  const codeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Account creation
  const [password, setPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Celebration
  const [countUpValue, setCountUpValue] = useState(0);

  const totalSteps = role === 'employer' ? 6 : 5;
  const progress = role ? (step / totalSteps) * 100 : 0;

  const goTo = useCallback(
    (next: number) => {
      setPrevStep(step);
      setStep(next);
      setError('');
    },
    [step]
  );

  const goBack = useCallback(() => {
    if (step === 1 && role) {
      setRole(null);
      goTo(0);
    } else if (step > 0) {
      goTo(step - 1);
    }
  }, [step, role, goTo]);

  const toggleLang = () => {
    const next = i18n.language === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
  };

  // Employee: debounced employer code lookup
  const lookupCode = useCallback(
    (code: string) => {
      if (codeTimerRef.current) clearTimeout(codeTimerRef.current);
      if (code.length < 4) {
        setCodeStatus('idle');
        setEmployerDoc(null);
        return;
      }
      setCodeStatus('searching');
      codeTimerRef.current = setTimeout(async () => {
        try {
          const q = query(
            collection(db, 'employers'),
            where('employerCode', '==', code),
            limit(1)
          );
          const snap = await getDocs(q);
          if (!snap.empty) {
            const d = snap.docs[0];
            setEmployerDoc({ id: d.id, companyName: d.data().companyName });
            setCodeStatus('found');
          } else {
            setEmployerDoc(null);
            setCodeStatus('not_found');
          }
        } catch {
          setCodeStatus('not_found');
          setEmployerDoc(null);
        }
      }, 500);
    },
    []
  );

  // File upload handler
  const handleFileUpload = async (key: string, file: File) => {
    const tempId = `temp_${Date.now()}`;
    const storageRef = ref(storage, `employers/${tempId}/docs/${key}_${Date.now()}`);
    setUploading((prev) => ({ ...prev, [key]: true }));
    setUploadProgress((prev) => ({ ...prev, [key]: 0 }));

    const task = uploadBytesResumable(storageRef, file);
    task.on(
      'state_changed',
      (snapshot) => {
        const pct = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        setUploadProgress((prev) => ({ ...prev, [key]: pct }));
      },
      () => {
        setUploading((prev) => ({ ...prev, [key]: false }));
      },
      async () => {
        const url = await getDownloadURL(task.snapshot.ref);
        setDocs((prev) => ({ ...prev, [key]: url }));
        setUploading((prev) => ({ ...prev, [key]: false }));
      }
    );
  };

  // Employer account creation
  const createEmployerAccount = async () => {
    setCreating(true);
    setError('');
    try {
      const cred = await createUserWithEmailAndPassword(auth, data.email, password);
      const uid = cred.user.uid;
      await setDoc(doc(db, 'employers', uid), {
        name: data.name,
        companyName: data.company,
        email: data.email,
        employerCode: generateEmployerCode(),
        companySize: data.size,
        payrollSystem: data.payroll,
        status: 'pending_verification',
        docRFC: docs.rfc || null,
        docId: docs.id_oficial || null,
        docAddress: docs.comprobante || null,
        submittedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        totalEmployees: 0,
        activeLoans: 0,
        totalDisbursed: 0,
      });
      goTo(6);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Account creation failed');
    } finally {
      setCreating(false);
    }
  };

  // Employee account creation
  const createEmployeeAccount = async () => {
    if (!employerDoc) return;
    setCreating(true);
    setError('');
    try {
      const credit = Math.max(500, Math.min(Math.round(((data.salary || 15000) * 0.3) / 100) * 100, 5000));
      const cred = await createUserWithEmailAndPassword(auth, data.email, password);
      const uid = cred.user.uid;
      await setDoc(doc(db, 'employees', uid), {
        name: data.name,
        email: data.email,
        employerId: employerDoc.id,
        employerName: employerDoc.companyName,
        monthlySalary: data.salary || 15000,
        creditLimit: credit,
        availableCredit: credit,
        createdAt: serverTimestamp(),
      });
      // Increment employer's totalEmployees
      await updateDoc(doc(db, 'employers', employerDoc.id), {
        totalEmployees: increment(1),
      });
      setData((prev) => ({ ...prev, credit }));
      goTo(5);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Account creation failed');
    } finally {
      setCreating(false);
    }
  };

  // Count-up animation for employee celebration
  useEffect(() => {
    if (role === 'employee' && step === 5 && data.credit > 0) {
      let start = 0;
      const target = data.credit;
      const duration = 1500;
      const startTime = performance.now();
      const animate = (now: number) => {
        const elapsed = now - startTime;
        const pct = Math.min(elapsed / duration, 1);
        start = Math.round(pct * target);
        setCountUpValue(start);
        if (pct < 1) requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);
    }
  }, [role, step, data.credit]);

  // Compute credit for display
  const computedCredit = Math.max(
    500,
    Math.min(Math.round(((data.salary || 15000) * 0.3) / 100) * 100, 5000)
  );
  const ringOffset = 565 - (computedCredit / 5000) * 565;

  const stageClass = (stageStep: number) => {
    if (stageStep === step) return 'onb-stage active';
    if (stageStep < step) return 'onb-stage left';
    return 'onb-stage right';
  };

  // Validation helpers
  const canProceedEmployerStep = (s: number) => {
    switch (s) {
      case 1:
        return data.company.trim().length >= 2;
      case 2:
        return data.name.trim().length >= 2 && data.email.includes('@');
      case 3:
        return data.size !== '' && data.payroll !== '';
      case 4:
        return Object.keys(docs).length >= 3;
      case 5:
        return password.length >= 6 && termsAccepted;
      default:
        return true;
    }
  };

  const canProceedEmployeeStep = (s: number) => {
    switch (s) {
      case 1:
        return data.code.length >= 4 && codeStatus === 'found';
      case 2:
        return data.name.trim().length >= 2 && data.email.includes('@');
      case 3:
        return data.salary > 0;
      case 4:
        return password.length >= 6 && termsAccepted;
      default:
        return true;
    }
  };

  const pwStrength = passwordStrength(password);

  const docKeys = [
    { key: 'rfc', label: t('onb_e_step4_rfc') },
    { key: 'id_oficial', label: t('onb_e_step4_id') },
    { key: 'comprobante', label: t('onb_e_step4_address') },
  ];

  return (
    <div className="onb">
      <div className="onb-blob ob1" />
      <div className="onb-blob ob2" />

      {/* Top bar */}
      <div className="onb-top">
        <Link to="/" className="onb-logo">
          <VidaLogo />
        </Link>
        <div className="onb-top-right">
          <Link to="/login">
            {t('onb_already_account')} <strong>{t('onb_login')}</strong>
          </Link>
          <button className="onb-lang" onClick={toggleLang}>
            {t('lang_toggle')}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="onb-progress">
        <div className="onb-progress-fill" style={{ width: `${progress}%` }} />
      </div>

      {/* Body */}
      <div className="onb-body">
        {/* Back button */}
        {step > 0 && !(role === 'employer' && step === 6) && !(role === 'employee' && step === 5) && (
          <button className="onb-back" onClick={goBack}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        )}

        {/* Step 0: Role selection */}
        <div className={stageClass(0)}>
          <div className="onb-content wide">
            <h1 className="onb-h">
              <RichText html={t('onb_welcome')} />
            </h1>
            <p className="onb-sub">{t('onb_welcome_sub')}</p>

            <div className="onb-roles">
              <button
                className={`onb-role ${role === 'employer' ? 'selected' : ''}`}
                onClick={() => {
                  setRole('employer');
                  goTo(1);
                }}
              >
                <div className="onb-role-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 21h18M3 7v14M21 7v14M6 11h4M6 15h4M14 11h4M14 15h4M9 21v-4h6v4M12 3l9 4H3l9-4z" />
                  </svg>
                </div>
                <div className="onb-role-title">{t('onb_role_employer_title')}</div>
                <div className="onb-role-desc">{t('onb_role_employer_desc')}</div>
              </button>

              <button
                className={`onb-role ${role === 'employee' ? 'selected' : ''}`}
                onClick={() => {
                  setRole('employee');
                  goTo(1);
                }}
              >
                <div className="onb-role-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
                  </svg>
                </div>
                <div className="onb-role-title">{t('onb_role_employee_title')}</div>
                <div className="onb-role-desc">{t('onb_role_employee_desc')}</div>
              </button>
            </div>
          </div>
        </div>

        {/* ===== EMPLOYER FLOW ===== */}
        {role === 'employer' && (
          <>
            {/* Step 1: Company name */}
            <div className={stageClass(1)}>
              <div className="onb-content">
                <h1 className="onb-h">
                  <RichText html={t('onb_e_step1_h')} />
                </h1>
                <p className="onb-sub">{t('onb_e_step1_sub')}</p>
                <div className="onb-field">
                  <input
                    className="onb-input"
                    type="text"
                    placeholder={t('onb_e_step1_placeholder')}
                    value={data.company}
                    onChange={(e) => setData({ ...data, company: e.target.value })}
                    autoFocus
                  />
                </div>
                <button
                  className="onb-btn"
                  disabled={!canProceedEmployerStep(1)}
                  onClick={() => goTo(2)}
                >
                  {t('onb_next')}
                </button>
              </div>
            </div>

            {/* Step 2: Admin contact */}
            <div className={stageClass(2)}>
              <div className="onb-content">
                <h1 className="onb-h">
                  <RichText html={t('onb_e_step2_h')} />
                </h1>
                <p className="onb-sub">{t('onb_e_step2_sub')}</p>
                <div className="onb-field">
                  <label className="onb-label">{t('onb_e_step2_name')}</label>
                  <input
                    className="onb-input"
                    type="text"
                    placeholder={t('onb_e_step2_name_ph')}
                    value={data.name}
                    onChange={(e) => setData({ ...data, name: e.target.value })}
                  />
                </div>
                <div className="onb-field">
                  <label className="onb-label">{t('onb_e_step2_email')}</label>
                  <input
                    className="onb-input"
                    type="email"
                    placeholder={t('onb_e_step2_email_ph')}
                    value={data.email}
                    onChange={(e) => setData({ ...data, email: e.target.value })}
                  />
                </div>
                <button
                  className="onb-btn"
                  disabled={!canProceedEmployerStep(2)}
                  onClick={() => goTo(3)}
                >
                  {t('onb_next')}
                </button>
              </div>
            </div>

            {/* Step 3: Company size + payroll */}
            <div className={stageClass(3)}>
              <div className="onb-content">
                <h1 className="onb-h">
                  <RichText html={t('onb_e_step3_h')} />
                </h1>
                <p className="onb-sub">{t('onb_e_step3_sub')}</p>
                <div className="onb-field">
                  <label className="onb-label">{t('onb_e_step3_size')}</label>
                  <div className="onb-tiles">
                    {SIZE_OPTIONS.map((sz) => (
                      <button
                        key={sz}
                        className={`onb-tile ${data.size === sz ? 'active' : ''}`}
                        onClick={() => setData({ ...data, size: sz })}
                      >
                        <div className="onb-tile-val">{sz}</div>
                        <div className="onb-tile-lbl">{t('onb_e_step3_employees')}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="onb-field">
                  <label className="onb-label">{t('onb_e_step3_payroll')}</label>
                  <select
                    className="onb-select"
                    value={data.payroll}
                    onChange={(e) => setData({ ...data, payroll: e.target.value })}
                  >
                    <option value="">{t('onb_e_step3_payroll_ph')}</option>
                    {PAYROLL_SYSTEMS.map((ps) => (
                      <option key={ps} value={ps}>
                        {ps}
                      </option>
                    ))}
                    <option value="Otro">{t('onb_e_step3_payroll_other')}</option>
                  </select>
                </div>
                <button
                  className="onb-btn"
                  disabled={!canProceedEmployerStep(3)}
                  onClick={() => goTo(4)}
                >
                  {t('onb_next')}
                </button>
              </div>
            </div>

            {/* Step 4: Document uploads */}
            <div className={stageClass(4)}>
              <div className="onb-content">
                <h1 className="onb-h">
                  <RichText html={t('onb_e_step4_h')} />
                </h1>
                <p className="onb-sub">{t('onb_e_step4_sub')}</p>
                <div className="onb-uploads">
                  {docKeys.map(({ key, label }) => (
                    <div key={key} className="onb-upload-row">
                      <div className="onb-upload-info">
                        <div className="onb-upload-label">{label}</div>
                        <div className="onb-upload-hint">{t('onb_e_step4_formats')}</div>
                      </div>
                      <button
                        className={`onb-upload-btn ${
                          docs[key] ? 'done' : uploading[key] ? 'uploading' : ''
                        }`}
                        onClick={() => fileInputRefs.current[key]?.click()}
                        disabled={!!uploading[key]}
                      >
                        {docs[key]
                          ? t('onb_e_step4_done')
                          : uploading[key]
                          ? t('onb_e_step4_uploading')
                          : t('onb_e_step4_upload')}
                      </button>
                      <input
                        ref={(el) => { fileInputRefs.current[key] = el; }}
                        type="file"
                        accept="image/*,application/pdf"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleFileUpload(key, file);
                        }}
                      />
                      {uploading[key] && (
                        <div className="onb-upload-progress">
                          <div
                            className="onb-upload-progress-fill"
                            style={{ width: `${uploadProgress[key] || 0}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  className="onb-btn"
                  disabled={!canProceedEmployerStep(4)}
                  onClick={() => goTo(5)}
                >
                  {t('onb_next')}
                </button>
              </div>
            </div>

            {/* Step 5: Create account */}
            <div className={stageClass(5)}>
              <div className="onb-content">
                <h1 className="onb-h">
                  <RichText html={t('onb_e_step5_h')} />
                </h1>
                <p className="onb-sub">{t('onb_e_step5_sub')}</p>
                <div className="onb-field">
                  <label className="onb-label">{t('onb_e_step5_pass')}</label>
                  <input
                    className="onb-input"
                    type="password"
                    placeholder={t('onb_e_step5_pass_ph')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={6}
                  />
                  {password.length > 0 && (
                    <div className="onb-strength">
                      <div className={`onb-strength-fill ${pwStrength.level}`} />
                    </div>
                  )}
                </div>
                <div className="onb-terms">
                  <input
                    type="checkbox"
                    id="terms-employer"
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                  />
                  <label htmlFor="terms-employer">
                    {t('onb_e_step5_terms')}{' '}
                    <Link to="/terms">{t('onb_e_step5_terms_link')}</Link>
                  </label>
                </div>
                {error && <div className="onb-error show">{error}</div>}
                <button
                  className="onb-btn"
                  disabled={!canProceedEmployerStep(5) || creating}
                  onClick={createEmployerAccount}
                >
                  {creating ? t('onb_e_step5_creating') : t('onb_e_step5_btn')}
                </button>
              </div>
            </div>

            {/* Step 6: Verification pending */}
            <div className={stageClass(6)}>
              <div className="onb-content">
                <div className="onb-celebration">
                  <div className="onb-check-circle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                  </div>
                  <h1 className="onb-h">
                    <RichText html={t('onb_e_step6_h')} />
                  </h1>
                  <p className="onb-sub">{t('onb_e_step6_sub')}</p>
                  <div className="onb-approved-tag">
                    <span className="onb-approved-dot" />
                    {t('onb_e_step6_badge')}
                  </div>
                  <button className="onb-btn secondary" onClick={() => navigate('/')}>
                    {t('onb_e_step6_cta')}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ===== EMPLOYEE FLOW ===== */}
        {role === 'employee' && (
          <>
            {/* Step 1: Employer code */}
            <div className={stageClass(1)}>
              <div className="onb-content">
                <h1 className="onb-h">
                  <RichText html={t('onb_m_step1_h')} />
                </h1>
                <p className="onb-sub">{t('onb_m_step1_sub')}</p>
                <div className="onb-field">
                  <input
                    className={`onb-input big ${
                      codeStatus === 'found'
                        ? 'valid'
                        : codeStatus === 'not_found'
                        ? 'invalid'
                        : ''
                    }`}
                    type="text"
                    maxLength={8}
                    placeholder={t('onb_m_step1_placeholder')}
                    value={data.code}
                    onChange={(e) => {
                      const code = e.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, '');
                      setData({ ...data, code });
                      lookupCode(code);
                    }}
                    autoFocus
                  />
                  {codeStatus === 'searching' && (
                    <div className="onb-input-hint">{t('onb_m_step1_searching')}</div>
                  )}
                  {codeStatus === 'found' && employerDoc && (
                    <div className="onb-input-hint success">
                      {t('onb_m_step1_found')}: {employerDoc.companyName}
                    </div>
                  )}
                  {codeStatus === 'not_found' && (
                    <div className="onb-input-hint error">{t('onb_m_step1_not_found')}</div>
                  )}
                  <div className="onb-input-hint" style={{ marginTop: 16 }}>
                    {t('onb_m_step1_hint')}
                  </div>
                </div>
                <button
                  className="onb-btn"
                  disabled={!canProceedEmployeeStep(1)}
                  onClick={() => goTo(2)}
                >
                  {t('onb_next')}
                </button>
              </div>
            </div>

            {/* Step 2: Personal info */}
            <div className={stageClass(2)}>
              <div className="onb-content">
                <h1 className="onb-h">
                  <RichText html={t('onb_m_step2_h')} />
                </h1>
                <p className="onb-sub">{t('onb_m_step2_sub')}</p>
                <div className="onb-field">
                  <label className="onb-label">{t('onb_m_step2_name')}</label>
                  <input
                    className="onb-input"
                    type="text"
                    placeholder={t('onb_m_step2_name_ph')}
                    value={data.name}
                    onChange={(e) => setData({ ...data, name: e.target.value })}
                  />
                </div>
                <div className="onb-field">
                  <label className="onb-label">{t('onb_m_step2_email')}</label>
                  <input
                    className="onb-input"
                    type="email"
                    placeholder={t('onb_m_step2_email_ph')}
                    value={data.email}
                    onChange={(e) => setData({ ...data, email: e.target.value })}
                  />
                </div>
                <button
                  className="onb-btn"
                  disabled={!canProceedEmployeeStep(2)}
                  onClick={() => goTo(3)}
                >
                  {t('onb_next')}
                </button>
              </div>
            </div>

            {/* Step 3: Salary + Credit simulation */}
            <div className={stageClass(3)}>
              <div className="onb-content">
                <h1 className="onb-h">
                  <RichText html={t('onb_m_step3_h')} />
                </h1>
                <p className="onb-sub">{t('onb_m_step3_sub')}</p>
                <div className="onb-field">
                  <label className="onb-label">{t('onb_m_step3_salary')}</label>
                  <input
                    className="onb-input"
                    type="text"
                    inputMode="numeric"
                    placeholder={t('onb_m_step3_salary_ph')}
                    value={data.salary ? fmt(data.salary) : ''}
                    onChange={(e) => setData({ ...data, salary: parseMoney(e.target.value) })}
                  />
                </div>
                <div className="onb-credit-sim">
                  <div className="onb-ring-wrap">
                    <svg viewBox="0 0 200 200">
                      <circle className="onb-ring-bg" cx="100" cy="100" r="90" />
                      <circle
                        className="onb-ring-fill"
                        cx="100"
                        cy="100"
                        r="90"
                        style={{ strokeDashoffset: data.salary > 0 ? ringOffset : 565 }}
                      />
                    </svg>
                    <div className="onb-ring-text">
                      <div className="onb-ring-amount">
                        ${data.salary > 0 ? fmt(computedCredit) : '0'}
                      </div>
                      <div className="onb-ring-label">{t('onb_m_step3_credit_label')}</div>
                    </div>
                  </div>
                  {data.salary > 0 && (
                    <div className="onb-approved-tag">
                      <span className="onb-approved-dot" />
                      {t('onb_m_step3_preapproved')}
                    </div>
                  )}
                </div>
                <button
                  className="onb-btn"
                  disabled={!canProceedEmployeeStep(3)}
                  onClick={() => goTo(4)}
                >
                  {t('onb_next')}
                </button>
              </div>
            </div>

            {/* Step 4: Create account */}
            <div className={stageClass(4)}>
              <div className="onb-content">
                <h1 className="onb-h">
                  <RichText html={t('onb_m_step4_h')} />
                </h1>
                <p className="onb-sub">{t('onb_m_step4_sub')}</p>
                <div className="onb-field">
                  <label className="onb-label">{t('onb_m_step4_pass')}</label>
                  <input
                    className="onb-input"
                    type="password"
                    placeholder={t('onb_m_step4_pass_ph')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={6}
                  />
                  {password.length > 0 && (
                    <div className="onb-strength">
                      <div className={`onb-strength-fill ${pwStrength.level}`} />
                    </div>
                  )}
                </div>
                <div className="onb-terms">
                  <input
                    type="checkbox"
                    id="terms-employee"
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                  />
                  <label htmlFor="terms-employee">
                    {t('onb_m_step4_terms')}{' '}
                    <Link to="/terms">{t('onb_m_step4_terms_link')}</Link>
                  </label>
                </div>
                {error && <div className="onb-error show">{error}</div>}
                <button
                  className="onb-btn"
                  disabled={!canProceedEmployeeStep(4) || creating}
                  onClick={createEmployeeAccount}
                >
                  {creating ? t('onb_m_step4_creating') : t('onb_m_step4_btn')}
                </button>
              </div>
            </div>

            {/* Step 5: Credit approved celebration */}
            <div className={stageClass(5)}>
              <div className="onb-content">
                <div className="onb-celebration">
                  <div className="onb-check-circle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </div>
                  <h1 className="onb-h">
                    <RichText html={t('onb_m_step5_h')} />
                  </h1>
                  <p className="onb-sub">{t('onb_m_step5_sub')}</p>
                  <div className="onb-approved-tag">
                    <span className="onb-approved-dot" />
                    {t('onb_m_step5_tag')}
                  </div>
                  <div className="onb-big-amount">
                    <span className="onb-cur">$</span>
                    {fmt(countUpValue)}
                  </div>
                  <button
                    className="onb-btn"
                    onClick={() => navigate('/employee')}
                    style={{ marginTop: 32 }}
                  >
                    {t('onb_m_step5_cta')}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
