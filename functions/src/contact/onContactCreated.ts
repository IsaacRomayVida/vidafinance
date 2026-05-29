import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { sendEmail } from '../utils/notify';

// Internal inbox that receives a heads-up on every contact submission.
// Set CONTACT_NOTIFY_EMAIL on the Functions runtime to override the default.
const CONTACT_NOTIFY_EMAIL = process.env.CONTACT_NOTIFY_EMAIL ?? 'hola@funpay.mx';

function esc(value: unknown): string {
  return String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function row(label: string, value: unknown): string {
  return `<tr>
    <td style="padding:8px 12px;color:#4a6364;font-size:13px;font-weight:600;white-space:nowrap;vertical-align:top">${label}</td>
    <td style="padding:8px 12px;color:#0c1e1f;font-size:14px">${esc(value)}</td>
  </tr>`;
}

function contactEmailTemplate(d: Record<string, unknown>): string {
  const audience = d.type === 'empresa' ? 'Empresa' : d.type === 'trabajador' ? 'Trabajador' : esc(d.type);
  return `
    <div style="max-width:600px;margin:0 auto;font-family:'DM Sans',Arial,sans-serif;background:#f5f1eb;padding:32px 20px">
      <div style="text-align:center;margin-bottom:24px">
        <h1 style="font-family:'DM Serif Display',Georgia,serif;color:#194445;font-size:24px;margin:0">Funpay</h1>
      </div>
      <div style="background:#fff;border-radius:16px;padding:28px">
        <h2 style="font-family:'DM Serif Display',Georgia,serif;color:#194445;font-size:20px;margin:0 0 16px">Nuevo contacto</h2>
        <table style="width:100%;border-collapse:collapse">
          ${row('Tipo', audience)}
          ${row('Nombre', d.name)}
          ${row('Correo', d.email)}
          ${row('Empresa', d.company)}
          ${row('Celular', d.phone)}
          ${row('Origen', d.source)}
          ${row('Idioma', d.lang)}
          ${row('Mensaje', d.message)}
        </table>
      </div>
      <p style="text-align:center;margin-top:16px;color:#93aaa9;font-size:12px">Enviado automáticamente desde el formulario de contacto de Funpay.</p>
    </div>
  `;
}

// Fires when the public contact form (coming-soon page or /contact) writes a
// new document to the `contact` collection. Emails the internal inbox via the
// shared SendGrid helper, which no-ops gracefully if SENDGRID_API_KEY is unset.
export const onContactCreated = onDocumentCreated('contact/{docId}', async (event) => {
  const data = event.data?.data();
  if (!data) return;

  const audience = data['type'] === 'empresa' ? 'empresa' : data['type'] === 'trabajador' ? 'trabajador' : (data['type'] ?? 'general');
  const name = (data['name'] as string) || 'sin nombre';
  const subject = `Nuevo contacto Funpay — ${audience}: ${name}`;

  try {
    await sendEmail(CONTACT_NOTIFY_EMAIL, subject, contactEmailTemplate(data));
  } catch (err) {
    logger.error('[onContactCreated] failed to send notification email', {
      error: (err as Error).message,
      docId: event.params['docId'],
      service: 'functions',
    });
  }
});
