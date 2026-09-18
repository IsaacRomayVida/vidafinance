import { describe, expect, it } from 'vitest';

import {
  ageEligible,
  ageFromIso,
  curpValid,
  EMAIL_REGEX,
  normalizeCurp,
  normalizeEmployerCode,
  parseSalary,
  phoneValid,
  previewCreditLine,
  validateClabe,
} from './validation';

describe('validateClabe (mod-10, weights 3-7-1)', () => {
  it('accepts CLABEs with a correct check digit', () => {
    // Check digits computed with the same routine the web wizard ships.
    expect(validateClabe('002010077777777771')).toBe(true);
    expect(validateClabe('032180000118359719')).toBe(true);
  });
  it('rejects a flipped check digit', () => {
    expect(validateClabe('002010077777777770')).toBe(false);
    expect(validateClabe('032180000118359710')).toBe(false);
  });
  it('rejects wrong lengths and non-digits', () => {
    expect(validateClabe('12345678901234567')).toBe(false);
    expect(validateClabe('1234567890123456789')).toBe(false);
    expect(validateClabe('00201007777777777a')).toBe(false);
    expect(validateClabe('')).toBe(false);
  });
});

describe('ageFromIso / ageEligible', () => {
  it('computes age with month/day correction', () => {
    const now = new Date();
    const y = now.getFullYear();
    // Someone born exactly 30 years ago today is 30.
    const today = `${y - 30}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;
    expect(ageFromIso(today)).toBe(30);
  });
  it('rejects <18 and >65, accepts the window inclusive', () => {
    const y = new Date().getFullYear();
    expect(ageEligible(`${y - 10}-01-01`)).toBe(false);
    expect(ageEligible(`${y - 30}-01-01`)).toBe(true);
    expect(ageEligible(`${y - 80}-01-01`)).toBe(false);
  });
  it('rejects junk', () => {
    expect(ageFromIso('yesterday')).toBeNull();
    expect(ageFromIso('1990-13-40')).toBeNull();
    expect(ageEligible('')).toBe(false);
  });
});

describe('email / phone / code / curp / salary', () => {
  it('EMAIL_REGEX matches the web gate', () => {
    expect(EMAIL_REGEX.test('a@b.co')).toBe(true);
    expect(EMAIL_REGEX.test('a@b.c')).toBe(false);
    expect(EMAIL_REGEX.test('a b@c.mx')).toBe(false);
  });
  it('phoneValid needs 10 digits after stripping', () => {
    expect(phoneValid('55 1234 5678')).toBe(true);
    expect(phoneValid('+52 55 1234 5678')).toBe(true);
    expect(phoneValid('12345')).toBe(false);
  });
  it('normalizeEmployerCode uppercases and clamps to 8', () => {
    expect(normalizeEmployerCode('acme01')).toBe('ACME01');
    expect(normalizeEmployerCode('toolongcode123')).toBe('TOOLONGC');
    expect(normalizeEmployerCode('ac me!01')).toBe('ACME01');
  });
  it('curp normalization and shape', () => {
    expect(normalizeCurp('lopm900115mdfxxx01')).toBe('LOPM900115MDFXXX01');
    expect(curpValid('')).toBe(true); // optional at signup, like the web
    expect(curpValid('LOPM900115MDFXXX01')).toBe(true);
    expect(curpValid('NOPE')).toBe(false);
  });
  it('parseSalary strips thousands separators and refuses junk', () => {
    expect(parseSalary('15,000')).toBe(15000);
    expect(parseSalary('0')).toBe(0);
    expect(parseSalary('abc')).toBe(0);
  });
});

describe('input formatters', () => {
  it('formatDobInput inserts ISO dashes as digits arrive', async () => {
    const { formatDobInput } = await import('./validation');
    expect(formatDobInput('1990')).toBe('1990');
    expect(formatDobInput('199001')).toBe('1990-01');
    expect(formatDobInput('19900115')).toBe('1990-01-15');
    expect(formatDobInput('1990-01-15')).toBe('1990-01-15');
  });
  it('formatSalaryInput adds thousands separators', async () => {
    const { formatSalaryInput } = await import('./validation');
    expect(formatSalaryInput('15000')).toBe('15,000');
    expect(formatSalaryInput('1,5000')).toBe('15,000');
    expect(formatSalaryInput('900')).toBe('900');
  });
});

describe('previewCreditLine (display-only mirror of the server formula)', () => {
  it('is 30% of salary capped at 5000', () => {
    expect(previewCreditLine(10000)).toBe(3000);
    expect(previewCreditLine(50000)).toBe(5000);
    expect(previewCreditLine(0)).toBe(0);
  });
});
