process.env.REDIS_URL = 'redis://localhost:6379';
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'test',
  private_key_id: 'key',
  private_key: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n',
  client_email: 'test@test.iam.gserviceaccount.com',
  client_id: '123',
  auth_uri: '',
  token_uri: '',
});
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'test-token';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';
process.env.TWILIO_SMS_FROM = '+15551234567';

// Mock twilio before importing the service
jest.mock('twilio', () => {
  const mockCreate = jest.fn();
  return jest.fn(() => ({
    messages: { create: mockCreate },
  }));
});

import { TwilioService } from '../src/services/twilioService';

// Get the mock create function
const twilioModule = require('twilio');
const mockClient = twilioModule();
const mockCreate = mockClient.messages.create as jest.Mock;

describe('TwilioService', () => {
  let service: TwilioService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TwilioService();
  });

  describe('normalizePhone', () => {
    it('should prepend +52 for 10-digit Mexican numbers', () => {
      expect(service.normalizePhone('5512345678')).toBe('+525512345678');
    });

    it('should prepend + for 12-digit numbers starting with 52', () => {
      expect(service.normalizePhone('525512345678')).toBe('+525512345678');
    });

    it('should strip non-digit characters', () => {
      expect(service.normalizePhone('(55) 1234-5678')).toBe('+525512345678');
    });

    it('should handle numbers with + prefix', () => {
      expect(service.normalizePhone('+525512345678')).toBe('+525512345678');
    });

    it('should handle other lengths by prepending +', () => {
      expect(service.normalizePhone('12025551234')).toBe('+12025551234');
    });
  });

  describe('sendWhatsApp', () => {
    it('should send via WhatsApp with correct from/to format', async () => {
      mockCreate.mockResolvedValueOnce({ sid: 'SM123', status: 'queued' });

      await service.sendWhatsApp('5512345678', 'Hola');

      expect(mockCreate).toHaveBeenCalledWith({
        from: 'whatsapp:+14155238886',
        to: 'whatsapp:+525512345678',
        body: 'Hola',
      });
    });
  });

  describe('sendSMS', () => {
    it('should send SMS with normalized phone', async () => {
      mockCreate.mockResolvedValueOnce({ sid: 'SM456', status: 'queued' });

      await service.sendSMS('5512345678', 'Hola SMS');

      expect(mockCreate).toHaveBeenCalledWith({
        from: '+15551234567',
        to: '+525512345678',
        body: 'Hola SMS',
      });
    });
  });

  describe('sendWithFallback', () => {
    it('should return whatsapp channel when WhatsApp succeeds', async () => {
      mockCreate.mockResolvedValueOnce({ sid: 'SM789', status: 'queued' });

      const result = await service.sendWithFallback('5512345678', '*Bold WA*', 'Plain SMS');

      expect(result.channel).toBe('whatsapp');
      expect(result.fallback).toBe(false);
      expect(result.sid).toBe('SM789');
    });

    it('should fall back to SMS when WhatsApp fails', async () => {
      mockCreate
        .mockRejectedValueOnce(new Error('WhatsApp not available'))
        .mockResolvedValueOnce({ sid: 'SM999', status: 'queued' });

      const result = await service.sendWithFallback('5512345678', '*Bold WA*', 'Plain SMS');

      expect(result.channel).toBe('sms');
      expect(result.fallback).toBe(true);
      expect(result.sid).toBe('SM999');
      // Second call should be SMS with plain text
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(mockCreate.mock.calls[1][0].body).toBe('Plain SMS');
    });

    it('should strip markdown from WA body when no SMS body provided', async () => {
      mockCreate
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ sid: 'SM111', status: 'queued' });

      await service.sendWithFallback('5512345678', '*Bold* _italic_ `code`');

      expect(mockCreate.mock.calls[1][0].body).toBe('Bold italic code');
    });
  });
});
