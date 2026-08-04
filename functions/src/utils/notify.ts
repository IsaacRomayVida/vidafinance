import twilio from 'twilio';
import sgMail from '@sendgrid/mail';
import { logger } from 'firebase-functions';
import { auditLog } from './auditLog';

// notify.ts is imported at the top of index.ts, which defines every Cloud
// Function in the deployment. The twilio SDK throws synchronously from its
// constructor for a truthy-but-malformed accountSid (wrong secret, truncated
// value, an API-key SID used without the paired `accountSid` option, etc.) —
// left unguarded, one bad env var would crash the entire app at cold start
// instead of just leaving SMS unconfigured.
let twilioClient: ReturnType<typeof twilio> | null = null;
if (process.env.TWILIO_ACCOUNT_SID) {
  try {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  } catch (err) {
    console.error('[notify] Failed to initialize Twilio client — SMS disabled:', err);
  }
}

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER ?? '';
const SENDGRID_FROM = process.env.SENDGRID_FROM_EMAIL ?? 'noreply@vidafinance.com';

// SendGrid's client (axios) has no default request timeout, unlike Twilio's
// SDK (30s default). Without a bound, a stalled SendGrid connection can hang
// whatever Firestore trigger or scheduled sweep called sendEmail.
const SENDGRID_SEND_TIMEOUT_MS = 15_000;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMXN(amount: string | number | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return String(amount ?? '');
  }
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(amount);
}

async function recordSendFailure(channel: 'sms' | 'email', to: string, err: unknown): Promise<void> {
  try {
    await auditLog({
      action: `notification.${channel}_failed`,
      actorUid: 'system',
      actorRole: 'system',
      targetId: to,
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  } catch (auditErr) {
    console.error(`[notify] Failed to record ${channel} send failure in audit_log:`, auditErr);
  }
}

function vidaEmailTemplate(title: string, body: string): string {
  return `
    <div style="max-width:600px;margin:0 auto;font-family:Inter,sans-serif;background:#f5f1eb;padding:40px 20px">
      <div style="text-align:center;margin-bottom:32px">
        <h1 style="font-family:'DM Serif Display',serif;color:#194445;font-size:28px;margin:0">VIDA Finance</h1>
      </div>
      <div style="background:#fff;border-radius:16px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
        <h2 style="font-family:'DM Serif Display',serif;color:#194445;font-size:22px;margin:0 0 16px">${title}</h2>
        ${body}
      </div>
      <div style="text-align:center;margin-top:24px;color:#666;font-size:12px">
        <p>VIDA Finance — Life, Unlocked.</p>
        <p>Este correo fue enviado por VIDA Finance SOFOM.</p>
      </div>
    </div>
  `;
}

export async function sendSMS(to: string, body: string): Promise<void> {
  if (!twilioClient) {
    logger.info('[notify] Twilio not configured — skipping SMS', { to, service: 'notify' });
    return;
  }
  try {
    await twilioClient.messages.create({
      to,
      from: TWILIO_FROM,
      body,
    });
    logger.info('[notify] SMS sent', { to, service: 'notify' });
  } catch (err) {
    console.error(`[notify] SMS failed to ${to}:`, err);
    await recordSendFailure('sms', to, err);
  }
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!process.env.SENDGRID_API_KEY) {
    logger.info('[notify] SendGrid not configured — skipping email', { to, subject, service: 'notify' });
    return;
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sgMail.send({
        to,
        from: SENDGRID_FROM,
        subject,
        html,
      }),
      new Promise((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('SendGrid send timed out')), SENDGRID_SEND_TIMEOUT_MS);
      }),
    ]);
    logger.info('[notify] Email sent', { to, service: 'notify' });
  } catch (err) {
    console.error(`[notify] Email failed to ${to}:`, err);
    await recordSendFailure('email', to, err);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function notifyLoanEvent(event: string, data: Record<string, unknown>): Promise<void> {
  const employeePhone = data.employeePhone as string | undefined;
  const employeeEmail = data.employeeEmail as string | undefined;
  const employerEmail = data.employerEmail as string | undefined;
  const employeeName = (data.employeeName as string) ?? 'there';
  const loanAmount = data.loanAmount as string | number | undefined;
  const employerName = (data.employerName as string) ?? 'Employer';

  // SMS is plain text (no markup risk), so it uses the raw name for a
  // natural greeting. HTML emails interpolate the escaped variant so
  // attacker-controlled values (e.g. a signup name containing markup) can't
  // break out of the template.
  const employeeNameHtml = escapeHtml(employeeName);
  const employerNameHtml = escapeHtml(employerName);
  const loanAmountText = loanAmount !== undefined ? formatMXN(loanAmount) : undefined;

  switch (event) {
    case 'loan_requested': {
      if (employeePhone) {
        await sendSMS(
          employeePhone,
          `Hi ${employeeName}, your loan request for ${loanAmountText ?? 'the requested amount'} has been received. We'll notify you once it's reviewed.`,
        );
      }
      break;
    }

    case 'loan_approved': {
      if (employeePhone) {
        await sendSMS(
          employeePhone,
          `Great news, ${employeeName}! Your loan for ${loanAmountText ?? 'the requested amount'} has been approved.`,
        );
      }
      if (employeeEmail) {
        await sendEmail(
          employeeEmail,
          '¡Tu préstamo ha sido aprobado! — VIDA Finance',
          vidaEmailTemplate(
            '¡Tu préstamo ha sido aprobado!',
            `<p style="color:#333;line-height:1.6">Hola ${employeeNameHtml},</p>
            <p style="color:#333;line-height:1.6">Tu préstamo por <strong style="color:#194445">${loanAmountText ?? 'el monto solicitado'}</strong> ha sido aprobado.</p>
            <p style="color:#333;line-height:1.6"><strong>Próximos pasos:</strong></p>
            <ul style="color:#333;line-height:1.8">
              <li>Los fondos serán depositados en tu cuenta registrada.</li>
              <li>Recibirás una confirmación cuando se realice el depósito.</li>
            </ul>
            <p style="color:#333;line-height:1.6">Si tienes preguntas, no dudes en contactarnos.</p>`,
          ),
        );
      }
      break;
    }

    case 'loan_rejected': {
      const rejectionReason = escapeHtml(
        (data.rejectionReason as string) ?? 'No se proporcionó un motivo específico.'
      );
      if (employeePhone) {
        await sendSMS(employeePhone, `Hi ${employeeName}, unfortunately your loan request was not approved at this time.`);
      }
      if (employeeEmail) {
        await sendEmail(
          employeeEmail,
          'Actualización de tu solicitud — VIDA Finance',
          vidaEmailTemplate(
            'Actualización de tu solicitud',
            `<p style="color:#333;line-height:1.6">Hola ${employeeNameHtml},</p>
            <p style="color:#333;line-height:1.6">Lamentamos informarte que tu solicitud de préstamo no fue aprobada en esta ocasión.</p>
            <p style="color:#333;line-height:1.6"><strong>Motivo:</strong> ${rejectionReason}</p>
            <p style="color:#333;line-height:1.6">Si crees que esto es un error o necesitas más información, puedes contactarnos en <a href="mailto:soporte@vidafinance.com" style="color:#194445">soporte@vidafinance.com</a>.</p>`,
          ),
        );
      }
      break;
    }

    case 'loan_disbursed': {
      const referenceNumber = escapeHtml((data.referenceNumber as string) ?? 'N/A');
      if (employeePhone) {
        await sendSMS(
          employeePhone,
          `Hi ${employeeName}, your loan funds have been disbursed. Please check your account.`,
        );
      }
      if (employeeEmail) {
        await sendEmail(
          employeeEmail,
          '¡Fondos enviados! — VIDA Finance',
          vidaEmailTemplate(
            '¡Fondos enviados!',
            `<p style="color:#333;line-height:1.6">Hola ${employeeNameHtml},</p>
            <p style="color:#333;line-height:1.6">Tu préstamo por <strong style="color:#194445">${loanAmountText ?? 'el monto solicitado'}</strong> ha sido depositado en tu cuenta.</p>
            <p style="color:#333;line-height:1.6"><strong>Número de referencia:</strong> ${referenceNumber}</p>
            <p style="color:#333;line-height:1.6">Por favor verifica tu cuenta bancaria. Los fondos pueden tardar hasta 24 horas en reflejarse.</p>`,
          ),
        );
      }
      break;
    }

    case 'employer_approved': {
      const dashboardLink = escapeHtml((data.dashboardLink as string) ?? 'https://app.vidafinance.com');
      if (employerEmail) {
        await sendEmail(
          employerEmail,
          '¡Tu empresa está activa! — VIDA Finance',
          vidaEmailTemplate(
            '¡Tu empresa está activa!',
            `<p style="color:#333;line-height:1.6">Hola ${employerNameHtml},</p>
            <p style="color:#333;line-height:1.6">Tu empresa ha sido aprobada en VIDA Finance. Tus empleados ya pueden solicitar adelantos de nómina.</p>
            <p style="text-align:center;margin:24px 0">
              <a href="${dashboardLink}" style="background:#194445;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Ir al Dashboard</a>
            </p>`,
          ),
        );
      }
      break;
    }

    case 'loan_overdue': {
      const amountDueRaw = (data.amountDue as string | number | undefined) ?? loanAmount;
      const amountDueText = amountDueRaw !== undefined ? formatMXN(amountDueRaw) : 'el monto pendiente';
      if (employeePhone) {
        await sendSMS(
          employeePhone,
          `Hi ${employeeName}, your loan payment is overdue. Please make a payment as soon as possible to avoid additional fees.`,
        );
      }
      if (employeeEmail) {
        await sendEmail(
          employeeEmail,
          'Recordatorio de pago — VIDA Finance',
          vidaEmailTemplate(
            'Recordatorio de pago',
            `<p style="color:#333;line-height:1.6">Hola ${employeeNameHtml},</p>
            <p style="color:#333;line-height:1.6">Tu pago de <strong style="color:#c0392b">${amountDueText}</strong> está vencido. Por favor realiza tu pago lo antes posible para evitar cargos adicionales.</p>
            <p style="color:#333;line-height:1.6"><strong>Instrucciones de pago:</strong></p>
            <ul style="color:#333;line-height:1.8">
              <li>Realiza una transferencia a la cuenta CLABE proporcionada en tu contrato.</li>
              <li>Incluye tu número de préstamo como referencia.</li>
            </ul>
            <p style="color:#333;line-height:1.6">Si ya realizaste tu pago, por favor ignora este mensaje. Para dudas, escríbenos a <a href="mailto:soporte@vidafinance.com" style="color:#194445">soporte@vidafinance.com</a>.</p>`,
          ),
        );
      }
      break;
    }

    default:
      logger.warn('[notify] Unknown loan event', { event, service: 'notify' });
  }
}
