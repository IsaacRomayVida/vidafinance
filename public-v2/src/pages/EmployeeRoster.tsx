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

/* ── KYC badge — green only for "approved" ───────────────── */

const KYC_CLASS: Record<string, string> = {
  approved: ' g',
  pending: ' warn',
  rejected: ' bad',
};

function KycBadge({ status }: { status?: string }) {
  const { t } = useTranslation();
  const s = status && KYC_CLASS[status] ? status : 'pending';
  return <span className={`ops-status${KYC_CLASS[s]}`}>{t(`status_${s}`)}</span>;
}

/* ── Invite status badge — green only for an active account ── */

const INVITE_CLASS: Record<InviteState, string> = {
  active: ' g',
  invited: '',
  pending: ' mute',
};

function InviteBadge({ state, label }: { state: InviteState; label: string }) {
  return <span className={`ops-status${INVITE_CLASS[state]}`}>{label}</span>;
}

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
  const [error, setError] = useState<string | null>(null);

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
    const unsub = onSnapshot(
      q,
      (snap) => {
        const data = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Employee));
        setEmployees(data);
        setLoading(false);
        setError(null);
      },
      (listenError) => {
        console.error('Firestore listen error:', listenError);
        setLoading(false);
        setError('Error al cargar los datos. Intenta de nuevo.');
      },
    );
    return unsub;
  }, [user]);

  /* ── real-time loans (for counts) ────────────────────── */
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'loans'),
      where('employerId', '==', user.uid),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setLoans(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan)));
        setError(null);
      },
      (listenError) => {
        console.error('Firestore listen error:', listenError);
        setLoading(false);
        setError('Error al cargar los datos. Intenta de nuevo.');
      },
    );
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
    <div className="ops-page">
      {/* Page title */}
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_payroll')}</div>
          <h1 className="ops-title">{t('dash_employees', 'Empleados')}</h1>
          <p className="ops-sub">
            {t('roster_invite_desc', 'Comparte el código de invitación con tus empleados para que puedan registrarse.')}
          </p>
        </div>
      </div>

      {/* ── Stats row + Invite code ─────────────────────── */}
      <div className="ops-kpis" style={{ marginTop: 0, marginBottom: 10 }}>
        <div className="ops-kpi">
          <small>{t('roster_stat_total', 'Total Empleados')}</small>
          <b>{employees.length}</b>
        </div>
        <div className="ops-kpi">
          <small>{t('roster_stat_loans', 'Préstamos Activos')}</small>
          <b>{activeLoansCount}</b>
        </div>
        {!loading && employerCode && (
          <div className="ops-kpi">
            <small>{t('roster_invite_title', 'Código de Invitación')}</small>
            <b style={{ display: 'flex', alignItems: 'center', gap: 10, letterSpacing: '.12em' }}>
              {employerCode}
              <button
                type="button"
                onClick={handleCopy}
                className={`ops-btn sm${copied ? ' g' : ''}`}
                style={{ marginLeft: 'auto', letterSpacing: 0 }}
              >
                {copied ? t('roster_copied', 'Copiado') : t('roster_copy', 'Copiar')}
              </button>
            </b>
          </div>
        )}
      </div>

      {/* ── Search + Filter bar ─────────────────────────── */}
      <div className="ops-card quiet" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '14px 16px' }}>
        <div style={{ flex: '1 1 240px' }}>
          <input
            type="text"
            className="ops-input"
            aria-label={t('a11y_search_roster')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('roster_search', 'Buscar por nombre o CURP…')}
          />
        </div>

        {/* KYC filter chips */}
        <div className="ops-chips">
          {kycTabs.map((tab) => {
            const on = kycFilter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setKycFilter(tab.key)}
                className={`ops-chip${on ? ' on' : ''}`}
                aria-pressed={on}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Bulk invite — the one white action on this page */}
        <button
          type="button"
          onClick={handleBulkInvite}
          disabled={bulkSending || pendingEmployees.length === 0}
          className="ops-go"
          style={{ marginTop: 0 }}
        >
          <i aria-hidden="true" />
          {bulkSending
            ? t('roster_btn_sending', 'Enviando…')
            : `${t('roster_bulk_invite', 'Invitar a todos los pendientes')} (${pendingEmployees.length})`}
        </button>
      </div>

      {/* ── Toast ───────────────────────────────────────── */}
      {toast && (
        <div role="status" className={`ops-toast ${toast.kind}`}>
          {toast.msg}
        </div>
      )}

      {/* ── Employee list ───────────────────────────────── */}
      <div className="ops-card">
        {error ? (
          <div className="ops-error" style={{ padding: '32px 0', textAlign: 'center' }}>{error}</div>
        ) : loading ? (
          <div className="empty-state" aria-busy="true">
            <p>{t('roster_loading', 'Cargando empleados…')}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" width="48" height="48" aria-hidden="true">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 00-3-3.87" />
              <path d="M16 3.13a4 4 0 010 7.75" />
            </svg>
            <p style={{ maxWidth: 320, margin: '0 auto' }}>
              {search || kycFilter !== 'all'
                ? t('roster_no_results', 'No se encontraron empleados con estos filtros.')
                : t('roster_empty', 'Aún no hay empleados registrados. Comparte tu código de invitación para comenzar.')}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('roster_col_name', 'Nombre')}</th>
                  <th>{t('roster_col_curp', 'CURP')}</th>
                  <th>{t('roster_col_contact', 'Contacto')}</th>
                  <th>{t('roster_col_joined', 'Registro')}</th>
                  <th>{t('roster_col_kyc', 'KYC')}</th>
                  <th className="num">{t('roster_col_loans', 'Prést.')}</th>
                  <th>{t('roster_col_status', 'Estado')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((emp) => {
                  const inviteState = getInviteState(emp);
                  const isSending = sendingIds.has(emp.id);
                  const resendReady = canResend(emp);
                  return (
                    <tr key={emp.id}>
                      <td style={{ fontWeight: 500 }}>{emp.name ?? '—'}</td>
                      <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, letterSpacing: '0.03em', color: 'rgba(242,245,240,.75)' }}>
                        {emp.curp ?? '—'}
                      </td>
                      <td style={{ whiteSpace: 'normal' }}>
                        <div style={{ fontSize: 12.5, color: 'rgba(242,245,240,.75)', lineHeight: 1.5 }}>{emp.email ?? '—'}</div>
                        <div style={{ fontSize: 12, color: 'rgba(242,245,240,.62)' }}>{emp.phone ?? ''}</div>
                      </td>
                      <td style={{ color: 'rgba(242,245,240,.75)' }}>{fmtDate(emp.createdAt)}</td>
                      <td><KycBadge status={emp.kycStatus} /></td>
                      <td className="num" style={{ fontWeight: 500 }}>{loanCountMap[emp.id] ?? 0}</td>
                      <td>
                        <div className="ops-actions" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                          {inviteState === 'active' && (
                            <InviteBadge state="active" label={t('roster_status_active', 'Activo')} />
                          )}
                          {inviteState === 'invited' && (
                            <>
                              <InviteBadge state="invited" label={t('roster_status_invited', 'Invitación enviada')} />
                              <button
                                type="button"
                                className="ops-btn sm ghost"
                                onClick={() => handleInvite(emp.id)}
                                disabled={isSending || !resendReady || bulkSending}
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
                                type="button"
                                className="ops-btn sm"
                                onClick={() => handleInvite(emp.id)}
                                disabled={isSending || bulkSending}
                              >
                                {isSending
                                  ? t('roster_btn_sending', 'Enviando…')
                                  : t('roster_btn_invite', 'Invitar')}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
