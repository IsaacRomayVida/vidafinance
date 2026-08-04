import { callML } from '../callML';

type Fraud = { is_fraud: boolean; fraud_probability: number; flags: string[] };

/**
 * `utils/callML.ts` is the inline, rule-based scorer. It is NOT the live
 * underwriting gateway — that is the private `callML()` in index.ts, which
 * really does fetch the ML service. These tests pin the invariants the inline
 * scorer has to hold before anything is ever allowed to import it, because the
 * two share a name and an exact call signature and are trivially swappable.
 */
describe('utils/callML — inline rule-based scorer', () => {
  describe('fraud gate', () => {
    it('flags fraud when every fraud signal fires at once', async () => {
      // Both rules trip: >2 requests in the last hour AND a max-size loan
      // requested with no bank account on file.
      const res = await callML('/underwrite/employee', {
        employeeId: 'emp-1',
        monthlySalary: 15000,
        employerTier: 2,
        existingLoans: 0,
        bankClabe: null,
        amount: 5000,
        requestsLastHour: 99,
      });

      const fraud = res['fraud'] as Fraud;

      expect(fraud.flags).toEqual(['high_frequency', 'max_amount_no_bank']);
      expect(fraud.fraud_probability).toBe(0.5);
      // The scorer's own maximum reachable probability must actually trip its
      // own gate. With a strict `> 0.5` threshold it never does, so `is_fraud`
      // is false for every possible input and the gate is decorative.
      expect(fraud.is_fraud).toBe(true);
    });

    it('does not flag fraud when only one signal fires', async () => {
      const res = await callML('/underwrite/employee', {
        employeeId: 'emp-1',
        monthlySalary: 15000,
        bankClabe: '012180001234567890',
        amount: 5000,
        requestsLastHour: 99,
      });

      const fraud = res['fraud'] as Fraud;
      expect(fraud.flags).toEqual(['high_frequency']);
      expect(fraud.fraud_probability).toBe(0.3);
      expect(fraud.is_fraud).toBe(false);
    });

    it('does not flag fraud for a clean applicant', async () => {
      const res = await callML('/underwrite/employee', {
        employeeId: 'emp-1',
        monthlySalary: 15000,
        bankClabe: '012180001234567890',
        amount: 1000,
        requestsLastHour: 0,
      });

      const fraud = res['fraud'] as Fraud;
      expect(fraud.flags).toEqual([]);
      expect(fraud.fraud_probability).toBe(0);
      expect(fraud.is_fraud).toBe(false);
    });
  });

  describe('credit limit', () => {
    it('never returns a negative credit limit for a negative salary', async () => {
      const res = await callML('/underwrite/employee', {
        employeeId: 'emp-1',
        monthlySalary: -50000,
        amount: 1000,
      });

      // A credit limit is money. It has no negative branch.
      expect(res['credit_limit']).toBe(0);
      expect(res['credit_limit'] as number).toBeGreaterThanOrEqual(0);
    });

    it('caps the credit limit at 5000 for a high salary', async () => {
      const res = await callML('/underwrite/employee', {
        employeeId: 'emp-1',
        monthlySalary: 90000,
        amount: 1000,
      });
      expect(res['credit_limit']).toBe(5000);
    });

    it('scales the credit limit with salary below the cap', async () => {
      const res = await callML('/underwrite/employee', {
        employeeId: 'emp-1',
        monthlySalary: 10000,
        amount: 1000,
      });
      expect(res['credit_limit']).toBe(3000);
    });
  });

  describe('score bounds', () => {
    it('keeps credit_score and default_probability inside their ranges', async () => {
      const res = await callML('/underwrite/employee', {
        employeeId: 'emp-1',
        monthlySalary: -1,
        employerTier: 3,
        existingLoans: 5,
        bankClabe: null,
        amount: 5000,
        requestsLastHour: 0,
      });

      expect(res['credit_score'] as number).toBeGreaterThanOrEqual(0);
      expect(res['credit_score'] as number).toBeLessThanOrEqual(100);
      expect(res['default_probability'] as number).toBeGreaterThanOrEqual(0);
      expect(res['default_probability'] as number).toBeLessThanOrEqual(1);
    });
  });
});
