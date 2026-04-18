import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { auth, db } from '../lib/firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
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
  phone: string;
  rfc: string;
  state: string;
  industry: string;
  employeeCount: string;
  payFrequency: string;
  payrollSystem: string;
  usesDispersora: string;
  bankClabe: string;
  docRFC: string;
  docId: string;
  docAddress: string;
  dispersoraName: string;
  employeeCurps: string[];
  password: string;
  terms: boolean;
}

interface EmployeeData {
  code: string;
  employerId: string;
  employerName: string;
  name: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  curp: string;
  gender: string;
  rfc: string;
  salary: string;
  payFrequency: string;
  employmentTenure: string;
  bankClabe: string;
  password: string;
  terms: boolean;
}

const COMPANY_SIZES = ['1-50', '51-200', '201-500', '500+'];
const PAYROLL_SYSTEMS = ['Nomipaq', 'Aspel NOI', 'CONTPAQi', 'Workday', 'ADP'];
const PAY_FREQUENCIES = ['weekly', 'biweekly', 'monthly'];
const TENURE_OPTIONS = ['<6m', '6m-1y', '1-2y', '2-5y', '5y+'];
const INDUSTRIES = [
  'manufacturing', 'retail', 'services', 'technology', 'construction',
  'healthcare', 'education', 'hospitality', 'agriculture', 'logistics', 'other',
];
const MX_STATES = [
  'Aguascalientes', 'Baja California', 'Baja California Sur', 'Campeche', 'Chiapas',
  'Chihuahua', 'Ciudad de México', 'Coahuila', 'Colima', 'Durango', 'Estado de México',
  'Guanajuato', 'Guerrero', 'Hidalgo', 'Jalisco', 'Michoacán', 'Morelos', 'Nayarit',
  'Nuevo León', 'Oaxaca', 'Puebla', 'Querétaro', 'Quintana Roo', 'San Luis Potosí',
  'Sinaloa', 'Sonora', 'Tabasco', 'Tamaulipas', 'Tlaxcala', 'Veracruz', 'Yucatán', 'Zacatecas',
];

function generateEmployerCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// const CURP_REGEX = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/; // Used server-side only
// const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/; // Extracted from INE via MetaMap
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateCLABE(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += (parseInt(clabe[i]) * weights[i]) % 10;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(clabe[17]);
}

function getAge(dateStr: string): number {
  const today = new Date();
  const birth = new Date(dateStr);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
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


// ── Split-screen step context for left panel ──
const STEP_CONTEXT: Record<string, { icon: string; title: string; sub: string; trust: string }[]> = {
  employer: [
    { icon: 'briefcase', title: 'Tu empresa', sub: 'Comienza con el nombre de tu empresa.', trust: 'Proceso 100% digital — 10 minutos' },
    { icon: 'mail', title: 'Datos de contacto', sub: 'Quién administrará la cuenta VIDA.', trust: 'Encriptación punto a punto' },
    { icon: 'file', title: 'Datos fiscales', sub: 'RFC, estado y sector para validación.', trust: 'Cumplimiento CNBV y CONDUSEF' },
    { icon: 'users', title: 'Equipo y nómina', sub: 'Determina créditos para tu equipo.', trust: 'Sin costo para tu empresa' },
    { icon: 'bank', title: 'Datos bancarios', sub: 'CLABE para deducciones de nómina.', trust: 'Conexión bancaria segura' },
    { icon: 'file', title: 'Documentos', sub: 'RFC, identificación y comprobante.', trust: 'Almacenamiento seguro' },
    { icon: 'users', title: 'Empleados', sub: 'CURPs para pre-registro de empleados.', trust: 'Verificación automatizada' },
    { icon: 'lock', title: 'Seguridad', sub: 'Contraseña y términos de servicio.', trust: 'Autenticación multi-factor' },
    { icon: 'sparkles', title: '¡Listo!', sub: 'Tu cuenta ha sido creada.', trust: '' },
  ],
  employee: [
    { icon: 'key', title: 'Código de empresa', sub: 'Tu empleador te dio un código único.', trust: 'Tu empleador ya está verificado' },
    { icon: 'person', title: 'Datos personales', sub: 'Nombre, correo y teléfono.', trust: 'Protegidos bajo la LFPDPPP' },
    { icon: 'id', title: 'Identidad fiscal', sub: 'CURP y RFC para validación.', trust: 'Verificación KYC automatizada' },
    { icon: 'wallet', title: 'Empleo y banco', sub: 'Salario y cuenta bancaria.', trust: 'Línea = hasta 30% de tu salario' },
    { icon: 'lock', title: 'Seguridad', sub: 'Contraseña y términos.', trust: 'Tus datos están encriptados' },
    { icon: 'sparkles', title: '¡Aprobado!', sub: 'Tu línea de crédito está lista.', trust: '' },
  ],
};

function StepIcon({ name }: { name: string }) {
  const icons: Record<string, React.ReactNode> = {
    briefcase: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>,
    mail: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 7L2 7"/></svg>,
    file: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>,
    users: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>,
    bank: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg>,
    lock: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
    key: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
    person: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
    id: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M14 10h4M14 14h2"/></svg>,
    wallet: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 12V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h14a2 2 0 002-2v-5z"/><path d="M16 12h.01"/></svg>,
    sparkles: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 3l1.912 5.813a2 2 0 001.275 1.275L21 12l-5.813 1.912a2 2 0 00-1.275 1.275L12 21l-1.912-5.813a2 2 0 00-1.275-1.275L3 12l5.813-1.912a2 2 0 001.275-1.275L12 3z"/></svg>,
    shield: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  };
  return icons[name] || icons.briefcase;
}

export function Onboarding() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [role, setRole] = useState<Role>(null);
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(0);

  // Auto-select role from URL param (?role=employer or ?role=employee)
  useEffect(() => {
    const urlRole = searchParams.get('role');
    if (urlRole === 'employer' && !role) {
      setRole('employer');
      setStep(1);
    } else if (urlRole === 'employee' && !role) {
      setRole('employee');
      setStep(1);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [, setDirection] = useState<'left' | 'right'>('right');
  const [creating, setCreating] = useState(false);
  const [docFiles, setDocFiles] = useState<Record<string, File>>({});
  const [error, setError] = useState('');

  // Employer state
  const [empData, setEmpData] = useState<EmployerData>({
    company: '', name: '', email: '', phone: '', rfc: '', state: '', industry: '',
    employeeCount: '', payFrequency: '', payrollSystem: '', usesDispersora: '', bankClabe: '',
    docRFC: '', docId: '', docAddress: '', dispersoraName: '', employeeCurps: ['', '', ''], password: '', terms: false,
  });
  // Employee state
  const [memData, setMemData] = useState<EmployeeData>({
    code: '', employerId: '', employerName: '', name: '', email: '',
    phone: '', dateOfBirth: '', curp: '', gender: '', rfc: '',
    salary: '', payFrequency: '', employmentTenure: '', bankClabe: '',
    password: '', terms: false,
  });
  const [codeStatus, setCodeStatus] = useState<'idle' | 'searching' | 'found' | 'not_found'>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // CURP validation state removed — extracted from INE via MetaMap
  const [emailStatus, setEmailStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const emailDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // const curpDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // const lastValidatedCurp = useRef('');

  // KYC verification state
  const [kycStatus, setKycStatus] = useState<'not_started' | 'pending_review' | 'approved' | 'rejected'>('not_started');
  const [metamapVerificationId, setMetamapVerificationId] = useState('');
  const [metamapIdentityId, setMetamapIdentityId] = useState('');

  // Invite token state — populated when user arrives at /onboarding?invite=TOKEN
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteId, setInviteId] = useState<string | null>(null);
  const [inviteEmployerName, setInviteEmployerName] = useState('');
  const [inviteInvalid, setInviteInvalid] = useState(false);

  // Detect ?invite=TOKEN and validate via lookupInvite callable
  useEffect(() => {
    const token = searchParams.get('invite');
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const functions = getFunctions();
        const lookup = httpsCallable<
          { token: string },
          | { valid: false; reason: string }
          | {
              valid: true;
              employerName: string;
              employeeName: string;
              employeeEmail: string;
              inviteId: string;
            }
        >(functions, 'lookupInvite');
        const { data } = await lookup({ token });
        if (cancelled) return;
        if (data.valid) {
          setInviteToken(token);
          setInviteId(data.inviteId);
          setInviteEmployerName(data.employerName);
          setMemData((d) => ({
            ...d,
            name: d.name || data.employeeName,
            email: d.email || data.employeeEmail,
          }));
        } else {
          setInviteInvalid(true);
        }
      } catch {
        if (!cancelled) setInviteInvalid(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const totalSteps = role === 'employer' ? 7 : role === 'employee' ? 6 : 0;

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

  // -- CURP validation via Cloud Function --
  /* validateCURPRemote removed — CURP extracted from INE via MetaMap
  const validateCURPRemote = useCallback(async (curp: string, expectedName: string, email?: string) => {
    if (lastValidatedCurp.current === curp) return;
    lastValidatedCurp.current = curp;
    setCurpStatus('validating');
    setCurpError('');
    try {
      const functions = getFunctions();
      const validate = httpsCallable<
        { curp: string; expectedName?: string },
        { valid: boolean; fullName?: string; dateOfBirth?: string; gender?: 'M' | 'F'; matchesExpectedName?: boolean }
      >(functions, 'validateCURP');
      const { data } = await validate({ curp, ...(expectedName ? { expectedName } : {}), ...(email ? { email } : {}) });
      if (data.valid) {
        setCurpStatus('valid');
        setMemData((d) => ({
          ...d,
          ...(data.fullName ? { name: data.fullName } : {}),
          ...(data.dateOfBirth ? { dateOfBirth: data.dateOfBirth } : {}),
          ...(data.gender ? { gender: data.gender } : {}),
        }));
      } else {
        setCurpStatus('invalid');
        setCurpError(
          data.matchesExpectedName === false
            ? t('onb_m_step3_curp_name_mismatch')
            : t('onb_m_step3_curp_invalid')
        );
      }
    } catch {
      setCurpStatus('error');
      setCurpError(t('onb_m_step3_curp_validation_error'));
    }
  }, [t]);

  */
  // CURP validation removed — extracted from INE via MetaMap

  // -- Email availability check (via Cloud Function) --
  const checkEmailAvailability = useCallback(async (email: string) => {
    if (!EMAIL_REGEX.test(email)) { setEmailStatus('idle'); return; }
    setEmailStatus('checking');
    try {
      const functions = getFunctions();
      const checkFn = httpsCallable<{ email: string }, { available: boolean }>(functions, 'checkEmailAvailability');
      const { data } = await checkFn({ email });
      setEmailStatus(data.available ? 'available' : 'taken');
    } catch {
      // If check fails, don't block — allow signup attempt
      setEmailStatus('available');
    }
  }, []);

  const handleEmailChange = (email: string) => {
    if (role === 'employee') {
      setMemData((d) => ({ ...d, email }));
      setEmailStatus('idle');
      if (emailDebounceRef.current) clearTimeout(emailDebounceRef.current);
      if (EMAIL_REGEX.test(email)) {
        emailDebounceRef.current = setTimeout(() => checkEmailAvailability(email), 800);
      }
    } else {
      setEmpData((d) => ({ ...d, email }));
      setEmailStatus('idle');
      if (emailDebounceRef.current) clearTimeout(emailDebounceRef.current);
      if (EMAIL_REGEX.test(email)) {
        emailDebounceRef.current = setTimeout(() => checkEmailAvailability(email), 800);
      }
    }
  };

  // -- MetaMap KYC verification --
  const startKYC = () => {
    // Test-mode bypass: skip MetaMap for @vida-test.com emails
    if (memData.email.endsWith('@vida-test.com')) {
      setMetamapVerificationId('test-verification-' + Date.now());
      setMetamapIdentityId('test-identity-' + Date.now());
      setKycStatus('approved');
      goForward(4);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metamapWidget = new (window as any).MetamapVerification({
      clientId: '69c5763020d348c911b0a852',
      flowId: '69d63c07940df362adbef105',
      metadata: {
        curp: memData.curp,
        email: memData.email,
        firstName: memData.name.split(' ')[0],
        lastName: memData.name.split(' ').slice(1).join(' '),
        phone: memData.phone,
      },
    });
    metamapWidget.start();

    metamapWidget.on('metamap:userFinishedSdk', (event: { detail: { identityId?: string; verificationId?: string } }) => {
      const { identityId, verificationId } = event.detail || event as any;
      setMetamapVerificationId(verificationId || '');
      setMetamapIdentityId(identityId || '');
      setKycStatus('pending_review');
      goForward(4);
    });

    metamapWidget.on('metamap:exitedSdk', () => {
      // User closed without completing — stay on current step
    });
  };

  // -- Employer account creation --
  const createEmployerAccount = async () => {
    setCreating(true);
    setError('');
    try {
      let cred;
      try {
        cred = await createUserWithEmailAndPassword(auth, empData.email, empData.password);
      } catch (authErr: unknown) {
        if ((authErr as { code?: string }).code === 'auth/email-already-in-use') {
          cred = await signInWithEmailAndPassword(auth, empData.email, empData.password);
        } else {
          throw authErr;
        }
      }
      const uid = cred.user.uid;

      // Upload documents to Firebase Storage
      const storage = getStorage();
      const docUrls: Record<string, string> = {};
      for (const [key, file] of Object.entries(docFiles)) {
        try {
          const fileRef = storageRef(storage, 'employers/' + uid + '/docs/' + key + '_' + file.name);
          await uploadBytes(fileRef, file);
          docUrls[key] = await getDownloadURL(fileRef);
        } catch (uploadErr) {
          console.warn('Doc upload failed for ' + key, uploadErr);
        }
      }

      await setDoc(doc(db, 'employers', uid), {
        name: empData.name,
        companyName: empData.company,
        email: empData.email,
        phone: empData.phone,
        rfc: empData.rfc,
        state: empData.state,
        industry: empData.industry,
        employeeCount: empData.employeeCount,
        payFrequency: empData.payFrequency,
        payrollSystem: empData.payrollSystem,
        usesDispersora: empData.usesDispersora === 'yes',
        bankClabe: empData.bankClabe,
        employerCode: generateEmployerCode(),
        employeeCurps: empData.employeeCurps,
        dispersoraName: empData.usesDispersora === 'yes' ? empData.dispersoraName : null,
        status: 'pending_verification',
        docUrls: docUrls || {},
        docRFC: null,
        docId: null,
        docAddress: null,
        submittedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        totalEmployees: 0,
        activeLoans: 0,
        totalDisbursed: 0,
      });
      goForward(9);
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
      let cred;
      try {
        cred = await createUserWithEmailAndPassword(auth, memData.email, memData.password);
      } catch (authErr: unknown) {
        if ((authErr as { code?: string }).code === 'auth/email-already-in-use') {
          cred = await signInWithEmailAndPassword(auth, memData.email, memData.password);
        } else {
          throw authErr;
        }
      }
      const uid = cred.user.uid;
      await setDoc(doc(db, 'employees', uid), {
        name: memData.name,
        email: memData.email,
        phone: memData.phone,
        dateOfBirth: memData.dateOfBirth,
        curp: memData.curp ? memData.curp.toUpperCase() : '',
        gender: memData.gender || null,
        rfc: memData.rfc ? memData.rfc.toUpperCase() : '',
        employerId: memData.employerId,
        employerName: memData.employerName,
        employerCode: memData.code.toUpperCase(),
        monthlySalary: salaryNum,
        payFrequency: memData.payFrequency,
        employmentTenure: memData.employmentTenure,
        bankClabe: memData.bankClabe,
        creditLimit,
        availableCredit: creditLimit,
        kycStatus: kycStatus,
        ...(metamapVerificationId ? { metamapVerificationId } : {}),
        ...(metamapIdentityId ? { metamapIdentityId } : {}),
        ...(metamapVerificationId ? { kycStartedAt: serverTimestamp() } : {}),
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, 'employers', memData.employerId), {
        totalEmployees: increment(1),
      });
      // Link auth.uid to the pre-existing roster employee doc when the user
      // arrived via an invite. Non-fatal: employees/{uid} was already written.
      if (inviteToken && inviteId) {
        try {
          const functions = getFunctions();
          const accept = httpsCallable<
            { inviteId: string; token: string },
            { success: boolean; employerId: string; employeeDocId: string }
          >(functions, 'acceptInvite');
          await accept({ inviteId, token: inviteToken });
        } catch (inviteErr) {
          console.warn('acceptInvite failed', inviteErr);
        }
      }
      goForward(6);
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
      if (step === 2) return empData.name.trim().length > 0 && EMAIL_REGEX.test(empData.email) && empData.phone.trim().length >= 10 && emailStatus !== 'taken' && emailStatus !== 'checking';
      if (step === 3) return empData.rfc.trim().length >= 12 && empData.state !== '' && empData.industry !== '';
      if (step === 4) return empData.employeeCount !== '' && empData.payFrequency !== '' && empData.payrollSystem !== '';
      if (step === 5) return empData.usesDispersora !== '' && (empData.usesDispersora === 'no' || empData.dispersoraName.trim().length > 2) && validateCLABE(empData.bankClabe);
      if (step === 6) return empData.docRFC !== '' && empData.docId !== '' && empData.docAddress !== '';
      if (step === 7) return empData.employeeCurps.every(curp => /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(curp));
      if (step === 8) return empData.password.length >= 6 && empData.terms;
    }
    if (role === 'employee') {
      if (step === 1) return codeStatus === 'found';
      if (step === 2) {
        if (!memData.name.trim() || !EMAIL_REGEX.test(memData.email) || memData.phone.replace(/\D/g, '').length < 10 || !memData.dateOfBirth) return false;
        if (emailStatus === 'taken' || emailStatus === 'checking') return false;
        const age = getAge(memData.dateOfBirth);
        return age >= 18 && age <= 65;
      }
      if (step === 3) return kycStatus === 'pending_review' || kycStatus === 'approved';
      if (step === 4) return salaryNum > 0 && memData.payFrequency !== '' && memData.employmentTenure !== '' && validateCLABE(memData.bankClabe);
      if (step === 5) return memData.password.length >= 6 && memData.terms;
    }
    return false;
  };

  const handleNext = () => {
    if (role === 'employer' && step === 8) {
      createEmployerAccount();
    } else if (role === 'employee' && step === 5) {
      createEmployeeAccount();
    } else {
      goForward(step + 1);
    }
  };

  // -- Progress bar --
  const progressPct = totalSteps > 0 ? ((step) / totalSteps) * 100 : 0;

  // Is this a final success step?
  const isFinalStep = (role === 'employer' && step === 9) || (role === 'employee' && step === 6);

  // Action button config
  const getActionLabel = () => {
    if (role === 'employer' && step === 8) return creating ? t('onb_e_step5_creating') : t('onb_e_step5_btn');
    if (role === 'employee' && step === 5) return creating ? t('onb_m_step5_creating') : t('onb_m_step5_btn');
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

      <div className="onb-roles">
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

      {/* Step 2: Name + email + phone */}
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
                className={`onb-input${emailStatus === 'taken' ? ' invalid' : emailStatus === 'available' ? ' valid' : ''}`}
                placeholder={t('onb_e_step2_email_ph')}
                value={empData.email}
                onChange={(e) => handleEmailChange(e.target.value)}
              />
              {emailStatus === 'checking' && (
                <div className="onb-input-hint">Verificando disponibilidad...</div>
              )}
              {emailStatus === 'taken' && (
                <div className="onb-input-hint error">Este correo ya está registrado. <a href="/login" style={{color:'inherit',textDecoration:'underline'}}>Inicia sesión</a></div>
              )}
              {emailStatus === 'available' && (
                <div className="onb-input-hint success">✓ Disponible</div>
              )}
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step2_phone')}</label>
              <input
                type="tel"
                className="onb-input"
                placeholder={t('onb_e_step2_phone_ph')}
                value={empData.phone}
                onChange={(e) => setEmpData({ ...empData, phone: e.target.value.replace(/[^\d+\-() ]/g, '') })}
              />
            </div>
          </div>
        )}
      </div>

      {/* Step 3: RFC + state + industry */}
      <div className={stageClass(3)}>
        {step === 3 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_e_step3_h')} /></h1>
            <p className="onb-sub">{t('onb_e_step3_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step3_rfc')}</label>
              <input
                autoFocus
                className="onb-input"
                placeholder={t('onb_e_step3_rfc_ph')}
                maxLength={13}
                value={empData.rfc}
                onChange={(e) => setEmpData({ ...empData, rfc: e.target.value.toUpperCase() })}
              />
              <div className="onb-input-hint">{t('onb_e_step3_rfc_hint')}</div>
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step3_state')}</label>
              <select
                className="onb-select"
                value={empData.state}
                onChange={(e) => setEmpData({ ...empData, state: e.target.value })}
              >
                <option value="">{t('onb_e_step3_state_ph')}</option>
                {MX_STATES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step3_industry')}</label>
              <select
                className="onb-select"
                value={empData.industry}
                onChange={(e) => setEmpData({ ...empData, industry: e.target.value })}
              >
                <option value="">{t('onb_e_step3_industry_ph')}</option>
                {INDUSTRIES.map((ind) => (
                  <option key={ind} value={ind}>{t(`onb_e_industry_${ind}`)}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Step 4: Employee count + pay frequency + payroll system */}
      <div className={stageClass(4)}>
        {step === 4 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_e_step4_h')} /></h1>
            <p className="onb-sub">{t('onb_e_step4_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step4_size')}</label>
              <div className="onb-tiles">
                {COMPANY_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button" className={`onb-tile${empData.employeeCount === size ? ' active' : ''}`}
                    onClick={() => setEmpData(prev => ({ ...prev, employeeCount: size }))}
                  >
                    <div className="onb-tile-val">{size}</div>
                    <div className="onb-tile-lbl">{t('onb_e_step4_employees')}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step4_freq')}</label>
              <div className="onb-tiles">
                {PAY_FREQUENCIES.map((freq) => (
                  <button
                    key={freq}
                    type="button" className={`onb-tile${empData.payFrequency === freq ? ' active' : ''}`}
                    onClick={() => setEmpData(prev => ({ ...prev, payFrequency: freq }))}
                  >
                    <div className="onb-tile-val">{t(`onb_e_freq_${freq}`)}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step4_payroll')}</label>
              <select
                className="onb-select"
                value={empData.payrollSystem}
                onChange={(e) => setEmpData({ ...empData, payrollSystem: e.target.value })}
              >
                <option value="">{t('onb_e_step4_payroll_ph')}</option>
                {PAYROLL_SYSTEMS.map((ps) => (
                  <option key={ps} value={ps}>{ps}</option>
                ))}
                <option value="Other">{t('onb_e_step4_payroll_other')}</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Step 5: Dispersora + bank CLABE */}
      <div className={stageClass(5)}>
        {step === 5 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_e_step5a_h')} /></h1>
            <p className="onb-sub">{t('onb_e_step5a_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step5a_dispersora')}</label>
              <div className="onb-tiles">
                <button
                  type="button" className={`onb-tile${empData.usesDispersora === 'yes' ? ' active' : ''}`}
                  onClick={() => setEmpData(prev => ({ ...prev, usesDispersora: 'yes' }))}
                >
                  <div className="onb-tile-val">{t('onb_e_step5a_yes')}</div>
                </button>
                <button
                  type="button" className={`onb-tile${empData.usesDispersora === 'no' ? ' active' : ''}`}
                  onClick={() => setEmpData(prev => ({ ...prev, usesDispersora: 'no' }))}
                >
                  <div className="onb-tile-val">{t('onb_e_step5a_no')}</div>
                </button>
              </div>
              {empData.usesDispersora === 'yes' && (
                <div style={{marginTop: 16}}>
                  <label className="onb-label">Nombre de la dispersora</label>
                  <input className="onb-input" placeholder="Ej. Nomipay, Konfío, etc." value={empData.dispersoraName} onChange={(e) => setEmpData(prev => ({...prev, dispersoraName: e.target.value}))} />
                </div>
              )}
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_e_step5a_clabe')}</label>
              <input
                className="onb-input"
                placeholder={t('onb_e_step5a_clabe_ph')}
                maxLength={18}
                inputMode="numeric"
                value={empData.bankClabe}
                onChange={(e) => setEmpData({ ...empData, bankClabe: e.target.value.replace(/\D/g, '') })}
              />
              <div className="onb-input-hint">{t('onb_e_step5a_clabe_hint')}</div>
            </div>
          </div>
        )}
      </div>


      {/* Step 6: Document uploads */}
      <div className={stageClass(6)}>
        {step === 6 && (
          <div className="onb-content">
            <h1 className="onb-h">Documentos <em>requeridos</em>.</h1>
            <p className="onb-sub">Sube los documentos de tu empresa para verificación.</p>
            <div className="onb-field">
              <label className="onb-label">Constancia de Situación Fiscal (SAT)</label>
              <input type="file" accept=".pdf,.jpg,.png" className="onb-input" style={{padding:'12px'}} onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setEmpData(prev => ({...prev, docRFC: file.name}));
                  setDocFiles(prev => ({...prev, docRFC: file}));
                }
              }} />
            </div>
            <div className="onb-field">
              <label className="onb-label">INE del Representante Legal</label>
              <input type="file" accept=".pdf,.jpg,.png" className="onb-input" style={{padding:'12px'}} onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setEmpData(prev => ({...prev, docId: file.name}));
                  setDocFiles(prev => ({...prev, docId: file}));
                }
              }} />
            </div>
            <div className="onb-field">
              <label className="onb-label">Acta Constitutiva</label>
              <input type="file" accept=".pdf,.jpg,.png" className="onb-input" style={{padding:'12px'}} onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setEmpData(prev => ({...prev, docAddress: file.name}));
                  setDocFiles(prev => ({...prev, docAddress: file}));
                }
              }} />
            </div>
            {empData.usesDispersora === 'yes' && (
              <div className="onb-field">
                <label className="onb-label">Factura de la dispersora ({empData.dispersoraName || 'dispersora'})</label>
                <input type="file" accept=".pdf,.jpg,.png" className="onb-input" style={{padding:'12px'}} id="doc-dispersora" />
                <div className="onb-input-hint">Comprobante de que la dispersora paga nómina de tus empleados</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 7: 3 Employee CURPs — mandatory */}
      <div className={stageClass(7)}>
        {step === 7 && (
          <div className="onb-content">
            <h1 className="onb-h">Verificación de <em>nómina</em>.</h1>
            <p className="onb-sub">Ingresa el CURP de 3 empleados para verificar tu registro en el IMSS y activar las deducciones de nómina.</p>
            {[0, 1, 2].map((i) => (
              <div className="onb-field" key={i}>
                <label className="onb-label">CURP del Empleado {i + 1}</label>
                <input
                  className="onb-input"
                  placeholder="CURP de 18 caracteres"
                  maxLength={18}
                  value={empData.employeeCurps[i]}
                  onChange={(e) => {
                    const newCurps = [...empData.employeeCurps];
                    newCurps[i] = e.target.value.toUpperCase();
                    setEmpData({...empData, employeeCurps: newCurps});
                  }}
                />
              </div>
            ))}
            <div className="onb-input-hint" style={{marginTop: 8}}>Los CURPs serán verificados contra el IMSS para confirmar que son empleados registrados de tu empresa.</div>
          </div>
        )}
      </div>

      {/* Step 8: Password + terms */}
      <div className={stageClass(8)}>
        {step === 8 && (
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

      {/* Step 9: Employer success */}
      <div className={stageClass(9)}>
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

      {/* Step 2: Name + email + phone + DOB */}
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
                className={`onb-input${emailStatus === 'taken' ? ' invalid' : emailStatus === 'available' ? ' valid' : ''}`}
                placeholder={t('onb_m_step2_email_ph')}
                value={memData.email}
                onChange={(e) => handleEmailChange(e.target.value)}
              />
              {emailStatus === 'checking' && (
                <div className="onb-input-hint">{t('onb_m_step2_email_checking', 'Verificando disponibilidad...')}</div>
              )}
              {emailStatus === 'taken' && (
                <div className="onb-input-hint error">{t('onb_m_step2_email_taken', 'Este correo ya está registrado. ¿Ya tienes cuenta?')} <a href="/login" style={{color:'inherit',textDecoration:'underline'}}>{t('onb_login', 'Inicia sesión')}</a></div>
              )}
              {emailStatus === 'available' && (
                <div className="onb-input-hint success">{t('onb_m_step2_email_available', 'Correo disponible')}</div>
              )}
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step2_phone')}</label>
              <input
                type="tel"
                className="onb-input"
                placeholder={t('onb_m_step2_phone_ph')}
                value={memData.phone}
                onChange={(e) => setMemData({ ...memData, phone: e.target.value.replace(/[^\d+\- ]/g, '') })}
              />
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step2_dob')}</label>
              <input
                type="date"
                className={`onb-input${memData.dateOfBirth && (getAge(memData.dateOfBirth) < 18 || getAge(memData.dateOfBirth) > 65) ? ' invalid' : memData.dateOfBirth && getAge(memData.dateOfBirth) >= 18 && getAge(memData.dateOfBirth) <= 65 ? ' valid' : ''}`}
                value={memData.dateOfBirth}
                onChange={(e) => setMemData({ ...memData, dateOfBirth: e.target.value })}
              />
              {memData.dateOfBirth && (getAge(memData.dateOfBirth) < 18 || getAge(memData.dateOfBirth) > 65) && (
                <div className="onb-input-hint error">{t('onb_m_step2_dob_age_error')}</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Step 3: KYC verification via MetaMap */}
      <div className={stageClass(3)}>
        {step === 3 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_m_kyc_h')} /></h1>
            <p className="onb-sub">{t('onb_m_kyc_sub')}</p>

            {kycStatus === 'not_started' && (
              <div className="onb-kyc-card">
                <div className="onb-kyc-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #2d6a4f)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 12l2 2 4-4" />
                    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
                  </svg>
                </div>
                <p className="onb-kyc-desc">{t('onb_m_kyc_desc')}</p>
                <button className="onb-btn" onClick={startKYC}>
                  {t('onb_m_kyc_btn')}
                </button>
              </div>
            )}

            {kycStatus === 'pending_review' && (
              <div className="onb-kyc-card">
                <div className="onb-kyc-spinner" />
                <p className="onb-kyc-status">{t('onb_m_kyc_pending')}</p>
              </div>
            )}

            {kycStatus === 'approved' && (
              <div className="onb-kyc-card">
                <div className="onb-check-circle" style={{ width: 56, height: 56, margin: '0 auto 16px' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <p className="onb-kyc-status success">{t('onb_m_kyc_approved')}</p>
              </div>
            )}

            {kycStatus === 'rejected' && (
              <div className="onb-kyc-card">
                <div className="onb-kyc-icon rejected">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#c1121f" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M15 9l-6 6M9 9l6 6" />
                  </svg>
                </div>
                <p className="onb-kyc-status error">{t('onb_m_kyc_rejected')}</p>
                <button className="onb-btn" onClick={() => { setKycStatus('not_started'); startKYC(); }}>
                  {t('onb_m_kyc_retry')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 4: Salary + pay frequency + tenure + CLABE + credit preview */}
      <div className={stageClass(4)}>
        {step === 4 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_m_step4_h')} /></h1>
            <p className="onb-sub">{t('onb_m_step4_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step4_salary')}</label>
              <input
                autoFocus
                type="text"
                inputMode="numeric"
                className="onb-input"
                placeholder={t('onb_m_step4_salary_ph')}
                value={memData.salary}
                onChange={(e) => setMemData({ ...memData, salary: e.target.value.replace(/[^\d,]/g, '') })}
              />
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step4_pay_freq')}</label>
              <div className="onb-tiles">
                {PAY_FREQUENCIES.map((freq) => (
                  <button
                    key={freq}
                    className={`onb-tile${memData.payFrequency === freq ? ' active' : ''}`}
                    onClick={() => setMemData({ ...memData, payFrequency: freq })}
                  >
                    <div className="onb-tile-val">{t(`onb_m_step4_freq_${freq}`)}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step4_tenure')}</label>
              <select
                className="onb-select"
                value={memData.employmentTenure}
                onChange={(e) => setMemData({ ...memData, employmentTenure: e.target.value })}
              >
                <option value="">{t('onb_m_step4_tenure_ph')}</option>
                {TENURE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{t(`onb_m_step4_tenure_${opt}`)}</option>
                ))}
              </select>
            </div>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step4_clabe')}</label>
              <input
                type="text"
                inputMode="numeric"
                className={`onb-input${memData.bankClabe.length > 0 && !validateCLABE(memData.bankClabe) ? ' invalid' : validateCLABE(memData.bankClabe) ? ' valid' : ''}`}
                placeholder={t('onb_m_step4_clabe_ph')}
                maxLength={18}
                value={memData.bankClabe}
                onChange={(e) => setMemData({ ...memData, bankClabe: e.target.value.replace(/\D/g, '') })}
              />
              <div className="onb-input-hint">{t('onb_m_step4_clabe_hint')}</div>
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
                    <div className="onb-ring-label">{t('onb_m_step4_credit_label')}</div>
                  </div>
                </div>
                <div className="onb-approved-tag">
                  <span className="onb-approved-dot" />
                  {t('onb_m_step4_preapproved')}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 5: Password + terms */}
      <div className={stageClass(5)}>
        {step === 5 && (
          <div className="onb-content">
            <h1 className="onb-h"><RichText html={t('onb_m_step5_h')} /></h1>
            <p className="onb-sub">{t('onb_m_step5_sub')}</p>
            <div className="onb-field">
              <label className="onb-label">{t('onb_m_step5_pass')}</label>
              <input
                autoFocus
                type="password"
                className="onb-input"
                placeholder={t('onb_m_step5_pass_ph')}
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
                {t('onb_m_step5_terms')}{' '}
                <Link to="/terms" target="_blank">{t('onb_m_step5_terms_link')}</Link>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Step 6: Employee success */}
      <div className={stageClass(6)}>
        <div className="onb-content">
          <div className="onb-celebration">
            <div className="onb-check-circle">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h1 className="onb-h"><RichText html={t('onb_m_step6_h')} /></h1>
            <p className="onb-sub">{t('onb_m_step6_sub')}</p>
            <div className="onb-approved-tag">
              <span className="onb-approved-dot" />
              {t('onb_m_step6_tag')}
            </div>
            <div className="onb-big-amount">
              <span className="onb-cur">$</span>
              {creditAmount.toLocaleString('en-US', { minimumFractionDigits: 0 })}
            </div>
            <p className="onb-sub" style={{ marginBottom: 0 }}>MXN</p>
            <button className="onb-btn" onClick={() => navigate('/employee')}>
              {t('onb_m_step6_cta')}
            </button>
          </div>
        </div>
      </div>
    </>
  );

  // Step context for left panel
  const stepCtxArr = role ? STEP_CONTEXT[role] || [] : [];
  const stepCtx = stepCtxArr[Math.min(step - 1, stepCtxArr.length - 1)] || stepCtxArr[0] || { icon: 'briefcase', title: '', sub: '', trust: '' };

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--bg1, #faf9f7)', overflow: 'hidden' }}>

      {/* ──── LEFT PANEL — Branded Context ──── */}
      {role && !isFinalStep && (
        <div className="onb-v2-left" style={{
          width: '38%', minWidth: 320,
          background: 'linear-gradient(170deg, #0f2a2b 0%, #194445 55%, #1d5253 100%)',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          padding: '40px 44px', position: 'relative', overflow: 'hidden', flexShrink: 0,
        }}>
          <div style={{ position: 'absolute', width: 400, height: 400, top: -100, right: -100, borderRadius: '50%', background: 'radial-gradient(circle, rgba(168,213,208,0.06), transparent 65%)', filter: 'blur(40px)', animation: 'onbMeshDrift 18s ease-in-out infinite', pointerEvents: 'none' }} />
          <div style={{ position: 'relative', zIndex: 2 }}>
            <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: 7, color: 'rgba(255,255,255,0.5)' }}>VID<span style={{ color: '#a28657' }}>A</span></div>
          </div>
          <div key={step} style={{ position: 'relative', zIndex: 2, animation: 'onbFadeSlideIn 0.5s cubic-bezier(0.22,1,0.36,1)' }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'rgba(168,213,208,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24, color: '#a8d5d0' }}>
              <StepIcon name={stepCtx.icon} />
            </div>
            <h2 style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 28, color: 'white', lineHeight: 1.15, letterSpacing: '-0.02em', marginBottom: 12 }}>{stepCtx.title}</h2>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', lineHeight: 1.7, maxWidth: 280 }}>{stepCtx.sub}</p>
          </div>
          <div style={{ position: 'relative', zIndex: 2 }}>
            {stepCtx.trust && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <span style={{ color: 'rgba(168,213,208,0.4)' }}><StepIcon name="shield" /></span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>{stepCtx.trust}</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 5 }}>
              {Array.from({ length: totalSteps }, (_, i) => (
                <div key={i} style={{
                  width: step > i + 1 ? 18 : step === i + 1 ? 18 : 7, height: 3, borderRadius: 3,
                  background: step > i + 1 ? 'rgba(168,213,208,0.35)' : step === i + 1 ? '#a8d5d0' : 'rgba(255,255,255,0.06)',
                  transition: 'all 0.5s cubic-bezier(0.22,1,0.36,1)',
                }} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ──── RIGHT PANEL — Form ──── */}
      <div className="onb-page" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg1, #faf9f7)', overflow: 'auto', position: 'relative' }}>
      {/* Background blobs */}
      <div className="onb-blob ob1" />
      <div className="onb-blob ob2" />

      {/* Top bar */}
      <div className="onb-top">
        {!role && (
          <div className="onb-logo">
            <svg className="vida-logo" viewBox="0 0 80 14" height="14">
              <text x="0" y="12" fontFamily="var(--df)" fontSize="14" fontWeight="700" fill="var(--t1)">vida</text>
            </svg>
          </div>
        )}
        {role && <div />}
        <div className="onb-top-right">
          <Link to="/login">
            {t('onb_already_account')} <strong>{t('onb_login')}</strong>
          </Link>
          <button className="nav-lang" onClick={() => { const next = i18n.language === 'es' ? 'en' : 'es'; i18n.changeLanguage(next); localStorage.setItem('vida_lang', next); }}>
            {i18n.language === 'es' ? 'EN' : 'ES'}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="onb-progress">
        <div className="onb-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      {/* Invite banner */}
      {inviteEmployerName && (
        <div style={{
          margin: '12px 20px 0', padding: '10px 14px', borderRadius: 10,
          background: 'rgba(168,213,208,0.18)', border: '1px solid rgba(29,82,83,0.25)',
          color: '#194445', fontSize: 13, textAlign: 'center', position: 'relative', zIndex: 10,
        }}>
          Has sido invitado por <strong>{inviteEmployerName}</strong>
        </div>
      )}
      {inviteInvalid && (
        <div style={{
          margin: '12px 20px 0', padding: '10px 14px', borderRadius: 10,
          background: 'rgba(220,170,50,0.15)', border: '1px solid rgba(180,130,20,0.35)',
          color: '#6b4a10', fontSize: 13, textAlign: 'center', position: 'relative', zIndex: 10,
        }}>
          Esta invitación no es válida o ya expiró
        </div>
      )}

      {/* Body */}
      <div className="onb-body">
        {/* Back button */}
        {role && !isFinalStep && (
          <button className="onb-back" onClick={goBack} aria-label={t('onb_go_back')}>
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
    </div>
  );
}
