import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { doc, getDoc, collection, query, where, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

/* ── helpers ─────────────────────────────────────────────── */

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
  authUid?: string;
  status?: string;
  [key: string]: unknown;
}

interface InviteRecord {
  employeeDocId: string;
  sentAt?: { seconds: number } | null;
  acceptedAt?: { seconds: number } | null;
  expiresAt?: { seconds: number } | null;
  status?: string;
}

type InviteState = 'active' | 'invited' | 'pending';

const RESEND_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BULK_DELAY_MS = 200;
const BULK_WARN_THRESHOLD = 50;

interface Loan {
  id: string;
  employeeId?: string;
  status: string;
  [key: string]: unknown;
}

type KycFilter = 'all' | 'pending' | 'approved' | 'rejected';

/* ── KYC badge ───────────────────────────────────────────── */

const KYC_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  approved: { bg: 'rgba(36,122,110,0.10)', text: 'var(--success)', label: 'Aprobado' },
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

/* ── Invite status badge ─────────────────────────────────── */

const INVITE_COLORS: Record<InviteState, { bg: string; text: string }> = {
  active:  { bg: 'rgba(36,122,110,0.10)', text: 'var(--success)' },
  invited: { bg: 'rgba(42,102,160,0.10)', text: '#2a66a0' },
  pending: { bg: 'rgba(147,170,169,0.15)', text: '#6b8382' },
};

function InviteBadge({ state, label }: { state: InviteState; label: string }) {
  const c = INVITE_COLORS[state];
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
      {label}
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
  fontFamily: 'var(--df)',
  fontWeight: 400,
  letterSpacing: '-0.02em',
  lineHeight: 1.15,
  color: 'var(--t1)',
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

  /* invites */
  const [invitesByEmployee, setInvitesByEmployee] = useState<Record<string, InviteRecord>>({});
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  const [bulkSending, setBulkSending] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error' | 'info'; msg: string } | null>(null);

  /* ── fetch employer code ─────────────────────────────── */
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const empRef = doc(db, 'employers', user.uid);
        const empDoc = await getDoc(empRef);
        if (!empDoc.exists()) return;
        const data = empDoc.data();
        if (data.employerCode) {
          setEmployerCode(data.employerCode);
          return;
        }
        // Backfilling employerCode is a privileged write (firestore.rules'
        // employer-update whitelist denies it, and the client generator had
        // no uniqueness check against other employers' codes) — minted
        // server-side instead. See ensureEmployerCode in functions/src/index.ts.
        const functions = getFunctions();
        const ensureCode = httpsCallable<unknown, { employerCode: string }>(functions, 'ensureEmployerCode');
        const { data: result } = await ensureCode({});
        setEmployerCode(result.employerCode);
      } catch {
        setToast({ kind: 'error', msg: t('roster_toast_code_error', 'No se pudo generar el código de invitación') });
      }
    })();
  }, [user, t]);

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

  /* ── real-time invites (for status + cooldown) ───────── */
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'invites'),
      where('employerId', '==', user.uid),
    );
    const unsub = onSnapshot(q, (snap) => {
      const map: Record<string, InviteRecord> = {};
      snap.docs.forEach((d) => {
        const data = d.data() as InviteRecord;
        const empId = data.employeeDocId;
        if (!empId) return;
        const existing = map[empId];
        const newSec = data.sentAt?.seconds ?? 0;
        const oldSec = existing?.sentAt?.seconds ?? 0;
        if (!existing || newSec > oldSec) {
          map[empId] = data;
        }
      });
      setInvitesByEmployee(map);
    });
    return unsub;
  }, [user]);

  /* ── toast auto-dismiss ──────────────────────────────── */
  useEffect(() => {
    if (!toast || toast.kind === 'info') return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

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

  /* ── invite helpers ──────────────────────────────────── */
  const getInviteState = (emp: Employee): InviteState => {
    if (emp.authUid) return 'active';
    const inv = invitesByEmployee[emp.id];
    const sentMs = (inv?.sentAt?.seconds ?? 0) * 1000;
    if (inv && !inv.acceptedAt && sentMs > 0 && Date.now() - sentMs < INVITE_TTL_MS) {
      return 'invited';
    }
    return 'pending';
  };

  const canResend = (emp: Employee): boolean => {
    const inv = invitesByEmployee[emp.id];
    const sentMs = (inv?.sentAt?.seconds ?? 0) * 1000;
    if (!sentMs) return true;
    return Date.now() - sentMs >= RESEND_COOLDOWN_MS;
  };

  const sendInvite = async (employeeDocId: string): Promise<void> => {
    if (!user) throw new Error('not authenticated');
    const fn = httpsCallable(getFunctions(), 'sendEmployeeInvite');
    await fn({ employerId: user.uid, employeeDocId });
  };

  const handleInvite = async (employeeDocId: string) => {
    setSendingIds((prev) => {
      const next = new Set(prev);
      next.add(employeeDocId);
      return next;
    });
    try {
      await sendInvite(employeeDocId);
      setToast({ kind: 'success', msg: t('roster_toast_invite_sent', 'Invitación enviada') });
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e)) ||
        t('roster_toast_invite_error', 'No se pudo enviar la invitación');
      setToast({ kind: 'error', msg });
    } finally {
      setSendingIds((prev) => {
        const next = new Set(prev);
        next.delete(employeeDocId);
        return next;
      });
    }
  };

  const pendingEmployees = useMemo(
    () => employees.filter((e) => getInviteState(e) === 'pending'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [employees, invitesByEmployee],
  );

  const handleBulkInvite = async () => {
    if (bulkSending) return;
    const targets = pendingEmployees;
    if (targets.length === 0) {
      setToast({ kind: 'info', msg: t('roster_bulk_nothing', 'No hay empleados pendientes por invitar') });
      return;
    }
    if (targets.length > BULK_WARN_THRESHOLD) {
      const confirmMsg = t('roster_bulk_confirm_many', 'Se enviarán {{count}} invitaciones. ¿Continuar?', { count: targets.length });
      if (!window.confirm(confirmMsg)) return;
    }
    setBulkSending(true);
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      const emp = targets[i];
      setToast({
        kind: 'info',
        msg: t('roster_bulk_progress', 'Enviando {{done}} de {{total}} invitaciones…', { done: i + 1, total: targets.length }),
      });
      try {
        await sendInvite(emp.id);
        sent++;
      } catch {
        failed++;
      }
      if (i < targets.length - 1) {
        await new Promise((r) => setTimeout(r, BULK_DELAY_MS));
      }
    }
    setBulkSending(false);
    setToast({
      kind: failed > 0 ? 'error' : 'success',
      msg: t('roster_bulk_done', '{{sent}} enviadas, {{failed}} fallaron', { sent, failed }),
    });
  };

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
        <p style={{ fontSize: 14, color: 'var(--t2)', lineHeight: 1.7 }}>
          {t('roster_invite_desc', 'Comparte el código de invitación con tus empleados para que puedan registrarse.')}
        </p>
      </div>

      {/* ── Stats row + Invite code ─────────────────────── */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        {/* Total employees */}
        <div style={{ ...card, padding: '24px 28px', flex: '1 1 180px', minWidth: 160 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '2px', color: 'var(--gold)', marginBottom: 8 }}>
            {t('roster_stat_total', 'Total Empleados')}
          </div>
          <div style={{ ...heading, fontSize: 32 }}>{employees.length}</div>
        </div>

        {/* Active loans */}
        <div style={{ ...card, padding: '24px 28px', flex: '1 1 180px', minWidth: 160 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '2px', color: 'var(--gold)', marginBottom: 8 }}>
            {t('roster_stat_loans', 'Préstamos Activos')}
          </div>
          <div style={{ ...heading, fontSize: 32 }}>{activeLoansCount}</div>
        </div>

        {/* Invite code */}
        {!loading && employerCode && (
          <div style={{ ...card, padding: '24px 28px', flex: '1 1 260px', minWidth: 220, display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '2px', color: 'var(--gold)', marginBottom: 8 }}>
                {t('roster_invite_title', 'Código de Invitación')}
              </div>
              <div style={{ ...heading, fontSize: 24, letterSpacing: '0.15em' }}>{employerCode}</div>
            </div>
            <button
              onClick={handleCopy}
              style={{
                background: copied ? 'var(--success)' : 'var(--brand)',
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
            aria-label={t('a11y_search_roster')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('roster_search', 'Buscar por nombre o CURP…')}
            style={{
              width: '100%',
              padding: '10px 12px 10px 36px',
              border: '1px solid rgba(25,68,69,0.10)',
              borderRadius: 12,
              fontSize: 13,
              color: 'var(--t1)',
              outline: 'none',
              background: 'var(--bg2)',
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
                background: kycFilter === tab.key ? 'var(--brand)' : 'rgba(25,68,69,0.05)',
                color: kycFilter === tab.key ? '#fff' : 'var(--t2)',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Bulk invite */}
        <button
          onClick={handleBulkInvite}
          disabled={bulkSending || pendingEmployees.length === 0}
          style={{
            padding: '8px 16px',
            borderRadius: 20,
            fontSize: 12,
            fontWeight: 600,
            border: 'none',
            cursor: bulkSending || pendingEmployees.length === 0 ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s',
            background: pendingEmployees.length === 0 ? 'rgba(25,68,69,0.08)' : 'var(--gold)',
            color: pendingEmployees.length === 0 ? 'var(--t3)' : '#fff',
            opacity: bulkSending ? 0.7 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {bulkSending
            ? t('roster_btn_sending', 'Enviando…')
            : `${t('roster_bulk_invite', 'Invitar a todos los pendientes')} (${pendingEmployees.length})`}
        </button>
      </div>

      {/* ── Toast ───────────────────────────────────────── */}
      {toast && (
        <div
          role="status"
          style={{
            marginBottom: 16,
            padding: '12px 16px',
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 500,
            background:
              toast.kind === 'success' ? 'rgba(36,122,110,0.10)' :
              toast.kind === 'error'   ? 'rgba(180,60,60,0.10)' :
                                         'rgba(25,68,69,0.06)',
            color:
              toast.kind === 'success' ? 'var(--success)' :
              toast.kind === 'error'   ? '#a83232' :
                                         'var(--t2)',
          }}
        >
          {toast.msg}
        </div>
      )}

      {/* ── Employee list ───────────────────────────────── */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '48px 28px', textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: 'var(--t3)' }}>
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
            <p style={{ fontSize: 14, color: 'var(--t3)', lineHeight: 1.6, maxWidth: 300, margin: '0 auto' }}>
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
              gridTemplateColumns: '1.8fr 1.3fr 1.2fr 0.9fr 0.7fr 0.5fr 1.3fr',
              padding: '14px 24px',
              borderBottom: '1px solid rgba(25,68,69,0.06)',
              background: 'var(--bg2)',
            }}>
              {[
                t('roster_col_name', 'Nombre'),
                t('roster_col_curp', 'CURP'),
                t('roster_col_contact', 'Contacto'),
                t('roster_col_joined', 'Registro'),
                t('roster_col_kyc', 'KYC'),
                t('roster_col_loans', 'Prést.'),
                t('roster_col_status', 'Estado'),
              ].map((h) => (
                <div key={h} style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '1.5px', color: 'var(--t3)' }}>
                  {h}
                </div>
              ))}
            </div>

            {/* Rows */}
            {filtered.map((emp) => {
              const inviteState = getInviteState(emp);
              const isSending = sendingIds.has(emp.id);
              const resendReady = canResend(emp);
              return (
              <div
                key={emp.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.8fr 1.3fr 1.2fr 0.9fr 0.7fr 0.5fr 1.3fr',
                  padding: '16px 24px',
                  borderBottom: '1px solid rgba(25,68,69,0.04)',
                  alignItems: 'center',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg2)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              >
                {/* Name */}
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', lineHeight: 1.4 }}>
                    {emp.name ?? '—'}
                  </div>
                </div>

                {/* CURP */}
                <div style={{ fontSize: 12.5, color: 'var(--t2)', fontFamily: 'monospace', letterSpacing: '0.03em' }}>
                  {emp.curp ?? '—'}
                </div>

                {/* Contact */}
                <div>
                  <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.5 }}>{emp.email ?? '—'}</div>
                  <div style={{ fontSize: 12, color: 'var(--t3)' }}>{emp.phone ?? ''}</div>
                </div>

                {/* Joined */}
                <div style={{ fontSize: 12.5, color: 'var(--t2)' }}>
                  {fmtDate(emp.createdAt)}
                </div>

                {/* KYC */}
                <div>
                  <KycBadge status={emp.kycStatus} />
                </div>

                {/* Loan count */}
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', textAlign: 'center' }}>
                  {loanCountMap[emp.id] ?? 0}
                </div>

                {/* Invite status + action */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                  {inviteState === 'active' && (
                    <InviteBadge state="active" label={t('roster_status_active', 'Activo')} />
                  )}
                  {inviteState === 'invited' && (
                    <>
                      <InviteBadge state="invited" label={t('roster_status_invited', 'Invitación enviada')} />
                      <button
                        onClick={() => handleInvite(emp.id)}
                        disabled={isSending || !resendReady || bulkSending}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 14,
                          fontSize: 11,
                          fontWeight: 600,
                          border: '1px solid rgba(25,68,69,0.12)',
                          background: '#fff',
                          color: resendReady && !isSending ? 'var(--brand)' : 'var(--t3)',
                          cursor: isSending || !resendReady || bulkSending ? 'not-allowed' : 'pointer',
                          opacity: isSending || !resendReady ? 0.6 : 1,
                        }}
                      >
                        {isSending
                          ? t('roster_btn_sending', 'Enviando…')
                          : t('roster_btn_resend', 'Reenviar')}
                      </button>
                    </>
                  )}
                  {inviteState === 'pending' && (
                    <>
                      <InviteBadge state="pending" label={t('roster_status_pending', 'Pendiente')} />
                      <button
                        onClick={() => handleInvite(emp.id)}
                        disabled={isSending || bulkSending}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 14,
                          fontSize: 11,
                          fontWeight: 600,
                          border: 'none',
                          background: 'var(--brand)',
                          color: '#fff',
                          cursor: isSending || bulkSending ? 'not-allowed' : 'pointer',
                          opacity: isSending || bulkSending ? 0.6 : 1,
                        }}
                      >
                        {isSending
                          ? t('roster_btn_sending', 'Enviando…')
                          : t('roster_btn_invite', 'Invitar')}
                      </button>
                    </>
                  )}
                </div>
              </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
