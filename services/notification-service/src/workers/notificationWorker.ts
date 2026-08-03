import { Worker, Job } from 'bullmq';
import pino from 'pino';
import { TwilioService } from '../services/twilioService';
import { SendGridService } from '../services/sendgridService';
import { FirestoreService } from '../services/firestoreService';

const log = pino({ name: 'vida-notification-service', level: process.env.LOG_LEVEL || 'info', formatters: { level: (label) => ({ level: label }) } });

const twilio = new TwilioService();
const sendgrid = new SendGridService();
const firestore = new FirestoreService();

// All fields are optional — job data shape varies between new producers (userId)
// and legacy producers (employeeId + inline phone/email).
export interface NotificationJobData {
  type: string;
  // New-format identifier (VID-8/VID-9 onwards)
  userId?: string;
  // Legacy identifier (existing Cloud Functions / payment-server)
  employeeId?: string;
  employerUid?: string;
  // Common loan fields
  loanId?: string;
  amount?: number;
  dueDate?: string;
  disbursementRef?: string;
  // Employer fields
  employerId?: string;
  employerCode?: string;
  adminContactEmail?: string;
  companyName?: string;
  // Inline contact (legacy producers embed phone/email in job payload)
  phone?: string;
  email?: string;
  name?: string;
  employeeName?: string;
  // Extra fields
  rejectionReason?: string;
  score?: number;
  daysOverdue?: number;
  timestamp?: number;
}

const fmt = (n: number) =>
  Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2 });

/**
 * Resolve the phone number for a user-related job.
 * Uses inline phone from job data when available (faster, no Firestore read),
 * otherwise fetches from Firestore via userId or employeeId.
 */
async function resolvePhone(data: NotificationJobData): Promise<string> {
  if (data.phone) return data.phone;
  const uid = data.userId ?? data.employeeId;
  if (!uid) throw new Error(`No userId/employeeId in job data: ${JSON.stringify(data)}`);
  // ['phone'] is all an SMS/WhatsApp job needs -- a missing email on an
  // otherwise-reachable borrower must not suppress their notification.
  const user = await firestore.getUser(uid, ['phone']);
  return user.phone!;
}

/**
 * Format a due date string or Firestore Timestamp-like value into a human-readable Spanish date.
 */
function formatDueDate(dueDate?: string | unknown): string {
  if (!dueDate) return 'tu próxima quincena';
  try {
    const d = typeof dueDate === 'string'
      ? new Date(dueDate)
      : new Date((dueDate as { _seconds: number })._seconds * 1000);
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
  } catch {
    return String(dueDate);
  }
}

// ── Queue name must match all producers ─────────────────────────────────────
const QUEUE_NAME = 'vida-notifications';

// Pass connection as a plain URL config to avoid IORedis version conflicts
// between the standalone ioredis package and BullMQ's bundled ioredis.
const redisUrl = process.env.REDIS_URL ?? '';
const bullConnection = {
  url: redisUrl,
  ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
};

export const notificationWorker = new Worker<NotificationJobData>(
  QUEUE_NAME,
  async (job: Job<NotificationJobData>) => {
    const data = job.data;
    log.info({ jobId: job.id, type: data.type, loanId: data.loanId, correlationId: (data as unknown as Record<string, unknown>).correlationId, service: 'notification-service' }, 'Processing notification job');

    switch (data.type) {

      // ── Loan: requested ────────────────────────────────────────────────────
      case 'loan_requested': {
        const phone = await resolvePhone(data);
        await twilio.sendWhatsApp(
          phone,
          `✅ *VIDA Finance*\n\nHemos recibido tu solicitud de préstamo por *$${fmt(data.amount!)} MXN*.\n\nTe notificaremos la decisión en los próximos minutos.`,
        );
        break;
      }

      // ── Loan: approved ─────────────────────────────────────────────────────
      case 'loan_approved': {
        const phone = await resolvePhone(data);
        await twilio.sendWhatsApp(
          phone,
          `🎉 *VIDA Finance*\n\n¡Felicidades! Tu préstamo por *$${fmt(data.amount!)} MXN* fue *APROBADO*.\n\nEn breve recibirás el depósito en tu cuenta bancaria.`,
        );
        break;
      }

      // ── Loan: rejected ─────────────────────────────────────────────────────
      case 'loan_rejected': {
        const phone = await resolvePhone(data);
        const reasonLine = data.rejectionReason
          ? `*Motivo:* ${data.rejectionReason}\n\n`
          : '';
        await twilio.sendWhatsApp(
          phone,
          `ℹ️ *VIDA Finance*\n\nLamentamos informarte que tu solicitud de préstamo no fue aprobada en este momento.\n\n${reasonLine}Puedes volver a solicitar después de cumplir con los requisitos.`,
        );
        break;
      }

      // ── Loan: disbursed ────────────────────────────────────────────────────
      case 'loan_disbursed': {
        const phone = await resolvePhone(data);
        // Try dueDate from job; if missing, fetch from Firestore loan doc
        let dueDateValue: string | unknown = data.dueDate;
        if (!dueDateValue && data.loanId) {
          try {
            const loan = await firestore.getLoan(data.loanId);
            dueDateValue = loan['dueDate'] as string;
          } catch {
            // non-critical
          }
        }
        const dueDateStr = formatDueDate(dueDateValue);
        await Promise.all([
          twilio.sendWhatsApp(
            phone,
            `💰 *VIDA Finance*\n\n¡Tu préstamo de *$${fmt(data.amount!)} MXN* fue depositado!\n\n*Fecha de pago:* ${dueDateStr}\nEl pago se descontará automáticamente de tu nómina.\n\n_Conserva este mensaje como comprobante._`,
          ),
          twilio.sendSMS(
            phone,
            `VIDA: Tu prestamo de $${data.amount} MXN fue depositado. Fecha de pago: ${dueDateStr}. El descuento es automatico de tu nomina.`,
          ),
        ]);
        break;
      }

      // ── Loan: repaid (new) / loan_paid / loan_paid_payroll (legacy) ────────
      case 'loan_repaid':
      case 'loan_paid':
      case 'loan_paid_payroll': {
        const phone = await resolvePhone(data);
        await twilio.sendWhatsApp(
          phone,
          `✅ *VIDA Finance*\n\nTu préstamo ha sido *liquidado* exitosamente. ¡Gracias por tu puntualidad!\n\nYa puedes solicitar un nuevo préstamo cuando lo necesites.`,
        );
        break;
      }

      // ── Employer: approved (new) / employer_activated (legacy) ────────────
      case 'employer_approved':
      case 'employer_activated': {
        // New-format jobs have adminContactEmail; legacy have email + employerUid
        const to = data.adminContactEmail ?? data.email;
        if (!to) {
          log.warn({ jobId: job.id, type: data.type, service: 'notification-service' }, 'Missing recipient email — skipping');
          break;
        }
        await sendgrid.sendEmail({
          to,
          subject: `¡Bienvenido a VIDA Finance! Tu empresa ${data.companyName} está activa`,
          templateId: 'd-employer-approved',
          dynamicData: {
            companyName: data.companyName,
            employerCode: data.employerCode,
            dashboardUrl: `${process.env.EMPLOYER_DASHBOARD_URL ?? 'https://employer.vida.finance'}/onboarding`,
            name: data.name,
          },
        });
        break;
      }

      // ── Employer: rejected ─────────────────────────────────────────────────
      case 'employer_rejected': {
        const to = data.adminContactEmail ?? data.email;
        if (!to) {
          log.warn({ jobId: job.id, type: data.type, service: 'notification-service' }, 'employer_rejected missing recipient email — skipping');
          break;
        }
        await sendgrid.sendEmail({
          to,
          subject: `Actualización de tu solicitud — VIDA Finance`,
          templateId: 'd-employer-rejected',
          dynamicData: {
            companyName: data.companyName,
            rejectionReason: data.rejectionReason,
            supportEmail: 'soporte@vida.finance',
          },
        });
        break;
      }

      // ── Loan: overdue reminder (new) / loan_overdue (legacy) ──────────────
      case 'loan_overdue_reminder':
      case 'loan_overdue': {
        const phone = await resolvePhone(data);
        await twilio.sendSMS(
          phone,
          `VIDA: Tu prestamo tiene un pago pendiente. Contactanos: soporte@vida.finance o 800-VIDA-MX`,
        );
        break;
      }

      // ── Legacy: 24h reminder ───────────────────────────────────────────────
      case 'loan_reminder_24h': {
        const phone = await resolvePhone(data);
        await twilio.sendWhatsApp(
          phone,
          `🔔 *VIDA Finance*\n\nMañana vence tu pago de *$${fmt(data.amount!)} MXN*. Si tu empresa ya hizo el descuento, no tienes que hacer nada.\n\nvida-finance.web.app`,
        );
        break;
      }

      default:
        log.warn({ jobId: job.id, type: data.type, service: 'notification-service' }, 'Unknown job type');
    }
  },
  {
    connection: bullConnection,
    concurrency: 20,
  },
);

notificationWorker.on('completed', (job) => {
  log.info({ jobId: job.id, type: job.data.type, loanId: job.data.loanId, service: 'notification-service' }, 'Notification job completed');
});

notificationWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, type: job?.data.type, loanId: job?.data.loanId, error: err.message, service: 'notification-service' }, 'Notification job failed');
});
