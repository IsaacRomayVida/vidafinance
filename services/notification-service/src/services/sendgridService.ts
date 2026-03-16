import sgMail from '@sendgrid/mail';

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

export interface SendEmailOptions {
  to: string;
  subject: string;
  templateId: string;
  dynamicData: Record<string, unknown>;
}

export class SendGridService {
  async sendEmail({ to, subject, templateId, dynamicData }: SendEmailOptions): Promise<void> {
    await sgMail.send({
      to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL ?? 'noreply@vida.finance',
        name: 'VIDA Finance',
      },
      subject,
      templateId,
      dynamicTemplateData: dynamicData,
    });
  }
}
