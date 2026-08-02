// #389 — the loan-config READ path must fail CLOSED.
//
// The whole point of these tests is the branch that does NOT exist: there is no
// path through getLoanConfigValues() that returns a fee rate nobody approved.
// An unreadable, malformed or out-of-bounds config document throws; only a
// genuinely absent document falls back to the ratified compile-time seed.

const mockConfigGet = jest.fn();

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => ({
    collection: jest.fn((name: string) => ({
      doc: jest.fn((id: string) => ({
        get: () => mockConfigGet(name, id),
      })),
    })),
  })),
}));

import {
  LOAN_FEE_RATE,
  MAX_ALLOWED_FEE_RATE,
  MIN_ALLOWED_FEE_RATE,
  LoanConfigError,
  assertValidFeeRate,
  getLoanConfigValues,
  getSeedLoanConfigValues,
} from '../loanConfig';

/** Shapes a DocumentSnapshot-ish object for the mocked get(). */
function snapshot(data: Record<string, unknown> | null) {
  return { exists: data !== null, data: () => data ?? undefined };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getLoanConfigValues — read path', () => {
  it('reads config/loan, and nothing else', async () => {
    mockConfigGet.mockResolvedValue(snapshot(null));

    await getLoanConfigValues();

    expect(mockConfigGet).toHaveBeenCalledTimes(1);
    expect(mockConfigGet).toHaveBeenCalledWith('config', 'loan');
  });

  it('returns the ratified seed when the config document does not exist', async () => {
    mockConfigGet.mockResolvedValue(snapshot(null));

    await expect(getLoanConfigValues()).resolves.toEqual(getSeedLoanConfigValues());
    expect((await getLoanConfigValues()).feeRate).toBe(LOAN_FEE_RATE);
  });

  it('returns the stored feeRate when the config document exists and is valid', async () => {
    mockConfigGet.mockResolvedValue(snapshot({ feeRate: 0.12, updatedBy: 'admin-1' }));

    const config = await getLoanConfigValues();

    expect(config.feeRate).toBe(0.12);
  });

  it('keeps terms, min and max code-owned — a stored override is ignored', async () => {
    // Only feeRate is editable. If someone writes allowedTermDays into the
    // document (by hand, or via a future careless callable), the code values
    // must still win: the term list is a claim about what underwriting, the
    // deduction schedule and the contract PDF support, not a preference.
    mockConfigGet.mockResolvedValue(
      snapshot({
        feeRate: 0.2,
        allowedTermDays: [15, 45, 60],
        defaultTermDays: 60,
        minAmount: 1,
        maxAmount: 999999,
      })
    );

    const config = await getLoanConfigValues();
    const seed = getSeedLoanConfigValues();

    expect(config.feeRate).toBe(0.2);
    expect(config.allowedTermDays).toEqual(seed.allowedTermDays);
    expect(config.defaultTermDays).toBe(seed.defaultTermDays);
    expect(config.minAmount).toBe(seed.minAmount);
    expect(config.maxAmount).toBe(seed.maxAmount);
  });

  describe('fails closed', () => {
    it('THROWS — does not fall back to the seed — when the read itself fails', async () => {
      mockConfigGet.mockRejectedValue(new Error('DEADLINE_EXCEEDED'));

      await expect(getLoanConfigValues()).rejects.toThrow(LoanConfigError);
      await expect(getLoanConfigValues()).rejects.toThrow(/could not be read/);
    });

    it('THROWS when the document exists but carries no feeRate', async () => {
      mockConfigGet.mockResolvedValue(snapshot({ updatedBy: 'admin-1' }));

      await expect(getLoanConfigValues()).rejects.toThrow(LoanConfigError);
    });

    it('THROWS when feeRate is not a number', async () => {
      mockConfigGet.mockResolvedValue(snapshot({ feeRate: '0.3' }));

      await expect(getLoanConfigValues()).rejects.toThrow(/must be a finite number/);
    });

    it('THROWS when feeRate is NaN', async () => {
      mockConfigGet.mockResolvedValue(snapshot({ feeRate: Number.NaN }));

      await expect(getLoanConfigValues()).rejects.toThrow(/must be a finite number/);
    });

    it('THROWS on the fat-finger case: a rate above the hard ceiling', async () => {
      // 3.0 rather than 0.3 — 300%. This must be impossible to price against
      // even if it somehow reached the document (console edit, backup restore).
      mockConfigGet.mockResolvedValue(snapshot({ feeRate: 3.0 }));

      await expect(getLoanConfigValues()).rejects.toThrow(/outside the permitted range/);
    });

    it('THROWS on a negative rate', async () => {
      mockConfigGet.mockResolvedValue(snapshot({ feeRate: -0.1 }));

      await expect(getLoanConfigValues()).rejects.toThrow(/outside the permitted range/);
    });

    it('never returns a value when it throws — no silent default anywhere', async () => {
      for (const bad of [{ feeRate: 3 }, { feeRate: -1 }, { feeRate: null }, {}]) {
        mockConfigGet.mockResolvedValue(snapshot(bad));
        await expect(getLoanConfigValues()).rejects.toBeInstanceOf(LoanConfigError);
      }
    });
  });

  describe('bounds are inclusive at both ends', () => {
    it('accepts exactly the floor', async () => {
      mockConfigGet.mockResolvedValue(snapshot({ feeRate: MIN_ALLOWED_FEE_RATE }));
      await expect(getLoanConfigValues()).resolves.toMatchObject({
        feeRate: MIN_ALLOWED_FEE_RATE,
      });
    });

    it('accepts exactly the ceiling', async () => {
      mockConfigGet.mockResolvedValue(snapshot({ feeRate: MAX_ALLOWED_FEE_RATE }));
      await expect(getLoanConfigValues()).resolves.toMatchObject({
        feeRate: MAX_ALLOWED_FEE_RATE,
      });
    });

    it('rejects a hair above the ceiling', async () => {
      mockConfigGet.mockResolvedValue(snapshot({ feeRate: MAX_ALLOWED_FEE_RATE + 0.0001 }));
      await expect(getLoanConfigValues()).rejects.toThrow(/outside the permitted range/);
    });
  });
});

describe('bounds constants', () => {
  it('are the ratified 0 .. 0.35 window', () => {
    expect(MIN_ALLOWED_FEE_RATE).toBe(0);
    expect(MAX_ALLOWED_FEE_RATE).toBe(0.35);
  });

  it('contain the seed rate — the shipped default must itself be legal', () => {
    expect(LOAN_FEE_RATE).toBeGreaterThanOrEqual(MIN_ALLOWED_FEE_RATE);
    expect(LOAN_FEE_RATE).toBeLessThanOrEqual(MAX_ALLOWED_FEE_RATE);
  });
});

describe('assertValidFeeRate', () => {
  it('returns the rate unchanged when valid', () => {
    expect(assertValidFeeRate(0.25, 'ctx')).toBe(0.25);
  });

  it('names the context in the message so the audit trail says WHERE it failed', () => {
    expect(() => assertValidFeeRate(9, 'Proposal abc123')).toThrow(/^Proposal abc123:/);
  });

  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['a numeric string', '0.3'],
    ['undefined', undefined],
    ['null', null],
    ['an object', { feeRate: 0.3 }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertValidFeeRate(value, 'ctx')).toThrow(LoanConfigError);
  });
});
