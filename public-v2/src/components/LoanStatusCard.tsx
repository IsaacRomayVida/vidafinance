import { useTranslation } from 'react-i18next';

import { resolveGroup } from './loanStatusGroups';
import { fmt, fmtShortDate, isQuincenal } from './employee/types';
import type { Loan, ScheduledDeduction } from './employee/types';

/**
 * The active-credit chip on the Home board.
 *
 * Maps issue spec names to Firestore status values:
 *   pending_review  → pending | under_review
 *   approved        → approved
 *   disbursing      → disbursement_queued | disbursed
 *   active          → active
 *   repaid          → paid | repaid | completed
 *   denied          → rejected
 *   escalated       → escalated
 *
 * One frosted chip (`.bo-trip`), whatever the state. The active state is the
 * progress chip from the design reference — `Crédito · 8,000 MXN`, a bar,
 * `Total pagado X de Y`, `N quincenas restantes` — and every state that has a
 * priced credit behind it carries the cost line: total to repay, next
 * deduction, CAT labelled informational. All three are READ from the loan
 * document (`total`, `repaymentSchedule`, `catPercent`, written once by
 * requestLoan); nothing here derives a rate.
 */

interface LoanStatusCardProps {
  loan: Loan;
  totalPaid?: number;
  onRequestAnother?: () => void;
}

/* ── Timeline steps for pending flow ── */

const TIMELINE_STEPS = ['pending', 'under_review', 'approved', 'disbursement_queued', 'active'] as const;

function getActiveIndex(status: string): number {
  const idx = TIMELINE_STEPS.indexOf(status as typeof TIMELINE_STEPS[number]);
  return idx >= 0 ? idx : 0;
}

/**
 * Which scheduled deductions are already covered by what has been paid. A step
 * is done once the cumulative schedule up to it is within the completed
 * repayments; the first step not done is the next one.
 */
function scheduleProgress(schedule: ScheduledDeduction[] | undefined, totalPaid: number) {
  if (!schedule || schedule.length === 0) return null;
  let cumulative = 0;
  let nextIdx = -1;
  const done = schedule.map((s, i) => {
    cumulative += s.amount || 0;
    const isDone = totalPaid >= cumulative - 0.005;
    if (!isDone && nextIdx === -1) nextIdx = i;
    return isDone;
  });
  const remaining = done.filter((d) => !d).length;
  return { next: nextIdx >= 0 ? schedule[nextIdx] : null, remaining };
}

function StatusTimeline({ currentStatus }: { currentStatus: string }) {
  const { t } = useTranslation();
  const activeIdx = getActiveIndex(currentStatus);

  const labels: Record<string, string> = {
    pending: t('ls_step_submitted', 'Solicitud enviada'),
    under_review: t('ls_step_under_review', 'En revisión'),
    approved: t('ls_step_approved', 'Aprobado'),
    disbursement_queued: t('ls_step_disbursing', 'Desembolso en proceso'),
    active: t('ls_step_active', 'Crédito activo'),
  };

  return (
    <div className="bo-tl" aria-label={t('ls_label', 'Estado')}>
      {TIMELINE_STEPS.map((step, i) => {
        const cls = i < activeIdx ? 'done' : i === activeIdx ? 'now' : '';
        return (
          <span key={step} className={cls} aria-current={i === activeIdx ? 'step' : undefined}>
            {labels[step] || step}
          </span>
        );
      })}
    </div>
  );
}

/* ── Cooldown (for denied state, 90-day wait) ── */

function CooldownDisplay({ deniedAt }: { deniedAt?: { seconds: number } }) {
  const { t } = useTranslation();
  if (!deniedAt) return null;

  const cooldownEnd = new Date(deniedAt.seconds * 1000 + 90 * 24 * 60 * 60 * 1000);
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((cooldownEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));

  if (daysLeft === 0) return null;

  return (
    <div className="note">
      {t('ls_cooldown', 'Puedes solicitar de nuevo en {{days}} días', { days: daysLeft })}
    </div>
  );
}

/* ── Main component ── */

export function LoanStatusCard({ loan, totalPaid = 0, onRequestAnother }: LoanStatusCardProps) {
  const { t, i18n } = useTranslation();
  const group = resolveGroup(loan.status);

  const totalOwed = loan.repaymentAmount || loan.total || 0;
  const repayPercent = totalOwed > 0 ? Math.min(100, (totalPaid / totalOwed) * 100) : 0;
  const progress = scheduleProgress(loan.repaymentSchedule, totalPaid);
  const nextDeduction = progress?.next ?? loan.repaymentSchedule?.[0] ?? null;
  const nextDate = fmtShortDate(nextDeduction?.dueDate ?? loan.dueDate, i18n.language);
  const cat = typeof loan.catPercent === 'number' ? loan.catPercent : null;
  const quincenal = isQuincenal(loan);

  /** `Total adeudado 1,300 · Próximo descuento 1,300 el 15 sep · CAT 2334% informativo` */
  const costLine = (
    <div className="cost">
      {t('pay_total_owed')} {totalOwed > 0 ? fmt(totalOwed) : t('cost_pending')}
      {' · '}
      {nextDeduction && nextDate
        ? t('ls_next_deduction_value', { amount: fmt(nextDeduction.amount), date: nextDate })
        : `${t('ls_next_deduction')} ${t('cost_pending')}`}
      {' · '}
      {cat === null ? t('cost_cat_pending') : t('cost_cat', { cat: String(cat) })}
    </div>
  );

  const label = <div className="dot">{t('ls_label', 'Estado')}</div>;
  const amountRow = (
    <div className="kv">
      <div>
        {t('dash_th_amount', 'Monto')}
        <b>{fmt(loan.amount)} MXN</b>
      </div>
      {totalOwed > 0 && (
        <div>
          {t('modal_total', 'Total a pagar')}
          <b>{fmt(totalOwed)} MXN</b>
        </div>
      )}
    </div>
  );

  /* ── pending_review ── */
  if (group === 'pending_review') {
    return (
      <div className="bo-trip loan-status-card">
        {label}
        <div className="title">{t('ls_pending_title', 'Solicitud en revisión')}</div>
        <StatusTimeline currentStatus={loan.status} />
        <div className="desc">{t('ls_pending_desc', 'Tu solicitud ha sido recibida. Te notificaremos cuando haya una decisión.')}</div>
        {amountRow}
        {costLine}
      </div>
    );
  }

  /* ── approved ── */
  if (group === 'approved') {
    return (
      <div className="bo-trip loan-status-card">
        {label}
        <div className="title">{t('ls_approved_title', 'Contrato listo para firmar')}</div>
        <StatusTimeline currentStatus={loan.status} />
        <div className="desc">{t('ls_approved_desc', 'Tu crédito fue aprobado. Firma tu contrato para recibir los fondos.')}</div>
        {loan.contractUrl ? (
          <a href={loan.contractUrl as string} target="_blank" rel="noopener noreferrer" className="link">
            {t('ls_sign_contract', 'Firmar contrato')}
          </a>
        ) : null}
        {amountRow}
        {costLine}
      </div>
    );
  }

  /* ── disbursing ── */
  if (group === 'disbursing') {
    return (
      <div className="bo-trip loan-status-card">
        {label}
        <div className="title">{t('ls_disbursing_title', 'Fondos en camino')}</div>
        <StatusTimeline currentStatus={loan.status} />
        <div className="desc">{t('ls_disbursing_desc', 'Tu transferencia SPEI está en proceso. Los fondos llegarán a tu cuenta en minutos.')}</div>
        {loan.speiTrackingId ? (
          <div className="note">
            {t('ls_spei_tracking', 'Rastreo SPEI')}: <b>{loan.speiTrackingId as string}</b>
          </div>
        ) : null}
        {amountRow}
        {costLine}
      </div>
    );
  }

  /* ── active ── */
  if (group === 'active') {
    const remainingLabel =
      progress === null
        ? null
        : t(quincenal ? 'ls_remaining_quincenas' : 'ls_remaining_deductions', { count: progress.remaining });
    return (
      <div className="bo-trip loan-status-card">
        <div className="t">
          <b>{t('ls_credit_label', 'Crédito')} · {fmt(loan.amount)} MXN</b>
          <span>
            {loan.status === 'overdue' ? `${t('status_overdue', 'Vencido')} · ` : ''}
            {Math.round(repayPercent)}%
          </span>
        </div>
        <div className="bo-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(repayPercent)}>
          <i style={{ width: `${repayPercent}%` }} />
        </div>
        <div className="m">
          <span>{t('ls_progress_paid', { paid: fmt(totalPaid), total: fmt(totalOwed) })}</span>
          {remainingLabel && <span>{remainingLabel}</span>}
        </div>
        {costLine}
      </div>
    );
  }

  /* ── repaid ── */
  if (group === 'repaid') {
    return (
      <div className="bo-trip loan-status-card">
        {label}
        <div className="title">{t('ls_repaid_title', 'Crédito liquidado')}</div>
        <div className="desc">{t('ls_repaid_desc', 'Liquidaste tu crédito de {{amount}} MXN.', { amount: fmt(loan.amount) })}</div>
        {onRequestAnother && (
          <button type="button" onClick={onRequestAnother} className="link">
            {t('ls_request_another', 'Solicitar otro crédito')}
          </button>
        )}
      </div>
    );
  }

  /* ── denied ── */
  if (group === 'denied') {
    return (
      <div className="bo-trip loan-status-card">
        {label}
        <div className="title">{t('ls_denied_title', 'Solicitud rechazada')}</div>
        {loan.denialReason ? (
          <div className="desc">
            {t('ls_denial_reason', 'Motivo')}: {loan.denialReason as string}
          </div>
        ) : null}
        <CooldownDisplay deniedAt={loan.deniedAt as { seconds: number } | undefined} />
      </div>
    );
  }

  /* ── escalated ── */
  if (group === 'escalated') {
    return (
      <div className="bo-trip loan-status-card">
        {label}
        <div className="title">{t('ls_escalated_title', 'Revisión adicional')}</div>
        <div className="desc">{t('ls_escalated_desc', 'Estamos revisando detalles adicionales de tu solicitud. No necesitas hacer nada. Te avisaremos cuando haya una actualización.')}</div>
      </div>
    );
  }

  /* ── other (interim: status line only, no narrative claim) ── */
  if (group === 'other') {
    return (
      <div className="bo-trip loan-status-card">
        {label}
        <div className="title">{t(`status_${loan.status}`, loan.status)}</div>
      </div>
    );
  }

  return null;
}
