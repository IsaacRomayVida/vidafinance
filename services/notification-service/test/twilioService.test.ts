import { setBaseEnv } from './testEnv';
setBaseEnv();

import { TwilioService, InvalidPhoneNumberError } from '../src/services/twilioService';

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
  // FIXED: normalizePhone now validates digit count beyond the 10/12 special
  // cases. An empty or garbage phone string is rejected with a distinct
  // InvalidPhoneNumberError before any network call is made, instead of being
  // sent to Twilio as a malformed value (e.g. "+").
  test('FIXED: an empty phone string is rejected before any Twilio call is made', async () => {
    const svc = new TwilioService();

    await expect(svc.sendSMS('', 'reminder')).rejects.toThrow(InvalidPhoneNumberError);
    expect(twilioMock.__messagesCreate).not.toHaveBeenCalled();
  });

  test('FIXED: a garbage (non-numeric) phone string is rejected before any Twilio call is made', async () => {
    const svc = new TwilioService();

    await expect(svc.sendWhatsApp('not-a-phone', 'hola')).rejects.toThrow(InvalidPhoneNumberError);
    expect(twilioMock.__messagesCreate).not.toHaveBeenCalled();
  });

  test('FIXED: a too-short number is rejected instead of being silently prefixed with +', async () => {
    const svc = new TwilioService();

    await expect(svc.sendSMS('12345', 'reminder')).rejects.toThrow(/not a valid Mexican phone number/);
    expect(twilioMock.__messagesCreate).not.toHaveBeenCalled();
  });

  test('FIXED: a 12-digit number that does not carry the 52 country code is rejected', async () => {
    const svc = new TwilioService();

    await expect(svc.sendSMS('551234567890', 'reminder')).rejects.toThrow(InvalidPhoneNumberError);
    expect(twilioMock.__messagesCreate).not.toHaveBeenCalled();
  });

  test('a rejected number is distinguishable from a provider delivery failure', async () => {
    const svc = new TwilioService();
    let rejectedError: unknown;
    try {
      await svc.sendSMS('', 'reminder');
    } catch (err) {
      rejectedError = err;
    }
    expect(rejectedError).toBeInstanceOf(InvalidPhoneNumberError);

    twilioMock.__messagesCreate.mockRejectedValueOnce(new Error('Twilio 21211: invalid to number'));
    let deliveryError: unknown;
    try {
      await svc.sendSMS('5512345678', 'reminder');
    } catch (err) {
      deliveryError = err;
    }
    expect(deliveryError).not.toBeInstanceOf(InvalidPhoneNumberError);
  });
});
