import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { auth, db, storage } from '../lib/firebase';
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
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

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

type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';

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
  const widthMap = { weak: '33%', medium: '66%', strong: '100%' };
  const colorMap = { weak: 'bg-red-400', medium: 'bg-yellow-400', strong: 'bg-emerald-500' };
  const labelMap = { weak: t('onb_strength_weak'), medium: t('onb_strength_medium'), strong: t('onb_strength_strong') };

  if (!password) return null;
  return (
    <div className="mt-2">
      <div className="h-1.5 w-full rounded-full bg-gray-200">
        <div
          className={`h-1.5 rounded-full transition-all duration-300 ${colorMap[strength]}`}
          style={{ width: widthMap[strength] }}
        />
      </div>
      <p className="mt-1 text-xs text-gray-500">{labelMap[strength]}</p>
    </div>
  );
}

export function Onboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [role, setRole] = useState<Role>(null);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Employer state
  const [empData, setEmpData] = useState<EmployerData>({
    company: '', name: '', email: '', companySize: '', payrollSystem: '',
    docRFC: '', docId: '', docAddress: '', password: '', terms: false,
  });
  const [uploadStatus, setUploadStatus] = useState<Record<string, UploadStatus>>({
    rfc: 'idle', id: 'idle', address: 'idle',
  });

  // Employee state
  const [memData, setMemData] = useState<EmployeeData>({
    code: '', employerId: '', employerName: '', name: '', email: '',
    salary: '', password: '', terms: false,
  });
  const [codeStatus, setCodeStatus] = useState<'idle' | 'searching' | 'found' | 'not_found'>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const totalSteps = role === 'employer' ? 6 : role === 'employee' ? 5 : 0;

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

  // -- File upload --
  const handleFileUpload = async (key: string, file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setUploadStatus((s) => ({ ...s, [key]: 'error' }));
      return;
    }
    setUploadStatus((s) => ({ ...s, [key]: 'uploading' }));
    try {
      const storageRef = ref(storage, `onboarding/employer_docs/${Date.now()}_${key}_${file.name}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      const fieldMap: Record<string, keyof EmployerData> = {
        rfc: 'docRFC', id: 'docId', address: 'docAddress',
      };
      setEmpData((d) => ({ ...d, [fieldMap[key]]: url }));
      setUploadStatus((s) => ({ ...s, [key]: 'done' }));
    } catch {
      setUploadStatus((s) => ({ ...s, [key]: 'error' }));
    }
  };

  // -- Employer account creation --
  const createEmployerAccount = async () => {
    setCreating(true);
    setError('');
    try {
      const cred = await createUserWithEmailAndPassword(auth, empData.email, empData.password);
      const uid = cred.user.uid;
      await setDoc(doc(db, 'employers', uid), {
        name: empData.name,
        companyName: empData.company,
        email: empData.email,
        employerCode: generateEmployerCode(),
        companySize: empData.companySize,
        payrollSystem: empData.payrollSystem,
        status: 'pending_verification',
        docRFC: empData.docRFC,
        docId: empData.docId,
        docAddress: empData.docAddress,
        submittedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        totalEmployees: 0,
        activeLoans: 0,
        totalDisbursed: 0,
      });
      goForward(6);
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
      if (step === 4) return uploadStatus.rfc === 'done' && uploadStatus.id === 'done' && uploadStatus.address === 'done';
      if (step === 5) return empData.password.length >= 6 && empData.terms;
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
    if (role === 'employer' && step === 5) {
      createEmployerAccount();
    } else if (role === 'employee' && step === 4) {
      createEmployeeAccount();
    } else {
      goForward(step + 1);
    }
  };

  // -- Progress bar --
  const progressPct = totalSteps > 0 ? ((step) / totalSteps) * 100 : 0;

  // -- Render step content --
  const renderContent = () => {
    // Role selection (step 0)
    if (!role) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center px-6">
          <h1 className="font-serif text-4xl leading-tight text-[#194445] sm:text-5xl">
            <RichText html={t('onb_welcome')} />
          </h1>
          <p className="mt-3 text-lg text-gray-500">{t('onb_welcome_sub')}</p>

          <div className="mt-10 grid w-full max-w-lg gap-4 sm:grid-cols-2">
            <button
              onClick={() => selectRole('employer')}
              className="group rounded-2xl border-2 border-gray-200 bg-white p-8 text-left transition-all hover:border-[#a28657] hover:shadow-lg"
            >
              <div className="mb-2 text-3xl">🏢</div>
              <div className="text-lg font-semibold text-[#194445]">{t('onb_role_employer_title')}</div>
              <div className="mt-1 text-sm text-gray-500">{t('onb_role_employer_desc')}</div>
            </button>
            <button
              onClick={() => selectRole('employee')}
              className="group rounded-2xl border-2 border-gray-200 bg-white p-8 text-left transition-all hover:border-[#a28657] hover:shadow-lg"
            >
              <div className="mb-2 text-3xl">👤</div>
              <div className="text-lg font-semibold text-[#194445]">{t('onb_role_employee_title')}</div>
              <div className="mt-1 text-sm text-gray-500">{t('onb_role_employee_desc')}</div>
            </button>
          </div>

          <p className="mt-8 text-sm text-gray-400">
            {t('onb_already_account')}{' '}
            <Link to="/login" className="font-semibold text-[#a28657] hover:underline">
              {t('onb_login')}
            </Link>
          </p>
        </div>
      );
    }

    // Employer flow
    if (role === 'employer') {
      if (step === 1) return (
        <StepShell>
          <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
            <RichText html={t('onb_e_step1_h')} />
          </h1>
          <p className="mt-2 text-gray-500">{t('onb_e_step1_sub')}</p>
          <input
            autoFocus
            className="mt-8 w-full rounded-xl border border-gray-300 px-4 py-3 text-lg outline-none focus:border-[#a28657] focus:ring-2 focus:ring-[#a28657]/20"
            placeholder={t('onb_e_step1_placeholder')}
            value={empData.company}
            onChange={(e) => setEmpData({ ...empData, company: e.target.value })}
          />
        </StepShell>
      );

      if (step === 2) return (
        <StepShell>
          <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
            <RichText html={t('onb_e_step2_h')} />
          </h1>
          <p className="mt-2 text-gray-500">{t('onb_e_step2_sub')}</p>
          <div className="mt-8 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('onb_e_step2_name')}</label>
              <input
                autoFocus
                className="w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-[#a28657] focus:ring-2 focus:ring-[#a28657]/20"
                placeholder={t('onb_e_step2_name_ph')}
                value={empData.name}
                onChange={(e) => setEmpData({ ...empData, name: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('onb_e_step2_email')}</label>
              <input
                type="email"
                className="w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-[#a28657] focus:ring-2 focus:ring-[#a28657]/20"
                placeholder={t('onb_e_step2_email_ph')}
                value={empData.email}
                onChange={(e) => setEmpData({ ...empData, email: e.target.value })}
              />
            </div>
          </div>
        </StepShell>
      );

      if (step === 3) return (
        <StepShell>
          <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
            <RichText html={t('onb_e_step3_h')} />
          </h1>
          <p className="mt-2 text-gray-500">{t('onb_e_step3_sub')}</p>
          <div className="mt-8 space-y-6">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">{t('onb_e_step3_size')}</label>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {COMPANY_SIZES.map((size) => (
                  <button
                    key={size}
                    onClick={() => setEmpData({ ...empData, companySize: size })}
                    className={`rounded-xl border-2 px-4 py-3 text-sm font-medium transition-all ${
                      empData.companySize === size
                        ? 'border-[#a28657] bg-[#a28657]/10 text-[#194445]'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {size} <span className="text-xs text-gray-400">{t('onb_e_step3_employees')}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('onb_e_step3_payroll')}</label>
              <select
                className="w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-[#a28657] focus:ring-2 focus:ring-[#a28657]/20"
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
        </StepShell>
      );

      if (step === 4) {
        const docs = [
          { key: 'rfc', label: t('onb_e_step4_rfc') },
          { key: 'id', label: t('onb_e_step4_id') },
          { key: 'address', label: t('onb_e_step4_address') },
        ];
        return (
          <StepShell>
            <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
              <RichText html={t('onb_e_step4_h')} />
            </h1>
            <p className="mt-2 text-gray-500">{t('onb_e_step4_sub')}</p>
            <div className="mt-8 space-y-4">
              {docs.map((d) => (
                <div
                  key={d.key}
                  className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4"
                >
                  <div>
                    <div className="text-sm font-semibold text-[#194445]">{d.label}</div>
                    <div className="text-xs text-gray-400">{t('onb_e_step4_formats')}</div>
                  </div>
                  <label
                    className={`cursor-pointer rounded-lg px-4 py-2 text-sm font-medium transition-all ${
                      uploadStatus[d.key] === 'done'
                        ? 'bg-emerald-100 text-emerald-700'
                        : uploadStatus[d.key] === 'uploading'
                        ? 'bg-gray-100 text-gray-500'
                        : uploadStatus[d.key] === 'error'
                        ? 'bg-red-100 text-red-600'
                        : 'bg-[#194445]/10 text-[#194445] hover:bg-[#194445]/20'
                    }`}
                  >
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*,application/pdf"
                      onChange={(e) => {
                        if (e.target.files?.[0]) handleFileUpload(d.key, e.target.files[0]);
                      }}
                      disabled={uploadStatus[d.key] === 'uploading'}
                    />
                    {uploadStatus[d.key] === 'uploading'
                      ? t('onb_e_step4_uploading')
                      : uploadStatus[d.key] === 'done'
                      ? t('onb_e_step4_done')
                      : uploadStatus[d.key] === 'error'
                      ? t('onb_e_step4_error')
                      : t('onb_e_step4_upload')}
                  </label>
                </div>
              ))}
            </div>
          </StepShell>
        );
      }

      if (step === 5) return (
        <StepShell>
          <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
            <RichText html={t('onb_e_step5_h')} />
          </h1>
          <p className="mt-2 text-gray-500">{t('onb_e_step5_sub')}</p>
          <div className="mt-8 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('onb_e_step5_pass')}</label>
              <input
                autoFocus
                type="password"
                className="w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-[#a28657] focus:ring-2 focus:ring-[#a28657]/20"
                placeholder={t('onb_e_step5_pass_ph')}
                value={empData.password}
                onChange={(e) => setEmpData({ ...empData, password: e.target.value })}
              />
              <PasswordStrengthBar password={empData.password} t={t} />
            </div>
            <label className="flex items-start gap-3 pt-2">
              <input
                type="checkbox"
                checked={empData.terms}
                onChange={(e) => setEmpData({ ...empData, terms: e.target.checked })}
                className="mt-0.5 h-5 w-5 rounded border-gray-300 accent-[#194445]"
              />
              <span className="text-sm text-gray-600">
                {t('onb_e_step5_terms')}{' '}
                <Link to="/terms" className="font-semibold text-[#a28657] hover:underline" target="_blank">
                  {t('onb_e_step5_terms_link')}
                </Link>
              </span>
            </label>
          </div>
        </StepShell>
      );

      if (step === 6) return (
        <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-4xl">
            ✓
          </div>
          <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
            <RichText html={t('onb_e_step6_h')} />
          </h1>
          <p className="mt-2 text-gray-500">{t('onb_e_step6_sub')}</p>
          <div className="mt-6 inline-block rounded-full bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-700">
            {t('onb_e_step6_badge')}
          </div>
          <button
            onClick={() => navigate('/')}
            className="mt-8 rounded-xl bg-[#194445] px-8 py-3 font-semibold text-white transition-all hover:bg-[#194445]/90"
          >
            {t('onb_e_step6_cta')}
          </button>
        </div>
      );
    }

    // Employee flow
    if (role === 'employee') {
      if (step === 1) return (
        <StepShell>
          <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
            <RichText html={t('onb_m_step1_h')} />
          </h1>
          <p className="mt-2 text-gray-500">{t('onb_m_step1_sub')}</p>
          <input
            autoFocus
            className="mt-8 w-full rounded-xl border border-gray-300 px-4 py-3 text-center text-2xl font-bold uppercase tracking-[0.3em] outline-none focus:border-[#a28657] focus:ring-2 focus:ring-[#a28657]/20"
            placeholder={t('onb_m_step1_placeholder')}
            maxLength={8}
            value={memData.code}
            onChange={(e) => handleCodeChange(e.target.value)}
          />
          <p className={`mt-3 text-sm ${
            codeStatus === 'found' ? 'font-semibold text-emerald-600'
            : codeStatus === 'not_found' ? 'text-red-500'
            : codeStatus === 'searching' ? 'text-gray-400'
            : 'text-gray-400'
          }`}>
            {codeStatus === 'searching' && t('onb_m_step1_searching')}
            {codeStatus === 'found' && `${t('onb_m_step1_found')}: ${memData.employerName}`}
            {codeStatus === 'not_found' && t('onb_m_step1_not_found')}
            {codeStatus === 'idle' && t('onb_m_step1_hint')}
          </p>
        </StepShell>
      );

      if (step === 2) return (
        <StepShell>
          <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
            <RichText html={t('onb_m_step2_h')} />
          </h1>
          <p className="mt-2 text-gray-500">{t('onb_m_step2_sub')}</p>
          <div className="mt-8 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('onb_m_step2_name')}</label>
              <input
                autoFocus
                className="w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-[#a28657] focus:ring-2 focus:ring-[#a28657]/20"
                placeholder={t('onb_m_step2_name_ph')}
                value={memData.name}
                onChange={(e) => setMemData({ ...memData, name: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('onb_m_step2_email')}</label>
              <input
                type="email"
                className="w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-[#a28657] focus:ring-2 focus:ring-[#a28657]/20"
                placeholder={t('onb_m_step2_email_ph')}
                value={memData.email}
                onChange={(e) => setMemData({ ...memData, email: e.target.value })}
              />
            </div>
          </div>
        </StepShell>
      );

      if (step === 3) return (
        <StepShell>
          <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
            <RichText html={t('onb_m_step3_h')} />
          </h1>
          <p className="mt-2 text-gray-500">{t('onb_m_step3_sub')}</p>
          <div className="mt-8">
            <label className="mb-1 block text-sm font-medium text-gray-700">{t('onb_m_step3_salary')}</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-lg text-gray-400">$</span>
              <input
                autoFocus
                type="text"
                inputMode="numeric"
                className="w-full rounded-xl border border-gray-300 px-4 py-3 pl-8 text-lg outline-none focus:border-[#a28657] focus:ring-2 focus:ring-[#a28657]/20"
                placeholder={t('onb_m_step3_salary_ph')}
                value={memData.salary}
                onChange={(e) => setMemData({ ...memData, salary: e.target.value.replace(/[^\d,]/g, '') })}
              />
            </div>
          </div>
          {creditAmount > 0 && (
            <div className="mt-8 rounded-2xl border-2 border-[#a28657]/30 bg-[#a28657]/5 p-6 text-center">
              <div className="text-xs font-semibold uppercase tracking-wider text-[#a28657]">
                {t('onb_m_step3_preapproved')}
              </div>
              <div className="mt-1 text-xs text-gray-500">{t('onb_m_step3_credit_label')}</div>
              <div className="mt-2 font-serif text-4xl font-bold text-[#194445]">
                ${creditAmount.toLocaleString('en-US', { minimumFractionDigits: 0 })}
              </div>
              <div className="mt-1 text-xs text-gray-400">MXN</div>
            </div>
          )}
        </StepShell>
      );

      if (step === 4) return (
        <StepShell>
          <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
            <RichText html={t('onb_m_step4_h')} />
          </h1>
          <p className="mt-2 text-gray-500">{t('onb_m_step4_sub')}</p>
          <div className="mt-8 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('onb_m_step4_pass')}</label>
              <input
                autoFocus
                type="password"
                className="w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-[#a28657] focus:ring-2 focus:ring-[#a28657]/20"
                placeholder={t('onb_m_step4_pass_ph')}
                value={memData.password}
                onChange={(e) => setMemData({ ...memData, password: e.target.value })}
              />
              <PasswordStrengthBar password={memData.password} t={t} />
            </div>
            <label className="flex items-start gap-3 pt-2">
              <input
                type="checkbox"
                checked={memData.terms}
                onChange={(e) => setMemData({ ...memData, terms: e.target.checked })}
                className="mt-0.5 h-5 w-5 rounded border-gray-300 accent-[#194445]"
              />
              <span className="text-sm text-gray-600">
                {t('onb_m_step4_terms')}{' '}
                <Link to="/terms" className="font-semibold text-[#a28657] hover:underline" target="_blank">
                  {t('onb_m_step4_terms_link')}
                </Link>
              </span>
            </label>
          </div>
        </StepShell>
      );

      if (step === 5) return (
        <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-4xl">
            ✓
          </div>
          <h1 className="font-serif text-3xl leading-tight text-[#194445] sm:text-4xl">
            <RichText html={t('onb_m_step5_h')} />
          </h1>
          <p className="mt-2 text-gray-500">{t('onb_m_step5_sub')}</p>
          <div className="mt-6 inline-block rounded-full bg-[#a28657]/20 px-4 py-2 text-sm font-semibold text-[#a28657]">
            {t('onb_m_step5_tag')}
          </div>
          <div className="mt-4 font-serif text-5xl font-bold text-[#194445]">
            ${creditAmount.toLocaleString('en-US', { minimumFractionDigits: 0 })}
          </div>
          <div className="text-sm text-gray-400">MXN</div>
          <button
            onClick={() => navigate('/employee')}
            className="mt-8 rounded-xl bg-[#194445] px-8 py-3 font-semibold text-white transition-all hover:bg-[#194445]/90"
          >
            {t('onb_m_step5_cta')}
          </button>
        </div>
      );
    }

    return null;
  };

  // Is this a final success step?
  const isFinalStep = (role === 'employer' && step === 6) || (role === 'employee' && step === 5);

  // Action button config
  const getActionLabel = () => {
    if (role === 'employer' && step === 5) return creating ? t('onb_e_step5_creating') : t('onb_e_step5_btn');
    if (role === 'employee' && step === 4) return creating ? t('onb_m_step4_creating') : t('onb_m_step4_btn');
    return t('onb_next');
  };

  return (
    <div className="relative min-h-screen bg-gray-50">
      {/* Top bar with back button and progress */}
      {role && !isFinalStep && (
        <div className="fixed left-0 right-0 top-0 z-50 bg-gray-50/90 backdrop-blur-sm">
          <div className="mx-auto flex max-w-lg items-center gap-4 px-6 py-4">
            <button
              onClick={goBack}
              className="flex h-10 w-10 items-center justify-center rounded-full text-[#194445] transition-colors hover:bg-gray-200"
              aria-label="Go back"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="flex-1">
              <div className="h-1.5 w-full rounded-full bg-gray-200">
                <div
                  className="h-1.5 rounded-full bg-[#a28657] transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
            <span className="text-xs font-medium text-gray-400">
              {step}/{totalSteps}
            </span>
          </div>
        </div>
      )}

      {/* Content area with animation */}
      <div
        key={`${role}-${step}`}
        className="animate-fadeSlideIn"
        style={{
          animationDirection: direction === 'left' ? 'reverse' : 'normal',
        }}
      >
        {renderContent()}
      </div>

      {/* Bottom action button */}
      {role && !isFinalStep && step >= 1 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-gray-50/90 px-6 pb-8 pt-4 backdrop-blur-sm">
          <div className="mx-auto max-w-lg">
            {error && (
              <p className="mb-3 text-center text-sm text-red-500">{error}</p>
            )}
            <button
              onClick={handleNext}
              disabled={!canProceed() || creating}
              className="w-full rounded-xl bg-[#194445] py-4 font-semibold text-white transition-all hover:bg-[#194445]/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {creating && (
                <svg className="mr-2 inline h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {getActionLabel()}
            </button>
          </div>
        </div>
      )}

      {/* Animation styles */}
      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateX(30px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .animate-fadeSlideIn {
          animation: fadeSlideIn 0.35s ease-out forwards;
        }
      `}</style>
    </div>
  );
}

function StepShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col justify-center px-6 pb-32 pt-24">
      <div className="mx-auto w-full max-w-lg">
        {children}
      </div>
    </div>
  );
}
