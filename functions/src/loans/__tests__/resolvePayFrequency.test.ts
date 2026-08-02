import { resolvePayFrequency } from '../resolvePayFrequency';
import { _mockStore, mockDb } from '../../__mocks__/firebase-admin/firestore';

beforeEach(() => {
  jest.clearAllMocks();
  _mockStore.employees = {};
});

describe('resolvePayFrequency', () => {
  it('reads the borrower record when the loan carries no snapshot', async () => {
    // The production case. Nothing writes borrowerSnapshot onto a loan (#431),
    // so this is the path every real disbursement takes.
    _mockStore.employees['emp-1'] = { exists: true, data: { payFrequency: 'biweekly' } };

    await expect(resolvePayFrequency('emp-1')).resolves.toEqual({
      frequency: 'biweekly',
      source: 'employee_record',
    });
  });

  it('prefers the loan snapshot over the borrower record when one exists', async () => {
    _mockStore.employees['emp-1'] = { exists: true, data: { payFrequency: 'monthly' } };

    await expect(
      resolvePayFrequency('emp-1', { payFrequency: 'weekly' })
    ).resolves.toEqual({ frequency: 'weekly', source: 'loan_snapshot' });
  });

  it('does not read the borrower record at all when the snapshot answers', async () => {
    await resolvePayFrequency('emp-1', { payFrequency: 'semimonthly' });
    expect(mockDb.collection).not.toHaveBeenCalledWith('employees');
  });

  it('reports default_monthly when the borrower record has no frequency', async () => {
    _mockStore.employees['emp-1'] = { exists: true, data: { name: 'No frequency here' } };

    await expect(resolvePayFrequency('emp-1')).resolves.toEqual({
      frequency: 'monthly',
      source: 'default_monthly',
    });
  });

  it('reports default_monthly when the borrower record does not exist', async () => {
    await expect(resolvePayFrequency('missing-uid')).resolves.toEqual({
      frequency: 'monthly',
      source: 'default_monthly',
    });
  });

  it('reports default_monthly when no uid is available', async () => {
    await expect(resolvePayFrequency(undefined)).resolves.toEqual({
      frequency: 'monthly',
      source: 'default_monthly',
    });
  });

  it('rejects a frequency value the payroll calculator does not understand', async () => {
    // A junk value must not reach calculateNextPayrollDate and fall through its
    // switch — it degrades to the stated default, and says so.
    _mockStore.employees['emp-1'] = { exists: true, data: { payFrequency: 'quincenal' } };

    await expect(resolvePayFrequency('emp-1')).resolves.toEqual({
      frequency: 'monthly',
      source: 'default_monthly',
    });
  });

  it('degrades instead of throwing when the record cannot be read', async () => {
    // Disbursing an approved loan must not be blocked by an unreadable
    // employee document — but the caller has to learn the date is an assumption.
    const boom = new Error('firestore unavailable');
    jest.spyOn(mockDb, 'collection').mockImplementationOnce(() => {
      throw boom;
    });

    await expect(resolvePayFrequency('emp-1')).resolves.toEqual({
      frequency: 'monthly',
      source: 'default_monthly',
    });
  });
});
