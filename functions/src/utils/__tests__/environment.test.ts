import { allowTestBypass, isEmulator, isProductionProject, projectId } from '../environment';

const ENV_KEYS = ['GCLOUD_PROJECT', 'GCP_PROJECT', 'FUNCTIONS_EMULATOR', 'VIDA_ALLOW_TEST_BYPASS'] as const;

describe('utils/environment', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  });

  describe('allowTestBypass', () => {
    it('is false on the production project', () => {
      process.env['GCLOUD_PROJECT'] = 'vida-finance';
      expect(allowTestBypass()).toBe(false);
    });

    it('stays false on production even with the emulator flag set', () => {
      process.env['GCLOUD_PROJECT'] = 'vida-finance';
      process.env['FUNCTIONS_EMULATOR'] = 'true';
      expect(allowTestBypass()).toBe(false);
    });

    it('stays false on production even with an explicit opt-in', () => {
      process.env['GCLOUD_PROJECT'] = 'vida-finance';
      process.env['VIDA_ALLOW_TEST_BYPASS'] = 'true';
      expect(allowTestBypass()).toBe(false);
    });

    it('fails closed when the project id is unknown', () => {
      expect(projectId()).toBe('');
      expect(allowTestBypass()).toBe(false);
    });

    it('fails closed on an unrecognised project with no opt-in', () => {
      process.env['GCLOUD_PROJECT'] = 'some-other-project';
      expect(allowTestBypass()).toBe(false);
    });

    it('is true inside the emulator', () => {
      process.env['FUNCTIONS_EMULATOR'] = 'true';
      process.env['GCLOUD_PROJECT'] = 'demo-vida-finance-test';
      expect(allowTestBypass()).toBe(true);
    });

    it('is true for demo-* emulator projects', () => {
      process.env['GCLOUD_PROJECT'] = 'demo-vida-finance-test';
      expect(allowTestBypass()).toBe(true);
    });

    it('honours the explicit opt-in on a non-production project', () => {
      process.env['GCLOUD_PROJECT'] = 'vida-finance-staging';
      process.env['VIDA_ALLOW_TEST_BYPASS'] = 'true';
      expect(allowTestBypass()).toBe(true);
    });

    it('ignores a non-"true" opt-in value', () => {
      process.env['GCLOUD_PROJECT'] = 'vida-finance-staging';
      process.env['VIDA_ALLOW_TEST_BYPASS'] = '1';
      expect(allowTestBypass()).toBe(false);
    });
  });

  describe('helpers', () => {
    it('isEmulator reflects FUNCTIONS_EMULATOR', () => {
      expect(isEmulator()).toBe(false);
      process.env['FUNCTIONS_EMULATOR'] = 'true';
      expect(isEmulator()).toBe(true);
    });

    it('isProductionProject matches only the live project id', () => {
      process.env['GCLOUD_PROJECT'] = 'vida-finance';
      expect(isProductionProject()).toBe(true);
      process.env['GCLOUD_PROJECT'] = 'vida-finance-staging';
      expect(isProductionProject()).toBe(false);
    });

    it('falls back to GCP_PROJECT', () => {
      process.env['GCP_PROJECT'] = 'vida-finance';
      expect(projectId()).toBe('vida-finance');
      expect(isProductionProject()).toBe(true);
    });
  });
});
