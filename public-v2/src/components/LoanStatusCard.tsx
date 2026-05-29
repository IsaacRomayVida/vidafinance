import { useTranslation } from 'react-i18next';

/**
 * Loan status values used by the status card.
 * Maps issue spec names to Firestore status values:
 *   pending_review  → pending | under_review
 *   approved        → approved
 *   disbursing      → disbursement_queued | disbursed
 *   active          → active
 *   repaid          → paid | repaid | completed
 *   denied          → rejected
 *   escalated       → escalated
 */

type LoanStatus = string;

interface LoanStatusLoan {
  id: string;
  amount: number;
  status: LoanStatus;
  repaymentAmount?: number;
  total?: number;
  termDays?: number;
  createdAt?: { seconds: number };
  dueDate?: { seconds: number };
  contractUrl?: string;
  speiTrackingId?: string;
  denialReason?: string;
  deniedAt?: { seconds: number };
  disbursedAt?: { seconds: number };
  [key: string]: unknown;
}

interface LoanStatusCardProps {
  loan: LoanStatusLoan;
  totalPaid?: number;
  onRequestAnother?: () => void;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/* ── Status helpers ── */

type StatusGroup = 'pending_review' | 'approved' | 'disbursing' | 'active' | 'repaid' | 'denied' | 'escalated';

function resolveGroup(status: string): StatusGroup {
  switch (status) {
    case 'pending':
    case 'under_review':
      return 'pending_review';
    case 'approved':
      return 'approved';
    case 'disbursement_queued':
    case 'disbursed':
      return 'disbursing';
    case 'active':
    case 'overdue':
      return 'active';
    case 'paid':
    case 'repaid':
    case 'completed':
      return 'repaid';
    case 'rejected':
      return 'denied';
    case 'escalated':
      return 'escalated';
    default:
      return 'pending_review';
  }
}

const GROUP_COLORS: Record<StatusGroup, { bg: string; accent: string; text: string }> = {
  pending_review: { bg: '#fdf7e8', accent: '#d4a017', text: '#7a5a10' },
  approved:       { bg: '#e8f0fd', accent: '#3b6cd4', text: '#1a3a8b' },
  disbursing:     { bg: '#e8f0fd', accent: '#3b6cd4', text: '#1a3a8b' },
  active:         { bg: '#e8f6f6', accent: '#194445', text: '#194445' },
  repaid:         { bg: '#edf7f0', accent: '#247a6e', text: '#1a5e3a' },
  denied:         { bg: '#fdf0f0', accent: '#dc503c', text: '#8b2020' },
  escalated:      { bg: '#fdf7e8', accent: '#d4a017', text: '#7a5a10' },
};

/* ── Timeline steps for pending flow ── */

const TIMELINE_STEPS = ['pending', 'under_review', 'approved', 'disbursement_queued', 'active'] as const;

function getActiveIndex(status: string): number {
  const idx = TIMELINE_STEPS.indexOf(status as typeof TIMELINE_STEPS[number]);
  return idx >= 0 ? idx : 0;
}

/* ── Icons (inline SVG) ── */

function ClockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/>
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
    </svg>
  );
}

function CelebrationIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>
    </svg>
  );
}

function XCircleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/>
    </svg>
  );
}

/* ── Progress Ring ── */

function ProgressRing({ percent, size = 120 }: { percent: number; size?: number }) {
  const r = (size - 16) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.min(percent, 100) / 100);

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke="rgba(25,68,69,0.04)" strokeWidth="10"
        />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke="url(#loanProgressGrad)" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(0.16,1,0.3,1)' }}
        />
        <defs>
          <linearGradient id="loanProgressGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#194445" />
            <stop offset="100%" stopColor="#a8d5d0" />
          </linearGradient>
        </defs>
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ fontFamily: 'var(--df)', fontSize: size * 0.28, color: '#0c1e1f', lineHeight: 1 }}>
          {Math.round(percent)}%
        </div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginTop: 4 }}>
          pagado
        </div>
      </div>
    </div>
  );
}

/* ── Timeline (vertical) ── */

function StatusTimeline({ currentStatus }: { currentStatus: string }) {
  const { t } = useTranslation();
  const activeIdx = getActiveIndex(currentStatus);

  const labels: Record<string, string> = {
    pending: t('ls_step_submitted', 'Solicitud enviada'),
    under_review: t('ls_step_under_review', 'En revisión'),
    approved: t('ls_step_approved', 'Aprobado'),
    disbursement_queued: t('ls_step_disbursing', 'Desembolso en proceso'),
    active: t('ls_step_active', 'Préstamo activo'),
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {TIMELINE_STEPS.map((step, i) => {
        const isDone = i < activeIdx;
        const isCurrent = i === activeIdx;
        const isFuture = i > activeIdx;

        return (
          <div key={step} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {/* Dot + line column */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 20, flexShrink: 0 }}>
              <div style={{
                width: isCurrent ? 14 : 10,
                height: isCurrent ? 14 : 10,
                borderRadius: '50%',
                background: isDone ? 'var(--brand)' : isCurrent ? 'var(--brand)' : 'rgba(25,68,69,0.08)',
                border: isCurrent ? '3px solid var(--aqua)' : 'none',
                transition: 'all 0.3s',
                flexShrink: 0,
              }} />
              {i < TIMELINE_STEPS.length - 1 && (
                <div style={{
                  width: 2,
                  height: 24,
                  background: isDone ? 'var(--brand)' : 'rgba(25,68,69,0.08)',
                  transition: 'background 0.3s',
                }} />
              )}
            </div>
            {/* Label */}
            <div style={{
              fontSize: 13,
              fontWeight: isCurrent ? 700 : isDone ? 600 : 400,
              color: isFuture ? 'var(--t3)' : 'var(--t1)',
              paddingBottom: i < TIMELINE_STEPS.length - 1 ? 14 : 0,
              lineHeight: 1.2,
            }}>
              {labels[step] || step}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Cooldown timer (for denied state, 90-day wait) ── */

function CooldownDisplay({ deniedAt }: { deniedAt?: { seconds: number } }) {
  const { t } = useTranslation();
  if (!deniedAt) return null;

  const cooldownEnd = new Date(deniedAt.seconds * 1000 + 90 * 24 * 60 * 60 * 1000);
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((cooldownEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));

  if (daysLeft === 0) return null;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '10px 14px', borderRadius: 10,
      background: 'rgba(25,68,69,0.03)',
      marginTop: 12,
    }}>
      <ClockIcon />
      <span style={{ fontSize: 13, color: 'var(--t2)' }}>
        {t('ls_cooldown', 'Puedes solicitar de nuevo en {{days}} días', { days: daysLeft })}
      </span>
    </div>
  );
}

/* ── Main component ── */

export function LoanStatusCard({ loan, totalPaid = 0, onRequestAnother }: LoanStatusCardProps) {
  const { t } = useTranslation();
  const group = resolveGroup(loan.status);
  const colors = GROUP_COLORS[group];

  const totalOwed = loan.repaymentAmount || loan.total || 0;
  const repayPercent = totalOwed > 0 ? (totalPaid / totalOwed) * 100 : 0;
  const remaining = Math.max(0, totalOwed - totalPaid);

  const cardStyle: React.CSSProperties = {
    background: '#fff',
    borderRadius: 20,
    padding: '28px 24px',
    border: '1px solid rgba(25,68,69,0.04)',
    boxShadow: '0 2px 8px rgba(25,68,69,0.02)',
    marginBottom: 24,
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 20,
  };

  const iconWrapStyle: React.CSSProperties = {
    width: 36,
    height: 36,
    borderRadius: 10,
    background: colors.bg,
    color: colors.accent,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: 'var(--gold)',
    marginBottom: 4,
  };

  /* ── pending_review ── */
  if (group === 'pending_review') {
    return (
      <div style={cardStyle} className="loan-status-card">
        <div style={headerStyle}>
          <div style={iconWrapStyle}><ClockIcon /></div>
          <div>
            <div style={labelStyle}>{t('ls_label', 'Estado del préstamo')}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
              {t('ls_pending_title', 'Solicitud en revisión')}
            </div>
          </div>
        </div>
        <StatusTimeline currentStatus={loan.status} />
        <div style={{
          marginTop: 16, padding: '12px 14px', borderRadius: 10,
          background: 'rgba(25,68,69,0.02)', fontSize: 13, color: 'var(--t2)', lineHeight: 1.5,
        }}>
          {t('ls_pending_desc', 'Tu solicitud ha sido recibida. Te notificaremos cuando haya una decisión.')}
        </div>
      </div>
    );
  }

  /* ── approved ── */
  if (group === 'approved') {
    return (
      <div style={cardStyle} className="loan-status-card">
        <div style={headerStyle}>
          <div style={iconWrapStyle}><FileIcon /></div>
          <div>
            <div style={labelStyle}>{t('ls_label', 'Estado del préstamo')}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
              {t('ls_approved_title', 'Contrato listo para firmar')}
            </div>
          </div>
        </div>
        <StatusTimeline currentStatus={loan.status} />
        <div style={{
          marginTop: 16, padding: '16px', borderRadius: 12,
          background: colors.bg, border: `1px solid ${colors.accent}20`,
        }}>
          <div style={{ fontSize: 13, color: colors.text, marginBottom: 12, lineHeight: 1.5 }}>
            {t('ls_approved_desc', 'Tu préstamo ha sido aprobado. Firma tu contrato para recibir los fondos.')}
          </div>
          {loan.contractUrl && (
            <a
              href={loan.contractUrl as string}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '12px 24px', borderRadius: 10, border: 'none',
                background: 'var(--brand)', color: '#fff',
                fontSize: 14, fontWeight: 700, fontFamily: "'DM Sans', sans-serif",
                textDecoration: 'none',
                boxShadow: '0 4px 16px rgba(25,68,69,0.15)',
                transition: 'all 0.3s',
              }}
            >
              <FileIcon />
              {t('ls_sign_contract', 'Firmar contrato')}
            </a>
          )}
        </div>
        {/* Loan summary */}
        <div style={{ marginTop: 16, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 4 }}>
              {t('dash_th_amount', 'Monto')}
            </div>
            <div style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>
              ${fmt(loan.amount)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 4 }}>
              {t('modal_total', 'Total a pagar')}
            </div>
            <div style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>
              ${fmt(totalOwed)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── disbursing ── */
  if (group === 'disbursing') {
    return (
      <div style={cardStyle} className="loan-status-card">
        <div style={headerStyle}>
          <div style={iconWrapStyle}><SendIcon /></div>
          <div>
            <div style={labelStyle}>{t('ls_label', 'Estado del préstamo')}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
              {t('ls_disbursing_title', 'Fondos en camino')}
            </div>
          </div>
        </div>
        <StatusTimeline currentStatus={loan.status} />
        <div style={{
          marginTop: 16, padding: '16px', borderRadius: 12,
          background: colors.bg, border: `1px solid ${colors.accent}20`,
        }}>
          <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5 }}>
            {t('ls_disbursing_desc', 'Tu transferencia SPEI está siendo procesada. Los fondos llegarán a tu cuenta en minutos.')}
          </div>
          {loan.speiTrackingId && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--t3)' }}>
              {t('ls_spei_tracking', 'Rastreo SPEI')}: <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--t1)' }}>{loan.speiTrackingId as string}</span>
            </div>
          )}
        </div>
        <div style={{ marginTop: 16, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 4 }}>
              {t('dash_th_amount', 'Monto')}
            </div>
            <div style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)' }}>
              ${fmt(loan.amount)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── active ── */
  if (group === 'active') {
    return (
      <div style={cardStyle} className="loan-status-card">
        <div style={headerStyle}>
          <div style={iconWrapStyle}><CheckCircleIcon /></div>
          <div>
            <div style={labelStyle}>{t('ls_label', 'Estado del préstamo')}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
              {t('ls_active_title', 'Préstamo activo')}
            </div>
          </div>
          {loan.status === 'overdue' && (
            <span className="badge badge-overdue" style={{ marginLeft: 'auto' }}>
              {t('status_overdue', 'Vencido')}
            </span>
          )}
        </div>

        <div className="loan-status-active-grid" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 24, alignItems: 'center' }}>
          {/* Progress ring */}
          <ProgressRing percent={repayPercent} size={120} />

          {/* Stats */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 4 }}>
                {t('pay_remaining', 'Saldo restante')}
              </div>
              <div style={{ fontFamily: 'var(--df)', fontSize: 24, color: 'var(--t1)' }}>
                ${fmt(remaining)} <span style={{ fontSize: 12, color: '#93aaa9', fontFamily: "'DM Sans'" }}>MXN</span>
              </div>
            </div>
            {loan.dueDate && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 4 }}>
                  {t('ls_next_deduction', 'Próxima deducción')}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: loan.status === 'overdue' ? 'var(--danger)' : 'var(--t1)' }}>
                  {new Date(loan.dueDate.seconds * 1000).toLocaleDateString()}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 20 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 2 }}>
                  {t('pay_total_paid', 'Total pagado')}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--success)' }}>
                  ${fmt(totalPaid)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 2 }}>
                  {t('pay_total_owed', 'Total adeudado')}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>
                  ${fmt(totalOwed)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── repaid ── */
  if (group === 'repaid') {
    return (
      <div style={cardStyle} className="loan-status-card">
        <div style={headerStyle}>
          <div style={iconWrapStyle}><CelebrationIcon /></div>
          <div>
            <div style={labelStyle}>{t('ls_label', 'Estado del préstamo')}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
              {t('ls_repaid_title', 'Préstamo liquidado')}
            </div>
          </div>
        </div>

        <div style={{
          textAlign: 'center', padding: '24px 16px', borderRadius: 12,
          background: 'linear-gradient(135deg, #edf7f0 0%, #e8f6f6 100%)',
        }}>
          <div style={{ fontFamily: 'var(--df)', fontSize: 24, color: 'var(--success)', marginBottom: 8 }}>
            {t('ls_repaid_congrats', '!Felicidades!')}
          </div>
          <div style={{ fontSize: 14, color: 'var(--t2)', lineHeight: 1.5, marginBottom: 20 }}>
            {t('ls_repaid_desc', 'Has liquidado tu préstamo de ${{amount}} MXN exitosamente.', { amount: fmt(loan.amount) })}
          </div>
          {onRequestAnother && (
            <button
              onClick={onRequestAnother}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '14px 28px', borderRadius: 12, border: 'none',
                background: 'linear-gradient(135deg, #194445 0%, #1d5253 100%)',
                color: '#fff', fontSize: 14, fontWeight: 700,
                fontFamily: "'DM Sans', sans-serif",
                cursor: 'pointer',
                boxShadow: '0 4px 16px rgba(25,68,69,0.15)',
                transition: 'all 0.3s',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
              </svg>
              {t('ls_request_another', 'Solicitar otro préstamo')}
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ── denied ── */
  if (group === 'denied') {
    return (
      <div style={cardStyle} className="loan-status-card">
        <div style={headerStyle}>
          <div style={iconWrapStyle}><XCircleIcon /></div>
          <div>
            <div style={labelStyle}>{t('ls_label', 'Estado del préstamo')}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
              {t('ls_denied_title', 'Solicitud rechazada')}
            </div>
          </div>
        </div>

        {loan.denialReason && (
          <div style={{
            padding: '14px 16px', borderRadius: 10,
            background: colors.bg, border: `1px solid ${colors.accent}20`,
            marginBottom: 12,
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#93aaa9', marginBottom: 6 }}>
              {t('ls_denial_reason', 'Motivo')}
            </div>
            <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5 }}>
              {loan.denialReason as string}
            </div>
          </div>
        )}

        <CooldownDisplay deniedAt={loan.deniedAt} />
      </div>
    );
  }

  /* ── escalated ── */
  if (group === 'escalated') {
    return (
      <div style={cardStyle} className="loan-status-card">
        <div style={headerStyle}>
          <div style={iconWrapStyle}><AlertIcon /></div>
          <div>
            <div style={labelStyle}>{t('ls_label', 'Estado del préstamo')}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
              {t('ls_escalated_title', 'Revisión adicional')}
            </div>
          </div>
        </div>

        <div style={{
          padding: '16px', borderRadius: 12,
          background: colors.bg, border: `1px solid ${colors.accent}20`,
        }}>
          <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.5 }}>
            {t('ls_escalated_desc', 'Estamos revisando detalles adicionales de tu solicitud. No se requiere ninguna acción de tu parte. Te notificaremos cuando haya una actualización.')}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
