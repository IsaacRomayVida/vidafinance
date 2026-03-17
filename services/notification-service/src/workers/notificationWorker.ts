import { Worker, Job } from 'bullmq';
import { TwilioService, SendResult } from '../services/twilioService';
import { SendGridService } from '../services/sendgridService';
import { FirestoreService } from '../services/firestoreService';

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
  const user = await firestore.getUser(uid);
  return user.phone;
}

/**
 * Format a due date string or Firestore Timestamp-like value into a human-readable Spanish date.
 */
function formatDueDate(dueDate?: string | unknown): string {
  if (!dueDate) return 'tu proxima quincena';
  try {
    const d = typeof dueDate === 'string'
      ? new Date(dueDate)
      : new Date((dueDate as { _seconds: number })._seconds * 1000);
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
  } catch {
    return String(dueDate);
  }
}

/**
 * Log a sent notification to Firestore.
 */
async function logSend(
  channel: string,
  to: string,
  type: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await firestore.logNotification({ channel, to, type, ...extra });
  } catch (err) {
    console.error(`[notification] Failed to log notification:`, (err as Error).message);
  }
}

/**
 * Helper: send WhatsApp with SMS fallback, then log.
 */
async function sendAndLog(
  phone: string,
  waBody: string,
  type: string,
  refId?: string,
  smsBody?: string,
): Promise<SendResult> {
  const result = await twilio.sendWithFallback(phone, waBody, smsBody);
  await logSend(result.channel, phone, type, {
    sid: result.sid,
    status: result.status,
    fallback: result.fallback,
    refId,
  });
  return result;
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
    console.log(`[notification] Processing ${data.type} job ${job.id}`);

    switch (data.type) {

      // ── Loan: requested ────────────────────────────────────────────────────
      case 'loan_requested': {
        const phone = await resolvePhone(data);
        await sendAndLog(
          phone,
          `✅ *VIDA Finance*\n\nHemos recibido tu solicitud de prestamo por *$${fmt(data.amount!)} MXN*.\n\nTe notificaremos la decision en los proximos minutos.`,
          data.type,
          data.loanId,
          `VIDA: Recibimos tu solicitud de prestamo por $${fmt(data.amount!)} MXN. Te notificaremos pronto.`,
        );
        break;
      }

      // ── Loan: approved ─────────────────────────────────────────────────────
      case 'loan_approved': {
        const phone = await resolvePhone(data);
        await sendAndLog(
          phone,
          `🎉 *VIDA Finance*\n\n¡Felicidades! Tu prestamo por *$${fmt(data.amount!)} MXN* fue *APROBADO*.\n\nEn breve recibiras el deposito en tu cuenta bancaria.`,
          data.type,
          data.loanId,
          `VIDA: Tu prestamo por $${fmt(data.amount!)} MXN fue APROBADO. Recibiras el deposito pronto.`,
        );
        break;
      }

      // ── Loan: rejected ─────────────────────────────────────────────────────
      case 'loan_rejected': {
        const phone = await resolvePhone(data);
        const reasonLine = data.rejectionReason
          ? `*Motivo:* ${data.rejectionReason}\n\n`
          : '';
        await sendAndLog(
          phone,
          `ℹ️ *VIDA Finance*\n\nLamentamos informarte que tu solicitud de prestamo no fue aprobada en este momento.\n\n${reasonLine}Puedes volver a solicitar despues de cumplir con los requisitos.`,
          data.type,
          data.loanId,
          `VIDA: Tu solicitud de prestamo no fue aprobada. Puedes volver a solicitar cuando cumplas los requisitos.`,
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
        const smsBody = `VIDA: Tu prestamo de $${fmt(data.amount!)} MXN fue depositado. Fecha de pago: ${dueDateStr}. El descuento es automatico de tu nomina.`;

        // Send WhatsApp with fallback + dedicated SMS confirmation
        const waResult = await twilio.sendWithFallback(
          phone,
          `💰 *VIDA Finance*\n\n¡Tu prestamo de *$${fmt(data.amount!)} MXN* fue depositado!\n\n*Fecha de pago:* ${dueDateStr}\nEl pago se descontara automaticamente de tu nomina.\n\n_Conserva este mensaje como comprobante._`,
          smsBody,
        );
        await logSend(waResult.channel, phone, data.type, {
          sid: waResult.sid,
          status: waResult.status,
          fallback: waResult.fallback,
          refId: data.loanId,
        });

        // Always send SMS for disbursement as a second confirmation (unless WA already fell back to SMS)
        if (!waResult.fallback) {
          try {
            const smsMsg = await twilio.sendSMS(phone, smsBody);
            await logSend('sms', phone, data.type, { sid: smsMsg.sid, refId: data.loanId });
          } catch (err) {
            console.warn(`[notification] SMS confirmation for disbursement failed:`, (err as Error).message);
          }
        }
        break;
      }

      // ── Loan: repaid (new) / loan_paid / loan_paid_payroll (legacy) ────────
      case 'loan_repaid':
      case 'loan_paid':
      case 'loan_paid_payroll': {
        const phone = await resolvePhone(data);
        await sendAndLog(
          phone,
          `✅ *VIDA Finance*\n\nTu prestamo ha sido *liquidado* exitosamente. ¡Gracias por tu puntualidad!\n\nYa puedes solicitar un nuevo prestamo cuando lo necesites.`,
          data.type,
          data.loanId,
          `VIDA: Tu prestamo ha sido liquidado. Gracias por tu puntualidad. Puedes solicitar un nuevo prestamo.`,
        );
        break;
      }

      // ── Employer: approved (new) / employer_activated (legacy) ────────────
      case 'employer_approved':
      case 'employer_activated': {
        // New-format jobs have adminContactEmail; legacy have email + employerUid
        const to = data.adminContactEmail ?? data.email;
        if (!to) {
          console.warn(`[notification] ${data.type} job ${job.id} missing recipient email — skipping`);
          break;
        }
        await sendgrid.sendEmail({
          to,
          subject: `¡Bienvenido a VIDA Finance! Tu empresa ${data.companyName} esta activa`,
          templateId: 'd-employer-approved',
          dynamicData: {
            companyName: data.companyName,
            employerCode: data.employerCode,
            dashboardUrl: `${process.env.EMPLOYER_DASHBOARD_URL ?? 'https://employer.vida.finance'}/onboarding`,
            name: data.name,
          },
        });
        await logSend('email', to, data.type, { companyName: data.companyName });
        break;
      }

      // ── Employer: rejected ─────────────────────────────────────────────────
      case 'employer_rejected': {
        const to = data.adminContactEmail ?? data.email;
        if (!to) {
          console.warn(`[notification] employer_rejected job ${job.id} missing recipient email — skipping`);
          break;
        }
        await sendgrid.sendEmail({
          to,
          subject: `Actualizacion de tu solicitud — VIDA Finance`,
          templateId: 'd-employer-rejected',
          dynamicData: {
            companyName: data.companyName,
            rejectionReason: data.rejectionReason,
            supportEmail: 'soporte@vida.finance',
          },
        });
        await logSend('email', to, data.type, { companyName: data.companyName });
        break;
      }

      // ── Loan: overdue reminder (new) / loan_overdue (legacy) ──────────────
      case 'loan_overdue_reminder':
      case 'loan_overdue': {
        const phone = await resolvePhone(data);
        await sendAndLog(
          phone,
          `⚠️ *VIDA Finance*\n\nTu prestamo tiene un pago pendiente${data.daysOverdue ? ` de ${data.daysOverdue} dia(s)` : ''}.\n\nContactanos: soporte@vida.finance o 800-VIDA-MX`,
          data.type,
          data.loanId,
          `VIDA: Tu prestamo tiene un pago pendiente. Contactanos: soporte@vida.finance o 800-VIDA-MX`,
        );
        break;
      }

      // ── Legacy: 24h reminder ───────────────────────────────────────────────
      case 'loan_reminder_24h': {
        const phone = await resolvePhone(data);
        await sendAndLog(
          phone,
          `🔔 *VIDA Finance*\n\nManana vence tu pago de *$${fmt(data.amount!)} MXN*. Si tu empresa ya hizo el descuento, no tienes que hacer nada.\n\nvida-finance.web.app`,
          data.type,
          data.loanId,
          `VIDA: Manana vence tu pago de $${fmt(data.amount!)} MXN. Si tu empresa ya hizo el descuento, no tienes que hacer nada.`,
        );
        break;
      }

      default:
        console.warn(`[notification] Unknown job type: ${data.type} (job ${job.id})`);
    }
  },
  {
    connection: bullConnection,
    concurrency: 20,
  },
);

notificationWorker.on('completed', (job) => {
  console.log(`[notification] completed ${job.data.type} job ${job.id}`);
});

notificationWorker.on('failed', async (job, err) => {
  console.error(`[notification] failed ${job?.data.type} job ${job?.id}:`, err.message);
  // Log failures to incident_log for observability
  try {
    await firestore.logIncident({
      source: 'notification-worker',
      type: job?.data.type,
      jobId: job?.id,
      error: err.message,
      attempts: job?.attemptsMade,
      jobData: job?.data,
    });
  } catch (logErr) {
    console.error(`[notification] Failed to log incident:`, (logErr as Error).message);
  }
});
