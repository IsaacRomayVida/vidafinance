import twilio from 'twilio';
import sgMail from '@sendgrid/mail';

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER ?? '';
const SENDGRID_FROM = process.env.SENDGRID_FROM_EMAIL ?? 'noreply@vidafinance.com';

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
    console.log(`[notify] Twilio not configured — skipping SMS to ${to}: ${body}`);
    return;
  }
  try {
    await twilioClient.messages.create({
      to,
      from: TWILIO_FROM,
      body,
    });
    console.log(`[notify] SMS sent to ${to}`);
  } catch (err) {
    console.error(`[notify] SMS failed to ${to}:`, err);
  }
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!process.env.SENDGRID_API_KEY) {
    console.log(`[notify] SendGrid not configured — skipping email to ${to}: ${subject}`);
    return;
  }
  try {
    await sgMail.send({
      to,
      from: SENDGRID_FROM,
      subject,
      html,
    });
    console.log(`[notify] Email sent to ${to}`);
  } catch (err) {
    console.error(`[notify] Email failed to ${to}:`, err);
  }
}

export async function notifyLoanEvent(event: string, data: Record<string, unknown>): Promise<void> {
  const employeePhone = data.employeePhone as string | undefined;
  const employeeEmail = data.employeeEmail as string | undefined;
  const employerEmail = data.employerEmail as string | undefined;
  const employeeName = (data.employeeName as string) ?? 'there';
  const loanAmount = data.loanAmount as string | number | undefined;
  const employerName = (data.employerName as string) ?? 'Employer';

  switch (event) {
    case 'loan_requested': {
      if (employeePhone) {
        await sendSMS(
          employeePhone,
          `Hi ${employeeName}, your loan request for ${loanAmount ?? 'the requested amount'} has been received. We'll notify you once it's reviewed.`,
        );
      }
      break;
    }

    case 'loan_approved': {
      if (employeePhone) {
        await sendSMS(
          employeePhone,
          `Great news, ${employeeName}! Your loan for ${loanAmount ?? 'the requested amount'} has been approved.`,
        );
      }
      if (employeeEmail) {
        await sendEmail(
          employeeEmail,
          '¡Tu préstamo ha sido aprobado! — VIDA Finance',
          vidaEmailTemplate(
            '¡Tu préstamo ha sido aprobado!',
            `<p style="color:#333;line-height:1.6">Hola ${employeeName},</p>
            <p style="color:#333;line-height:1.6">Tu préstamo por <strong style="color:#194445">${loanAmount ?? 'el monto solicitado'}</strong> ha sido aprobado.</p>
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
      const rejectionReason = (data.rejectionReason as string) ?? 'No se proporcionó un motivo específico.';
      if (employeePhone) {
        await sendSMS(employeePhone, `Hi ${employeeName}, unfortunately your loan request was not approved at this time.`);
      }
      if (employeeEmail) {
        await sendEmail(
          employeeEmail,
          'Actualización de tu solicitud — VIDA Finance',
          vidaEmailTemplate(
            'Actualización de tu solicitud',
            `<p style="color:#333;line-height:1.6">Hola ${employeeName},</p>
            <p style="color:#333;line-height:1.6">Lamentamos informarte que tu solicitud de préstamo no fue aprobada en esta ocasión.</p>
            <p style="color:#333;line-height:1.6"><strong>Motivo:</strong> ${rejectionReason}</p>
            <p style="color:#333;line-height:1.6">Si crees que esto es un error o necesitas más información, puedes contactarnos en <a href="mailto:soporte@vidafinance.com" style="color:#194445">soporte@vidafinance.com</a>.</p>`,
          ),
        );
      }
      break;
    }

    case 'loan_disbursed': {
      const referenceNumber = (data.referenceNumber as string) ?? 'N/A';
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
            `<p style="color:#333;line-height:1.6">Hola ${employeeName},</p>
            <p style="color:#333;line-height:1.6">Tu préstamo por <strong style="color:#194445">${loanAmount ?? 'el monto solicitado'}</strong> ha sido depositado en tu cuenta.</p>
            <p style="color:#333;line-height:1.6"><strong>Número de referencia:</strong> ${referenceNumber}</p>
            <p style="color:#333;line-height:1.6">Por favor verifica tu cuenta bancaria. Los fondos pueden tardar hasta 24 horas en reflejarse.</p>`,
          ),
        );
      }
      break;
    }

    case 'employer_approved': {
      const dashboardLink = (data.dashboardLink as string) ?? 'https://app.vidafinance.com';
      if (employerEmail) {
        await sendEmail(
          employerEmail,
          '¡Tu empresa está activa! — VIDA Finance',
          vidaEmailTemplate(
            '¡Tu empresa está activa!',
            `<p style="color:#333;line-height:1.6">Hola ${employerName},</p>
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
      const amountDue = (data.amountDue as string | number) ?? loanAmount ?? 'el monto pendiente';
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
            `<p style="color:#333;line-height:1.6">Hola ${employeeName},</p>
            <p style="color:#333;line-height:1.6">Tu pago de <strong style="color:#c0392b">${amountDue}</strong> está vencido. Por favor realiza tu pago lo antes posible para evitar cargos adicionales.</p>
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
      console.log(`[notify] Unknown loan event: ${event}`);
  }
}
