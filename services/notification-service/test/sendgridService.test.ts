import { setBaseEnv } from './testEnv';
setBaseEnv();

import { SendGridService } from '../src/services/sendgridService';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sgMailMock = require('@sendgrid/mail');

beforeEach(() => {
  sgMailMock.send.mockClear();
});

describe('SendGridService.sendEmail', () => {
  test('sends with the configured from address, template id, and dynamic data', async () => {
    const svc = new SendGridService();
    await svc.sendEmail({
      to: 'employer@acme.mx',
      subject: 'Bienvenido',
      templateId: 'd-employer-approved',
      dynamicData: { companyName: 'Acme' },
    });

    expect(sgMailMock.send).toHaveBeenCalledWith({
      to: 'employer@acme.mx',
      from: { email: 'noreply@vida.finance', name: 'VIDA Finance' },
      subject: 'Bienvenido',
      templateId: 'd-employer-approved',
      dynamicTemplateData: { companyName: 'Acme' },
    });
  });

  test('propagates a provider failure instead of swallowing it', async () => {
    sgMailMock.send.mockRejectedValueOnce(new Error('SendGrid 401: Unauthorized'));
    const svc = new SendGridService();

    await expect(
      svc.sendEmail({ to: 'a@b.com', subject: 'x', templateId: 't', dynamicData: {} }),
    ).rejects.toThrow(/Unauthorized/);
  });
});
