/**
 * Every refusal reason the remittance callables can send has Spanish (and
 * English) words on this side.
 *
 * The server's `message` is English and written for logs; ops must never be
 * shown it. The list of reasons is a contract that grows on the server
 * (RemittanceRefusalReason in functions/src/payroll/remittance.ts). This test
 * reads that source — parsed, not imported, for the reason given in
 * reviewStatus.parity.test.ts — and fails naming the reason when one is added
 * there without a text here, or a mapped key has no translation.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import en from '../i18n/en.json';
import es from '../i18n/es.json';
import { REMITTANCE_REASON_KEYS, readRemittanceRefusal, remittanceRefusalText } from './remittance';

const REPO_ROOT = resolve(process.cwd(), '..');

function serverReasons(): string[] {
  const source = readFileSync(resolve(REPO_ROOT, 'functions/src/payroll/remittance.ts'), 'utf8');
  const union = source.match(/export type RemittanceRefusalReason =([\s\S]*?);/);
  if (!union) {
    throw new Error(
      'remittanceReasons.parity.test.ts could not find "export type RemittanceRefusalReason = ...;" in ' +
        'functions/src/payroll/remittance.ts. If it was renamed or moved, update this guard.',
    );
  }
  const reasons = [...union[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  if (reasons.length < 20) throw new Error(`Parsed only ${reasons.length} reasons — the union's format changed.`);
  return reasons;
}

/** Interpolates like i18next does for a flat string, so leftovers are visible. */
const translate = (table: Record<string, string>) => (key: string, options: Record<string, unknown> = {}) =>
  (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (name in options ? String(options[name]) : whole));

describe('remittance refusal reasons', () => {
  const reasons = serverReasons();

  it('maps exactly the reasons the server declares', () => {
    expect(Object.keys(REMITTANCE_REASON_KEYS).sort()).toEqual([...reasons].sort());
  });

  it.each(reasons)('%s has its own Spanish and English text', (reason) => {
    const key = REMITTANCE_REASON_KEYS[reason];
    expect(key, `no i18n key mapped for ${reason}`).toBeTruthy();
    const spanish = (es as Record<string, string>)[key];
    const english = (en as Record<string, string>)[key];
    expect(spanish, `es.json has no "${key}"`).toBeTruthy();
    expect(english, `en.json has no "${key}"`).toBeTruthy();
    expect(spanish).not.toBe(english);
  });

  it.each(reasons)('%s renders in Spanish with every placeholder filled and none of the server message', (reason) => {
    const serverMessage = 'receivedOn 2026-03-01 is before the pay period of batch b-1 began (2026-03-05)';
    const refusal = readRemittanceRefusal({
      code: 'functions/invalid-argument',
      message: serverMessage,
      details: { reason, field: 'receivedOn', batchIds: ['b-9'], today: '2026-03-10', payPeriodStart: '2026-03-05' },
    });
    const text = remittanceRefusalText(refusal, translate(es as Record<string, string>), 'es-MX');
    expect(text).toBeTruthy();
    expect(text).not.toMatch(/\{\{|\}\}/);
    expect(text).not.toContain('receivedOn');
    expect(text).not.toContain(serverMessage);
    expect(text).not.toMatch(/^remit_/);
  });

  it('puts the server-supplied facts into the sentence', () => {
    const say = (reason: string, details: Record<string, unknown>) =>
      remittanceRefusalText(
        readRemittanceRefusal({ code: 'functions/invalid-argument', details: { reason, ...details } }),
        translate(es as Record<string, string>),
        'es-MX',
      );
    expect(say('received-on-before-pay-period', { payPeriodStart: '2026-03-05' })).toMatch(/\(5 mar\.? 2026\)/);
    expect(say('received-on-future', { today: '2026-03-10' })).toMatch(/\(10 mar\.? 2026, hora de Ciudad de México\)/);
    expect(say('bank-reference-in-other-batch', { batchIds: ['b-1', 'b-2'] })).toContain('(b-1, b-2)');
  });
});
