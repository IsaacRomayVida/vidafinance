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
          'Your Vida Finance Loan Has Been Approved',
          `<p>Hi ${employeeName},</p><p>Your loan for <strong>${loanAmount ?? 'the requested amount'}</strong> has been approved. Funds will be disbursed shortly.</p><p>— Vida Finance</p>`,
        );
      }
      break;
    }

    case 'loan_disbursed': {
      if (employeePhone) {
        await sendSMS(
          employeePhone,
          `Hi ${employeeName}, your loan funds have been disbursed. Please check your account.`,
        );
      }
      break;
    }

    case 'employer_approved': {
      if (employerEmail) {
        await sendEmail(
          employerEmail,
          'Your Organization Has Been Approved — Vida Finance',
          `<p>Hi ${employerName},</p><p>Your organization has been approved on Vida Finance. Your employees can now apply for salary-advance loans.</p><p>— Vida Finance</p>`,
        );
      }
      break;
    }

    case 'loan_overdue': {
      if (employeePhone) {
        await sendSMS(
          employeePhone,
          `Hi ${employeeName}, your loan payment is overdue. Please make a payment as soon as possible to avoid additional fees.`,
        );
      }
      if (employeeEmail) {
        await sendEmail(
          employeeEmail,
          'Loan Payment Overdue — Vida Finance',
          `<p>Hi ${employeeName},</p><p>Your loan payment is <strong>overdue</strong>. Please make a payment as soon as possible to avoid additional fees.</p><p>— Vida Finance</p>`,
        );
      }
      break;
    }

    default:
      console.log(`[notify] Unknown loan event: ${event}`);
  }
}
