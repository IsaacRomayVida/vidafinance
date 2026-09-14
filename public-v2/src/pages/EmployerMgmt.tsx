import { useState, useEffect, useMemo } from 'react';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

/* ── Employer document shape ─────────────────────────────────────────────── */

interface Employer {
  id: string;
  companyName: string;
  contactName?: string;
  email: string;
  status: string;
  tier?: string;
  employeeCount?: number;
  totalEmployees?: number;
  companySize?: string;
  employerCode?: string;
  docRFC?: string | null;
  createdAt?: { seconds: number };
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatDate(ts?: { seconds: number }): string {
  if (!ts) return '—';
  return new Date(ts.seconds * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Green only for an approved employer. */
function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case 'pending_verification':
    case 'pending_review':
      return { label: 'Pending', cls: ' warn' };
    case 'active':
    case 'approved':
      return { label: 'Approved', cls: ' g' };
    case 'rejected':
      return { label: 'Rejected', cls: ' bad' };
    case 'suspended':
      return { label: 'Suspended', cls: ' mute' };
    default:
      return { label: status, cls: '' };
  }
}

function isPending(status: string): boolean {
  return status === 'pending_verification' || status === 'pending_review';
}

/* ── component ───────────────────────────────────────────────────────────── */

export function EmployerMgmt() {
  useAuth();
  const [employers, setEmployers] = useState<Employer[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected' | 'suspended'>('all');

  // Real-time employers listener
  useEffect(() => {
    const q = query(collection(db, 'employers'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setEmployers(snap.docs.map(d => ({ id: d.id, ...d.data() } as Employer)));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  // Approve / Reject
  const handleDecision = async (employerId: string, approved: boolean) => {
    setActionLoading(employerId);
    try {
      const functions = getFunctions();
      const fn = httpsCallable(functions, 'approveEmployer');
      // The deployed callable (index.ts) destructures `employerUid`, not
      // `employerId` — sending `employerId` alone made every approve/reject
      // click here throw "employerUid is required".
      await fn({ employerUid: employerId, approved });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      alert('Error: ' + msg);
    } finally {
      setActionLoading(null);
    }
  };

  // Derived data
  const stats = useMemo(() => {
    const pending = employers.filter(e => isPending(e.status)).length;
    const approved = employers.filter(e => e.status === 'active' || e.status === 'approved').length;
    const totalEmployees = employers.reduce((sum, e) => sum + (Number(e.employeeCount) || Number(e.totalEmployees) || 0), 0);
    return { total: employers.length, pending, approved, totalEmployees };
  }, [employers]);

  const filtered = useMemo(() => {
    let list = employers;
    // Filter by status
    if (filter === 'pending') list = list.filter(e => isPending(e.status));
    else if (filter === 'approved') list = list.filter(e => e.status === 'active' || e.status === 'approved');
    else if (filter === 'rejected') list = list.filter(e => e.status === 'rejected');
    else if (filter === 'suspended') list = list.filter(e => e.status === 'suspended');
    // Search by company name
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(e => e.companyName?.toLowerCase().includes(q));
    }
    return list;
  }, [employers, filter, search]);

  const filters: { key: typeof filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'suspended', label: 'Suspended' },
  ];

  /* ── render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="ops-page">
      {/* Header */}
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">Operaciones</div>
          <h1 className="ops-title">Employer Management</h1>
          <p className="ops-sub">View all registered employers and manage approval status.</p>
        </div>
      </div>

      {/* Stats */}
      <div className="ops-kpis four" style={{ marginTop: 0, marginBottom: 10 }}>
        <div className="ops-kpi">
          <small>Total</small>
          <b>{stats.total}</b>
        </div>
        <div className={`ops-kpi${stats.pending > 0 ? ' warn' : ''}`}>
          <small>Pending</small>
          <b>{stats.pending}</b>
        </div>
        <div className="ops-kpi">
          <small>Approved</small>
          <b>{stats.approved}</b>
        </div>
        <div className="ops-kpi">
          <small>Employees</small>
          <b>{fmt(stats.totalEmployees)}</b>
        </div>
      </div>

      {/* Search + filter */}
      <div className="ops-card quiet" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '14px 16px' }}>
        <div style={{ flex: '1 1 240px' }}>
          <input
            type="text"
            className="ops-input"
            aria-label="Search employers by company name"
            placeholder="Search by company name..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="ops-chips">
          {filters.map(f => {
            const on = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`ops-chip${on ? ' on' : ''}`}
                aria-pressed={on}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      <section className="ops-card">
        {/* Loading */}
        {loading && (
          <div className="empty-state" aria-busy="true">
            <p>Loading employers...</p>
          </div>
        )}

        {/* Empty */}
        {!loading && filtered.length === 0 && (
          <div className="empty-state">
            <p>{search || filter !== 'all' ? 'No employers match your filters.' : 'No employers registered yet.'}</p>
          </div>
        )}

        {/* Section label */}
        {!loading && filtered.length > 0 && (
          <h2 className="ops-h3">
            {filter === 'all' ? 'All Employers' : filter.charAt(0).toUpperCase() + filter.slice(1)} ({filtered.length})
          </h2>
        )}

        {/* Employer rows — folder glyph is green only once approved */}
        {filtered.map(emp => {
          const badge = statusBadge(emp.status);
          const pending = isPending(emp.status);
          const empCount = Number(emp.employeeCount) || Number(emp.totalEmployees) || 0;

          return (
            <div key={emp.id} className="ops-batch" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <span className={`fl${badge.cls === ' g' ? ' g' : ''}`} aria-hidden="true" style={{ marginTop: 2 }} />
              <span className="t" style={{ whiteSpace: 'normal' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 500 }}>{emp.companyName}</span>
                  <span className={`ops-status${badge.cls}`}>{badge.label}</span>
                </span>
                {emp.contactName && (
                  <small style={{ whiteSpace: 'normal' }}>{emp.contactName}</small>
                )}
                <small style={{ whiteSpace: 'normal' }}>{emp.email}</small>
                <small style={{ whiteSpace: 'normal', marginTop: 4 }}>
                  {emp.tier && <>Tier {emp.tier} · </>}
                  Employees {fmt(empCount)}
                  {emp.companySize && <> · Size {emp.companySize}</>}
                  {emp.employerCode && <> · Code {emp.employerCode}</>}
                  {' · '}Registered {formatDate(emp.createdAt)}
                </small>
              </span>

              {/* Actions for pending employers */}
              {pending && (
                <span className="ops-actions">
                  <button
                    type="button"
                    className="ops-btn sm"
                    onClick={() => handleDecision(emp.id, true)}
                    disabled={!!actionLoading}
                  >
                    {actionLoading === emp.id ? 'Processing...' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="ops-btn sm ghost danger"
                    onClick={() => handleDecision(emp.id, false)}
                    disabled={!!actionLoading}
                  >
                    Reject
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
