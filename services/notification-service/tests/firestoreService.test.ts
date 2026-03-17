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

import { __setMockData, __resetMockStore } from './__mocks__/firebase';
import { FirestoreService } from '../src/services/firestoreService';

describe('FirestoreService', () => {
  let service: FirestoreService;

  beforeEach(() => {
    __resetMockStore();
    service = new FirestoreService();
  });

  describe('getUser', () => {
    it('should find user in employees collection', async () => {
      __setMockData('employees/user1', { phone: '5512345678', email: 'a@b.com', name: 'Ana' });

      const user = await service.getUser('user1');

      expect(user.phone).toBe('5512345678');
      expect(user.email).toBe('a@b.com');
      expect(user.name).toBe('Ana');
    });

    it('should fall back to users collection', async () => {
      __setMockData('users/user2', { phone: '5587654321', email: 'b@c.com' });

      const user = await service.getUser('user2');

      expect(user.phone).toBe('5587654321');
    });

    it('should throw when user not found', async () => {
      await expect(service.getUser('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('getLoan', () => {
    it('should return loan data', async () => {
      __setMockData('loans/loan1', { amount: 5000, status: 'approved' });

      const loan = await service.getLoan('loan1');

      expect(loan.amount).toBe(5000);
      expect(loan.status).toBe('approved');
    });

    it('should throw when loan not found', async () => {
      await expect(service.getLoan('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('logNotification', () => {
    it('should log to notification_log collection', async () => {
      await expect(
        service.logNotification({ channel: 'whatsapp', to: '+525512345678', type: 'loan_approved' }),
      ).resolves.not.toThrow();
    });
  });

  describe('logIncident', () => {
    it('should log to incident_log collection', async () => {
      await expect(
        service.logIncident({ source: 'notification-worker', type: 'loan_approved', error: 'test error' }),
      ).resolves.not.toThrow();
    });
  });
});
