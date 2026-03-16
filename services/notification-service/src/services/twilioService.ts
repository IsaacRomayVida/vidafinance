import twilio from 'twilio';

export class TwilioService {
  private client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
  );

  async sendWhatsApp(to: string, body: string) {
    const rawFrom = process.env.TWILIO_WHATSAPP_FROM ?? 'whatsapp:+14155238886';
    const waFrom = rawFrom.startsWith('whatsapp:') ? rawFrom : `whatsapp:${rawFrom}`;
    const waTo = `whatsapp:${this.normalizePhone(to)}`;
    return this.client.messages.create({ from: waFrom, to: waTo, body });
  }

  async sendSMS(to: string, body: string) {
    return this.client.messages.create({
      from: process.env.TWILIO_SMS_FROM,
      to: this.normalizePhone(to),
      body,
    });
  }

  private normalizePhone(p: string): string {
    const digits = String(p).replace(/\D/g, '');
    // Already has country code (starts with 52 = Mexico, 12 digits total)
    if (digits.length === 12 && digits.startsWith('52')) return `+${digits}`;
    // 10-digit Mexican number — prepend +52
    if (digits.length === 10) return `+52${digits}`;
    return `+${digits}`;
  }
}
