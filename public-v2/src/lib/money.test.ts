import { describe, expect, it } from 'vitest';
import { formatCents, parsePesosToCents } from './money';

describe('formatCents', () => {
  it('renders integer centavos as pesos with two decimals and es-MX grouping', () => {
    expect(formatCents(123456)).toBe('1,234.56');
    expect(formatCents(50000)).toBe('500.00');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(0)).toBe('0.00');
  });
});

describe('parsePesosToCents', () => {
  it('reads plain, grouped and $-prefixed amounts', () => {
    expect(parsePesosToCents('1234')).toBe(123400);
    expect(parsePesosToCents('1234.5')).toBe(123450);
    expect(parsePesosToCents('1234.56')).toBe(123456);
    expect(parsePesosToCents('1,234.56')).toBe(123456);
    expect(parsePesosToCents(' $ 12,345,678.90 ')).toBe(1234567890);
    expect(parsePesosToCents('0')).toBe(0);
  });

  it('never goes through a float: amounts that misbehave as n * 100 come out exact', () => {
    // 1.15 * 100 === 114.99999999999999, 4.35 * 100 === 434.99999999999994
    expect(parsePesosToCents('1.15')).toBe(115);
    expect(parsePesosToCents('4.35')).toBe(435);
    expect(parsePesosToCents('1005.10')).toBe(100510);
  });

  it('rejects what is not unambiguously an amount instead of guessing', () => {
    for (const bad of ['', '   ', 'abc', '12.345', '1.234,56', '1,23.45', '12,34', '-5', '+5', '1e3', '12.', '.50', '12 34', '$']) {
      expect(parsePesosToCents(bad), bad).toBeNull();
    }
  });
});
