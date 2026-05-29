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

function statusBadge(status: string): { label: string; bg: string; text: string } {
  switch (status) {
    case 'pending_verification':
    case 'pending_review':
      return { label: 'Pending', bg: 'rgba(212,160,60,0.10)', text: 'var(--warning)' };
    case 'active':
    case 'approved':
      return { label: 'Approved', bg: 'rgba(36,122,110,0.08)', text: 'var(--brand-light)' };
    case 'rejected':
      return { label: 'Rejected', bg: 'rgba(220,80,60,0.08)', text: 'var(--danger)' };
    case 'suspended':
      return { label: 'Suspended', bg: 'rgba(147,170,169,0.10)', text: '#6b8382' };
    default:
      return { label: status, bg: 'rgba(147,170,169,0.10)', text: 'var(--t2)' };
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
      await fn({ employerId, approved });
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

  /* ── styles (matching AdminDashboard design system) ────────────────────── */

  const cardStyle: React.CSSProperties = {
    background: '#fff',
    borderRadius: 20,
    padding: '28px',
    border: '1px solid rgba(25,68,69,0.04)',
    boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
    marginBottom: 20,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '2.2px',
    color: 'var(--gold)',
    marginBottom: 10,
  };

  const valueStyle: React.CSSProperties = {
    fontFamily: 'var(--df)',
    fontSize: 36,
    color: 'var(--t1)',
    letterSpacing: '-0.03em',
    fontWeight: 400,
    lineHeight: 1,
  };

  const pillBtn = (color: string, textColor: string): React.CSSProperties => ({
    background: color,
    color: textColor,
    borderRadius: 60,
    padding: '10px 24px',
    fontSize: 12,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.2s',
    letterSpacing: '0.2px',
    opacity: actionLoading ? 0.6 : 1,
  });

  const filters: { key: typeof filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'suspended', label: 'Suspended' },
  ];

  /* ── render ─────────────────────────────────────────────────────────────── */

  return (
    <div style={{ maxWidth: 620, margin: '0 auto', padding: '48px 0 64px' }}>
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontFamily: 'var(--df)', fontSize: 26, color: 'var(--t1)', fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 8 }}>
          Employer Management
        </h1>
        <p style={{ fontSize: 14, color: 'var(--t2)', lineHeight: 1.7 }}>
          View all registered employers and manage approval status.
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16, marginBottom: 32 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>Total</div>
          <div style={valueStyle}>{stats.total}</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Pending</div>
          <div style={{ ...valueStyle, color: stats.pending > 0 ? 'var(--warning)' : 'var(--t1)' }}>{stats.pending}</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Approved</div>
          <div style={{ ...valueStyle, color: stats.approved > 0 ? 'var(--brand-light)' : 'var(--t1)' }}>{stats.approved}</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Employees</div>
          <div style={valueStyle}>{fmt(stats.totalEmployees)}</div>
        </div>
      </div>

      {/* Search + filter */}
      <div style={{ marginBottom: 24 }}>
        <input
          type="text"
          aria-label="Search employers by company name"
          placeholder="Search by company name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%',
            padding: '12px 16px',
            fontSize: 14,
            color: 'var(--t1)',
            border: '1px solid rgba(25,68,69,0.10)',
            borderRadius: 14,
            background: '#fff',
            outline: 'none',
            fontFamily: "'DM Sans',sans-serif",
            boxSizing: 'border-box',
            marginBottom: 16,
          }}
        />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {filters.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                fontSize: 11,
                fontWeight: filter === f.key ? 700 : 500,
                color: filter === f.key ? 'var(--brand)' : 'var(--t3)',
                background: filter === f.key ? 'rgba(25,68,69,0.06)' : 'transparent',
                border: '1px solid',
                borderColor: filter === f.key ? 'rgba(25,68,69,0.12)' : 'rgba(25,68,69,0.06)',
                borderRadius: 20,
                padding: '6px 16px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--t3)' }}>
          <p style={{ fontSize: 14 }}>Loading employers...</p>
        </div>
      )}

      {/* Empty */}
      {!loading && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--t3)' }}>
          <p style={{ fontSize: 14 }}>
            {search || filter !== 'all' ? 'No employers match your filters.' : 'No employers registered yet.'}
          </p>
        </div>
      )}

      {/* Section label */}
      {!loading && filtered.length > 0 && (
        <div style={{ ...labelStyle, marginBottom: 16 }}>
          {filter === 'all' ? 'All Employers' : filter.charAt(0).toUpperCase() + filter.slice(1)} ({filtered.length})
        </div>
      )}

      {/* Employer cards */}
      {filtered.map(emp => {
        const badge = statusBadge(emp.status);
        const pending = isPending(emp.status);
        const empCount = Number(emp.employeeCount) || Number(emp.totalEmployees) || 0;

        return (
          <div key={emp.id} style={{ ...cardStyle, padding: '24px 28px' }}>
            {/* Top row: company + status */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--t1)', marginBottom: 4 }}>
                  {emp.companyName}
                </div>
                {emp.contactName && (
                  <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 2 }}>{emp.contactName}</div>
                )}
                <div style={{ fontSize: 12, color: 'var(--t3)' }}>{emp.email}</div>
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '4px 12px',
                  borderRadius: 20,
                  background: badge.bg,
                  color: badge.text,
                  whiteSpace: 'nowrap',
                  marginLeft: 12,
                }}
              >
                {badge.label}
              </span>
            </div>

            {/* Detail row */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--t3)', marginBottom: pending ? 16 : 0 }}>
              {emp.tier && <span>Tier: <strong style={{ color: 'var(--t2)' }}>{emp.tier}</strong></span>}
              <span>Employees: <strong style={{ color: 'var(--t2)' }}>{fmt(empCount)}</strong></span>
              {emp.companySize && <span>Size: <strong style={{ color: 'var(--t2)' }}>{emp.companySize}</strong></span>}
              {emp.employerCode && <span>Code: <strong style={{ color: 'var(--t2)' }}>{emp.employerCode}</strong></span>}
              <span>Registered: <strong style={{ color: 'var(--t2)' }}>{formatDate(emp.createdAt)}</strong></span>
            </div>

            {/* Actions for pending employers */}
            {pending && (
              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  onClick={() => handleDecision(emp.id, true)}
                  disabled={!!actionLoading}
                  style={pillBtn('var(--brand)', '#fff')}
                >
                  {actionLoading === emp.id ? 'Processing...' : 'Approve'}
                </button>
                <button
                  onClick={() => handleDecision(emp.id, false)}
                  disabled={!!actionLoading}
                  style={pillBtn('rgba(220,80,60,0.08)', 'var(--danger)')}
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
