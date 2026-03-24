import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { auth, db } from '../lib/firebase';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import {
  doc,
  setDoc,
  collection,
  query,
  where,
  getDocs,
  updateDoc,
  increment,
  serverTimestamp,
} from 'firebase/firestore';


type Role = 'employer' | 'employee' | null;

interface EmployerData {
  company: string;
  name: string;
  email: string;
  companySize: string;
  payrollSystem: string;
  docRFC: string;
  docId: string;
  docAddress: string;
  password: string;
  terms: boolean;
}

interface EmployeeData {
  code: string;
  employerId: string;
  employerName: string;
  name: string;
  email: string;
  salary: string;
  password: string;
  terms: boolean;
}

const COMPANY_SIZES = ['1-50', '51-200', '201-500', '500+'];
const PAYROLL_SYSTEMS = ['Nomipaq', 'Aspel NOI', 'CONTPAQi', 'Workday', 'ADP'];

function generateEmployerCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function getPasswordStrength(pw: string): 'weak' | 'medium' | 'strong' {
  if (pw.length < 6) return 'weak';
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return 'weak';
  if (score <= 2) return 'medium';
  return 'strong';
}

function RichText({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function PasswordStrengthBar({ password, t }: { password: string; t: (k: string) => string }) {
  const strength = getPasswordStrength(password);
  const labelMap = { weak: t('onb_strength_weak'), medium: t('onb_strength_medium'), strong: t('onb_strength_strong') };

  if (!password) return null;
  return (
    <>
      <div className="onb-strength">
        <div className={`onb-strength-fill ${strength}`} />
      </div>
      <div className="onb-input-hint">{labelMap[strength]}</div>
    </>
  );
}

export function Onboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [role, setRole] = useState<Role>(null);
  const [step, setStep] = useState(0);
  const [, setDirection] = useState<'left' | 'right'>('right');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Employer state
  const [empData, setEmpData] = useState<EmployerData>({
    company: '', name: '', email: '', companySize: '', payrollSystem: '',
    docRFC: '', docId: '', docAddress: '', password: '', terms: false,
  });
  // Employee state
  const [memData, setMemData] = useState<EmployeeData>({
    code: '', employerId: '', employerName: '', name: '', email: '',
    salary: '', password: '', terms: false,
  });
  const [codeStatus, setCodeStatus] = useState<'idle' | 'searching' | 'found' | 'not_found'>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const totalSteps = role === 'employer' ? 5 : role === 'employee' ? 5 : 0;

  const goForward = useCallback((toStep: number) => {
    setDirection('right');
    setStep(toStep);
    setError('');
  }, []);

  const goBack = useCallback(() => {
    setError('');
    if (step <= 1) {
      setRole(null);
      setStep(0);
    } else {
      setDirection('left');
      setStep((s) => s - 1);
    }
  }, [step]);

  // Escape key goes back
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') goBack();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goBack]);

  const selectRole = (r: Role) => {
    setRole(r);
    setDirection('right');
    setStep(1);
  };

  // -- Employer code lookup for employee flow --
  const lookupCode = useCallback(async (code: string) => {
    if (code.length < 4) {
      setCodeStatus('idle');
      return;
    }
    setCodeStatus('searching');
    try {
      const q = query(collection(db, 'employers'), where('employerCode', '==', code.toUpperCase()));
      const snap = await getDocs(q);
      if (!snap.empty) {
        const empDoc = snap.docs[0];
        setMemData((d) => ({
          ...d,
          employerId: empDoc.id,
          employerName: empDoc.data().companyName,
        }));
        setCodeStatus('found');
      } else {
        setCodeStatus('not_found');
      }
    } catch {
      setCodeStatus('not_found');
    }
  }, []);

  const handleCodeChange = (val: string) => {
    const upper = val.toUpperCase().slice(0, 8);
    setMemData((d) => ({ ...d, code: upper }));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => lookupCode(upper), 500);
  };

  // -- Employer account creation --
  const createEmployerAccount = async () => {
    setCreating(true);
    setError('');
    try {
      const cred = await createUserWithEmailAndPassword(auth, empData.email, empData.password);
      // Force token refresh so Firestore picks up the new auth state
      await cred.user.getIdToken(true);
      const uid = cred.user.uid;
      await setDoc(doc(db, 'employers', uid), {
        name: empData.name,
        companyName: empData.company,
        email: empData.email,
        employerCode: generateEmployerCode(),
        companySize: empData.companySize,
        payrollSystem: empData.payrollSystem,
        status: 'pending_verification',
        docRFC: null,
        docId: null,
        docAddress: null,
        submittedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        totalEmployees: 0,
        activeLoans: 0,
        totalDisbursed: 0,
      });
      goForward(5);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error creating account');
    } finally {
      setCreating(false);
    }
  };

  // -- Employee account creation --
  const createEmployeeAccount = async () => {
    setCreating(true);
    setError('');
    try {
      const salaryNum = parseFloat(memData.salary.replace(/,/g, ''));
      const creditLimit = Math.min(salaryNum * 0.3, 5000);
      const cred = await createUserWithEmailAndPassword(auth, memData.email, memData.password);
      // Force token refresh so Firestore picks up the new auth state
      await cred.user.getIdToken(true);
      const uid = cred.user.uid;
      await setDoc(doc(db, 'employees', uid), {
        name: memData.name,
        email: memData.email,
        employerId: memData.employerId,
        employerName: memData.employerName,
        monthlySalary: salaryNum,
        creditLimit,
        availableCredit: creditLimit,
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, 'employers', memData.employerId), {
        totalEmployees: increment(1),
      });
      goForward(5);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error creating account');
    } finally {
      setCreating(false);
    }
  };

  // -- Compute credit for employee flow --
  const salaryNum = parseFloat((memData.salary || '0').replace(/,/g, ''));
  const creditAmount = Math.min(Math.max(salaryNum * 0.3, 0), 5000);

  // -- Step validation --
  const canProceed = (): boolean => {
    if (role === 'employer') {
      if (step === 1) return empData.company.trim().length > 0;
      if (step === 2) return empData.name.trim().length > 0 && /\S+@\S+\.\S+/.test(empData.email);
      if (step === 3) return empData.companySize !== '' && empData.payrollSystem !== '';
      if (step === 4) return empData.password.length >= 6 && empData.terms;
    }
    if (role === 'employee') {
      if (step === 1) return codeStatus === 'found';
      if (step === 2) return memData.name.trim().length > 0 && /\S+@\S+\.\S+/.test(memData.email);
      if (step === 3) return salaryNum > 0;
      if (step === 4) return memData.password.length >= 6 && memData.terms;
    }
    return false;
  };

  const handleNext = () => {
    if (role === 'employer' && step === 4) {
      createEmployerAccount();
    } else if (role === 'employee' && step === 4) {
      createEmployeeAccount();
    } else {
      goForward(step + 1);
    }
  };

  // -- Progress bar --
  const progressPct = totalSteps > 0 ? ((step) / totalSteps) * 100 : 0;

  // Is this a final success step?
  const isFinalStep = (role === 'employer' && step === 5) || (role === 'employee' && step === 5);

  // Action button config
  const getActionLabel = () => {
    if (role === 'employer' && step === 4) return creating ? t('onb_e_step5_creating') : t('onb_e_step5_btn');
    if (role === 'employee' && step === 4) return creating ? t('onb_m_step4_creating') : t('onb_m_step4_btn');
    return t('onb_next');
  };

  // Helper to get stage class for animation
  const stageClass = (stageStep: number) => {
    if (stageStep === step) return 'onb-stage active';
    if (stageStep < step) return 'onb-stage left';
    return 'onb-stage right';
  };

  // -- Render role selection (step 0) --
  const renderRoleSelection = () => (
    <div className="onb-content wide">
      <h1 className="onb-h">
        <RichText html={t('onb_welcome')} />
      </h1>
      <p className="onb-sub">{t('onb_welcome_sub')}</p>

      <div className="onb-chooser">
        <button className="onb-role" onClick={() => selectRole('employer')}>
          <div className="onb-role-icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="2" width="16" height="20" rx="2" />
              <path d="M9 22V12h6v10" />
              <path d="M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01" />
            </svg>
          </div>
          <div className="onb-role-title">{t('onb_role_employer_title')}</div>
          <div className="onb-role-desc">{t('onb_role_employer_desc')}</div>
        </button>
        <button className="onb-role" onClick={() => selectRole('employee')}>
          <div className="onb-role-icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <div className="onb-role-title">{t('onb_role_employee_title')}</div>
          <div className="onb-role-desc">{t('onb_role_employee_desc')}</div>
        </button>
      </div>

      <p className="onb-sub" style={{ marginTop: 32, marginBottom: 0, fontSize: 13 }}>
        {t('onb_already_account')}{' '}
        <Link to="/login"><strong>{t('onb_login')}</strong></Link>
      </p>
    </div>
  );

  // -- Render employer steps --
  const renderEmployerSteps = () => (
    <>
      {/* Step 1: Company name */}
      <div className={stageClass(1)}>
        {step === 1 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_e_step1_h')} /></h1>
            <p className="onb-sub">{t('onb_e_step1_sub')}</p>
            <div className="onb-field">
              <input
                autoFocus
                className="onb-input"
                placeholder={t('onb_e_step1_placeholder')}
                value={empData.company}
                onChange={(e) => setEmpData({ ...empData, company: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>

      {/* Step 2: Name + email */}
      <div className={stageClass(2)}>
        {step === 2 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_e_step2_h')} /></h1>
            <p className="onb-sub">{t('onb_e_step2_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step2_name')}</label>
              <input
                autoFocus
                className="onb-input"
                placeholder={t('onb_e_step2_name_ph')}
                value={empData.name}
                onChange={(e) => setEmpData({ ...empData, name: e.target.value })}
              />
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step2_email')}</label>
              <input
                type="email"
                className="onb-input"
                placeholder={t('onb_e_step2_email_ph')}
                value={empData.email}
                onChange={(e) => setEmpData({ ...empData, email: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>

      {/* Step 3: Company size + payroll */}
      <div className={stageClass(3)}>
        {step === 3 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_e_step3_h')} /></h1>
            <p className="onb-sub">{t('onb_e_step3_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step3_size')}</label>
              <div className="onb-size-grid">
                {COMPANY_SIZES.map((size) => (
                  <button
                    key={size}
                    className={`onb-tile${empData.companySize === size ? ' active' : ''}`}
                    onClick={() => setEmpData({ ...empData, companySize: size })}
                  >
                    <div className="onb-tile-val">{size}</div>
                    <div className="onb-tile-lbl">{t('onb_e_step3_employees')}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step3_payroll')}</label>
              <select
                className="onb-select"
                value={empData.payrollSystem}
                onChange={(e) => setEmpData({ ...empData, payrollSystem: e.target.value })}
              >
                <option value="">{t('onb_e_step3_payroll_ph')}</option>
                {PAYROLL_SYSTEMS.map((ps) => (
                  <option key={ps} value={ps}>{ps}</option>
                ))}
                <option value="Other">{t('onb_e_step3_payroll_other')}</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Step 4: Password + terms */}
      <div className={stageClass(4)}>
        {step === 4 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_e_step5_h')} /></h1>
            <p className="onb-sub">{t('onb_e_step5_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step5_pass')}</label>
              <input
                autoFocus
                type="password"
                className="onb-input"
                placeholder={t('onb_e_step5_pass_ph')}
                value={empData.password}
                onChange={(e) => setEmpData({ ...empData, password: e.target.value })}
              />
              <PasswordStrengthBar password={empData.password} t={t} />
            </div>
            <div className="onb-terms">
              <input
                type="checkbox"
                checked={empData.terms}
                onChange={(e) => setEmpData({ ...empData, terms: e.target.checked })}
              />
              <label>
                {t('onb_e_step5_terms')}{' '}
                <Link to="/terms" target="_blank">{t('onb_e_step5_terms_link')}</Link>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Step 5: Employer success */}
      <div className={stageClass(5)}>
        <div className="onb-content">
          <div className="onb-celebration">
            <div className="onb-check-circle">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h1 className="onb-h"><RichText html={t('onb_e_step6_h')} /></h1>
            <p className="onb-sub">{t('onb_e_step6_sub')}</p>
            <div className="onb-approved-tag">
              <span className="onb-approved-dot" />
              {t('onb_e_step6_badge')}
            </div>
            <button className="onb-btn" onClick={() => navigate('/')}>
              {t('onb_e_step6_cta')}
            </button>
          </div>
        </div>
      </div>
    </>
  );

  // -- Render employee steps --
  const renderEmployeeSteps = () => (
    <>
      {/* Step 1: Employer code */}
      <div className={stageClass(1)}>
        {step === 1 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_m_step1_h')} /></h1>
            <p className="onb-sub">{t('onb_m_step1_sub')}</p>
            <div className="onb-field">
              <input
                autoFocus
                className={`onb-input big${codeStatus === 'found' ? ' valid' : codeStatus === 'not_found' ? ' invalid' : ''}`}
                placeholder={t('onb_m_step1_placeholder')}
                maxLength={8}
                value={memData.code}
                onChange={(e) => handleCodeChange(e.target.value)}
              />
              <div className={`onb-input-hint${codeStatus === 'found' ? ' success' : codeStatus === 'not_found' ? ' error' : ''}`}>
                {codeStatus === 'searching' && t('onb_m_step1_searching')}
                {codeStatus === 'found' && `${t('onb_m_step1_found')}: ${memData.employerName}`}
                {codeStatus === 'not_found' && t('onb_m_step1_not_found')}
                {codeStatus === 'idle' && t('onb_m_step1_hint')}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Step 2: Name + email */}
      <div className={stageClass(2)}>
        {step === 2 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_m_step2_h')} /></h1>
            <p className="onb-sub">{t('onb_m_step2_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step2_name')}</label>
              <input
                autoFocus
                className="onb-input"
                placeholder={t('onb_m_step2_name_ph')}
                value={memData.name}
                onChange={(e) => setMemData({ ...memData, name: e.target.value })}
              />
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step2_email')}</label>
              <input
                type="email"
                className="onb-input"
                placeholder={t('onb_m_step2_email_ph')}
                value={memData.email}
                onChange={(e) => setMemData({ ...memData, email: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>

      {/* Step 3: Salary + credit preview */}
      <div className={stageClass(3)}>
        {step === 3 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_m_step3_h')} /></h1>
            <p className="onb-sub">{t('onb_m_step3_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step3_salary')}</label>
              <input
                autoFocus
                type="text"
                inputMode="numeric"
                className="onb-input"
                placeholder={t('onb_m_step3_salary_ph')}
                value={memData.salary}
                onChange={(e) => setMemData({ ...memData, salary: e.target.value.replace(/[^\d,]/g, '') })}
              />
            </div>
            {creditAmount > 0 && (
              <div className="onb-credit-sim">
                <div className="onb-ring-wrap">
                  <svg viewBox="0 0 200 200">
                    <circle className="onb-ring-bg" cx="100" cy="100" r="90" />
                    <circle
                      className="onb-ring-fill"
                      cx="100" cy="100" r="90"
                      style={{ strokeDashoffset: 565 - (565 * Math.min(creditAmount / 5000, 1)) }}
                    />
                  </svg>
                  <div className="onb-ring-text">
                    <div className="onb-ring-amount">
                      ${creditAmount.toLocaleString('en-US', { minimumFractionDigits: 0 })}
                    </div>
                    <div className="onb-ring-label">{t('onb_m_step3_credit_label')}</div>
                  </div>
                </div>
                <div className="onb-approved-tag">
                  <span className="onb-approved-dot" />
                  {t('onb_m_step3_preapproved')}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 4: Password + terms */}
      <div className={stageClass(4)}>
        {step === 4 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_m_step4_h')} /></h1>
            <p className="onb-sub">{t('onb_m_step4_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step4_pass')}</label>
              <input
                autoFocus
                type="password"
                className="onb-input"
                placeholder={t('onb_m_step4_pass_ph')}
                value={memData.password}
                onChange={(e) => setMemData({ ...memData, password: e.target.value })}
              />
              <PasswordStrengthBar password={memData.password} t={t} />
            </div>
            <div className="onb-terms">
              <input
                type="checkbox"
                checked={memData.terms}
                onChange={(e) => setMemData({ ...memData, terms: e.target.checked })}
              />
              <label>
                {t('onb_m_step4_terms')}{' '}
                <Link to="/terms" target="_blank">{t('onb_m_step4_terms_link')}</Link>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Step 5: Employee success */}
      <div className={stageClass(5)}>
        <div className="onb-content">
          <div className="onb-celebration">
            <div className="onb-check-circle">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h1 className="onb-h"><RichText html={t('onb_m_step5_h')} /></h1>
            <p className="onb-sub">{t('onb_m_step5_sub')}</p>
            <div className="onb-approved-tag">
              <span className="onb-approved-dot" />
              {t('onb_m_step5_tag')}
            </div>
            <div className="onb-big-amount">
              <span className="onb-cur">$</span>
              {creditAmount.toLocaleString('en-US', { minimumFractionDigits: 0 })}
            </div>
            <p className="onb-sub" style={{ marginBottom: 0 }}>MXN</p>
            <button className="onb-btn" onClick={() => navigate('/employee')}>
              {t('onb_m_step5_cta')}
            </button>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg1, #faf9f7)' }}>
      {/* Background blobs */}
      <div className="onb-blob ob1" />
      <div className="onb-blob ob2" />

      {/* Top bar */}
      <div className="onb-top">
        <div className="onb-logo">
          <svg className="vida-logo" viewBox="0 0 80 14" height="14">
            <text x="0" y="12" fontFamily="var(--df)" fontSize="14" fontWeight="700" fill="var(--t1)">vida</text>
          </svg>
        </div>
        <div className="onb-top-right">
          <Link to="/login">
            {t('onb_already_account')} <strong>{t('onb_login')}</strong>
          </Link>
        </div>
      </div>

      {/* Progress bar */}
      <div className="onb-progress">
        <div className="onb-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      {/* Body */}
      <div className="onb-body">
        {/* Back button */}
        {role && !isFinalStep && (
          <button className="onb-back" onClick={goBack} aria-label="Go back">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}

        {/* Role selection stage */}
        <div className={!role ? 'onb-stage active' : 'onb-stage left'}>
          {renderRoleSelection()}
        </div>

        {/* Employer flow stages */}
        {role === 'employer' && renderEmployerSteps()}

        {/* Employee flow stages */}
        {role === 'employee' && renderEmployeeSteps()}
      </div>

      {/* Bottom action button */}
      {role && !isFinalStep && step >= 1 && (
        <div style={{ padding: '16px 20px', flexShrink: 0, position: 'relative', zIndex: 10 }}>
          <div className="onb-content" style={{ margin: '0 auto' }}>
            {error && <div className="onb-error show">{error}</div>}
            <button
              className="onb-btn"
              onClick={handleNext}
              disabled={!canProceed() || creating}
            >
              {getActionLabel()}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
