import { z } from 'zod';

import { validateInput } from '../validateInput';

/**
 * Characterization tests, not a defect report. validateInput was audited for
 * the ways a thin schema wrapper usually betrays its callers and came back
 * clean under zod 4.3.x; these pin the properties its two callers
 * (contact/submitContactForm, loans/updateLoanStatus) actually depend on, so a
 * zod major bump cannot quietly take them away.
 */
const ContactFormSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  phone: z.string().max(20).optional(),
  subject: z.enum(['general', 'support', 'employer_inquiry', 'partnership', 'complaint']),
  message: z.string().min(10).max(2000),
});

const valid = {
  name: 'Ana',
  email: 'ana@example.mx',
  subject: 'general' as const,
  message: 'Necesito informacion',
};

describe('validateInput', () => {
  it('returns the parsed value for valid input', () => {
    expect(validateInput(ContactFormSchema, valid)).toEqual(valid);
  });

  it('throws invalid-argument naming the offending field', () => {
    expect(() => validateInput(ContactFormSchema, { ...valid, email: 'nope' })).toThrow(
      expect.objectContaining({ code: 'invalid-argument' })
    );
  });

  it('reports every failing field, not just the first', () => {
    try {
      validateInput(ContactFormSchema, { name: 'x', email: 'nope', subject: 'z', message: '' });
      throw new Error('expected validateInput to throw');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('name');
      expect(message).toContain('email');
      expect(message).toContain('subject');
      expect(message).toContain('message');
    }
  });

  it('labels a whole-value failure as "input" rather than an empty path', () => {
    expect(() => validateInput(ContactFormSchema, null)).toThrow(/^input: /);
  });

  // submitContactForm spreads the result straight into a Firestore document,
  // so anything the schema does not name must not survive the parse.
  it('strips unknown keys instead of passing them through', () => {
    const out = validateInput(ContactFormSchema, {
      ...valid,
      status: 'approved',
      isAdmin: true,
    });
    expect(out).toEqual(valid);
    expect(out).not.toHaveProperty('status');
    expect(out).not.toHaveProperty('isAdmin');
  });

  it('does not carry a __proto__ payload into the parsed object', () => {
    const hostile = JSON.parse(
      '{"name":"Ana","email":"ana@example.mx","subject":"general","message":"Necesito informacion","__proto__":{"polluted":"yes"}}'
    );
    const out = validateInput(ContactFormSchema, hostile) as Record<string, unknown>;
    expect(out).toEqual(valid);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  // The message is handed to the client verbatim inside an HttpsError, so a
  // caller-supplied value must not be reflected back into it.
  it('does not echo the rejected value back to the caller', () => {
    const marker = 'X'.repeat(500);
    try {
      validateInput(ContactFormSchema, { ...valid, subject: marker });
      throw new Error('expected validateInput to throw');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toContain(marker);
      expect(message.length).toBeLessThan(500);
    }
  });
});
