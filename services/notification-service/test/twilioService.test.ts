import { setBaseEnv } from './testEnv';
setBaseEnv();

import { TwilioService } from '../src/services/twilioService';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const twilioMock = require('twilio');

beforeEach(() => {
  twilioMock.__messagesCreate.mockClear();
});

describe('TwilioService.sendWhatsApp', () => {
  test('normalizes a 10-digit Mexican number and prefixes whatsapp:', async () => {
    const svc = new TwilioService();
    await svc.sendWhatsApp('5512345678', 'hola');

    expect(twilioMock.__messagesCreate).toHaveBeenCalledWith({
      from: 'whatsapp:+14155238886',
      to: 'whatsapp:+525512345678',
      body: 'hola',
    });
  });

  test('passes through a number that already carries the 52 country code', async () => {
    const svc = new TwilioService();
    await svc.sendWhatsApp('525512345678', 'hola');

    expect(twilioMock.__messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'whatsapp:+525512345678' }),
    );
  });

  test('does not double-prefix TWILIO_WHATSAPP_FROM when it already has the whatsapp: scheme', async () => {
    const svc = new TwilioService();
    await svc.sendWhatsApp('5512345678', 'hola');
    expect(twilioMock.__messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'whatsapp:+14155238886' }),
    );
  });

  test('propagates a provider failure instead of swallowing it', async () => {
    twilioMock.__messagesCreate.mockRejectedValueOnce(new Error('Twilio 21211: invalid to number'));
    const svc = new TwilioService();

    await expect(svc.sendWhatsApp('5512345678', 'hola')).rejects.toThrow(/invalid to number/);
  });
});

describe('TwilioService.sendSMS', () => {
  test('sends with TWILIO_SMS_FROM and a normalized destination', async () => {
    const svc = new TwilioService();
    await svc.sendSMS('5512345678', 'reminder');

    expect(twilioMock.__messagesCreate).toHaveBeenCalledWith({
      from: '+15005550006',
      to: '+525512345678',
      body: 'reminder',
    });
  });

  test('propagates a provider failure instead of swallowing it', async () => {
    twilioMock.__messagesCreate.mockRejectedValueOnce(new Error('Twilio 20003: authentication failed'));
    const svc = new TwilioService();

    await expect(svc.sendSMS('5512345678', 'reminder')).rejects.toThrow(/authentication failed/);
  });
});

describe('TwilioService — malformed phone input', () => {
  // DEFECT: normalizePhone does not validate digit count beyond the 10/12
  // special cases -- an empty or garbage phone string is sent to Twilio
  // as-is (e.g. "+") instead of being rejected before the network call.
  test('DEFECT: an empty phone string normalizes to just "+" and is still sent to Twilio', async () => {
    const svc = new TwilioService();
    await svc.sendSMS('', 'reminder');

    expect(twilioMock.__messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+' }),
    );
  });
});
