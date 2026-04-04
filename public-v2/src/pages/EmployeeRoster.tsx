import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { doc, getDoc, setDoc, collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

/* ── helpers ─────────────────────────────────────────────── */

function generateEmployerCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function fmtDate(ts?: { seconds: number }): string {
  if (!ts) return '—';
  return new Date(ts.seconds * 1000).toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/* ── types ───────────────────────────────────────────────── */

interface Employee {
  id: string;
  name?: string;
  curp?: string;
  email?: string;
  phone?: string;
  kycStatus?: string;
  createdAt?: { seconds: number };
  loanCount?: number;
  [key: string]: unknown;
}

interface Loan {
  id: string;
  employeeId?: string;
  status: string;
  [key: string]: unknown;
}

type KycFilter = 'all' | 'pending' | 'approved' | 'rejected';

/* ── KYC badge ───────────────────────────────────────────── */

const KYC_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  approved: { bg: 'rgba(36,122,110,0.10)', text: '#247a6e', label: 'Aprobado' },
  pending:  { bg: 'rgba(202,168,60,0.12)', text: '#9a7b1c', label: 'Pendiente' },
  rejected: { bg: 'rgba(180,60,60,0.10)',   text: '#a83232', label: 'Rechazado' },
};

function KycBadge({ status }: { status?: string }) {
  const s = status && KYC_COLORS[status] ? status : 'pending';
  const c = KYC_COLORS[s];
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 10px',
      borderRadius: 20,
      fontSize: 11,
      fontWeight: 600,
      background: c.bg,
      color: c.text,
      letterSpacing: '0.2px',
      whiteSpace: 'nowrap',
    }}>
      {c.label}
    </span>
  );
}

/* ── design tokens ───────────────────────────────────────── */

const card = {
  background: '#fff',
  borderRadius: 20,
  border: '1px solid rgba(25,68,69,0.04)',
  boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
} as const;

const heading = {
  fontFamily: "'DM Serif Display',Georgia,serif",
  fontWeight: 400,
  letterSpacing: '-0.02em',
  lineHeight: 1.15,
  color: '#0c1e1f',
} as const;

/* ── component ───────────────────────────────────────────── */

export function EmployeeRoster() {
  const { t } = useTranslation();
  const { user } = useAuth();

  /* employer code */
  const [employerCode, setEmployerCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /* data */
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);

  /* filters */
  const [search, setSearch] = useState('');
  const [kycFilter, setKycFilter] = useState<KycFilter>('all');

  /* ── fetch employer code ─────────────────────────────── */
  useEffect(() => {
    if (!user) return;
    (async () => {
      const empRef = doc(db, 'employers', user.uid);
      const empDoc = await getDoc(empRef);
      if (empDoc.exists()) {
        const data = empDoc.data();
        if (data.employerCode) {
          setEmployerCode(data.employerCode);
        } else {
          const code = generateEmployerCode();
          await setDoc(empRef, { employerCode: code }, { merge: true });
          setEmployerCode(code);
        }
      }
    })();
  }, [user]);

  /* ── real-time employees ─────────────────────────────── */
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'employees'),
      where('employerId', '==', user.uid),
    );
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Employee));
      setEmployees(data);
      setLoading(false);
    });
    return unsub;
  }, [user]);

  /* ── real-time loans (for counts) ────────────────────── */
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'loans'),
      where('employerId', '==', user.uid),
    );
    const unsub = onSnapshot(q, (snap) => {
      setLoans(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan)));
    });
    return unsub;
  }, [user]);

  /* ── derived: loan counts per employee ───────────────── */
  const loanCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of loans) {
      if (l.employeeId) {
        map[l.employeeId] = (map[l.employeeId] ?? 0) + 1;
      }
    }
    return map;
  }, [loans]);

  const activeLoansCount = useMemo(
    () => loans.filter((l) => l.status === 'active').length,
    [loans],
  );

  /* ── filtered list ───────────────────────────────────── */
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return employees.filter((e) => {
      if (kycFilter !== 'all' && (e.kycStatus ?? 'pending') !== kycFilter) return false;
      if (q) {
        const name = (e.name ?? '').toLowerCase();
        const curp = (e.curp ?? '').toLowerCase();
        if (!name.includes(q) && !curp.includes(q)) return false;
      }
      return true;
    });
  }, [employees, search, kycFilter]);

  /* ── copy invite code ────────────────────────────────── */
  const handleCopy = async () => {
    if (!employerCode) return;
    await navigator.clipboard.writeText(employerCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /* ── KYC filter tabs ─────────────────────────────────── */
  const kycTabs: { key: KycFilter; label: string }[] = [
    { key: 'all', label: t('roster_filter_all', 'Todos') },
    { key: 'approved', label: t('roster_filter_approved', 'Aprobados') },
    { key: 'pending', label: t('roster_filter_pending', 'Pendientes') },
    { key: 'rejected', label: t('roster_filter_rejected', 'Rechazados') },
  ];

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '48px 24px 64px' }}>
      {/* Page title */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ ...heading, fontSize: 26, marginBottom: 8 }}>
          {t('dash_employees', 'Empleados')}
        </h1>
        <p style={{ fontSize: 14, color: '#4a6364', lineHeight: 1.7 }}>
          {t('roster_invite_desc', 'Comparte el código de invitación con tus empleados para que puedan registrarse.')}
        </p>
      </div>

      {/* ── Stats row + Invite code ─────────────────────── */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        {/* Total employees */}
        <div style={{ ...card, padding: '24px 28px', flex: '1 1 180px', minWidth: 160 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '2px', color: '#a28657', marginBottom: 8 }}>
            {t('roster_stat_total', 'Total Empleados')}
          </div>
          <div style={{ ...heading, fontSize: 32 }}>{employees.length}</div>
        </div>

        {/* Active loans */}
        <div style={{ ...card, padding: '24px 28px', flex: '1 1 180px', minWidth: 160 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '2px', color: '#a28657', marginBottom: 8 }}>
            {t('roster_stat_loans', 'Préstamos Activos')}
          </div>
          <div style={{ ...heading, fontSize: 32 }}>{activeLoansCount}</div>
        </div>

        {/* Invite code */}
        {!loading && employerCode && (
          <div style={{ ...card, padding: '24px 28px', flex: '1 1 260px', minWidth: 220, display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '2px', color: '#a28657', marginBottom: 8 }}>
                {t('roster_invite_title', 'Código de Invitación')}
              </div>
              <div style={{ ...heading, fontSize: 24, letterSpacing: '0.15em' }}>{employerCode}</div>
            </div>
            <button
              onClick={handleCopy}
              style={{
                background: copied ? '#247a6e' : '#194445',
                color: '#fff',
                borderRadius: 60,
                padding: '10px 18px',
                fontSize: 12,
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.3s',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                whiteSpace: 'nowrap',
              }}
            >
              {copied ? (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}>
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  {t('roster_copied', 'Copiado')}
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                  </svg>
                  {t('roster_copy', 'Copiar')}
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* ── Search + Filter bar ─────────────────────────── */}
      <div style={{ ...card, padding: '20px 24px', marginBottom: 20, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Search input */}
        <div style={{ flex: '1 1 240px', position: 'relative' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="#93aaa9" strokeWidth="2" style={{ width: 16, height: 16, position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('roster_search', 'Buscar por nombre o CURP…')}
            style={{
              width: '100%',
              padding: '10px 12px 10px 36px',
              border: '1px solid rgba(25,68,69,0.10)',
              borderRadius: 12,
              fontSize: 13,
              color: '#0c1e1f',
              outline: 'none',
              background: '#fafaf8',
            }}
          />
        </div>

        {/* KYC filter tabs */}
        <div style={{ display: 'flex', gap: 4 }}>
          {kycTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setKycFilter(tab.key)}
              style={{
                padding: '7px 14px',
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.2s',
                background: kycFilter === tab.key ? '#194445' : 'rgba(25,68,69,0.05)',
                color: kycFilter === tab.key ? '#fff' : '#4a6364',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Employee list ───────────────────────────────── */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '48px 28px', textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: '#93aaa9' }}>
              {t('roster_loading', 'Cargando empleados…')}
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '48px 28px', textAlign: 'center' }}>
            <div style={{
              width: 56, height: 56, borderRadius: '50%',
              background: 'rgba(162,134,87,0.06)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px',
            }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#a28657" strokeWidth="1.5" style={{ width: 24, height: 24 }}>
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 00-3-3.87" />
                <path d="M16 3.13a4 4 0 010 7.75" />
              </svg>
            </div>
            <p style={{ fontSize: 14, color: '#93aaa9', lineHeight: 1.6, maxWidth: 300, margin: '0 auto' }}>
              {search || kycFilter !== 'all'
                ? t('roster_no_results', 'No se encontraron empleados con estos filtros.')
                : t('roster_empty', 'Aún no hay empleados registrados. Comparte tu código de invitación para comenzar.')}
            </p>
          </div>
        ) : (
          <>
            {/* Table header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1.4fr 1.2fr 1fr 0.7fr 0.6fr',
              padding: '14px 24px',
              borderBottom: '1px solid rgba(25,68,69,0.06)',
              background: '#fafaf8',
            }}>
              {[
                t('roster_col_name', 'Nombre'),
                t('roster_col_curp', 'CURP'),
                t('roster_col_contact', 'Contacto'),
                t('roster_col_joined', 'Registro'),
                t('roster_col_kyc', 'KYC'),
                t('roster_col_loans', 'Prést.'),
              ].map((h) => (
                <div key={h} style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '1.5px', color: '#93aaa9' }}>
                  {h}
                </div>
              ))}
            </div>

            {/* Rows */}
            {filtered.map((emp) => (
              <div
                key={emp.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1.4fr 1.2fr 1fr 0.7fr 0.6fr',
                  padding: '16px 24px',
                  borderBottom: '1px solid rgba(25,68,69,0.04)',
                  alignItems: 'center',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#fafaf8'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              >
                {/* Name */}
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0c1e1f', lineHeight: 1.4 }}>
                    {emp.name ?? '—'}
                  </div>
                </div>

                {/* CURP */}
                <div style={{ fontSize: 12.5, color: '#4a6364', fontFamily: 'monospace', letterSpacing: '0.03em' }}>
                  {emp.curp ?? '—'}
                </div>

                {/* Contact */}
                <div>
                  <div style={{ fontSize: 12.5, color: '#4a6364', lineHeight: 1.5 }}>{emp.email ?? '—'}</div>
                  <div style={{ fontSize: 12, color: '#93aaa9' }}>{emp.phone ?? ''}</div>
                </div>

                {/* Joined */}
                <div style={{ fontSize: 12.5, color: '#4a6364' }}>
                  {fmtDate(emp.createdAt)}
                </div>

                {/* KYC */}
                <div>
                  <KycBadge status={emp.kycStatus} />
                </div>

                {/* Loan count */}
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0c1e1f', textAlign: 'center' }}>
                  {loanCountMap[emp.id] ?? 0}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
