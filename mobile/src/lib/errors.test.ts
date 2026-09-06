import { describe, expect, it } from 'vitest';

import { friendlyError, GENERIC_ERROR } from './errors';

describe('friendlyError', () => {
  it('maps known auth codes to Spanish copy', () => {
    expect(friendlyError({ code: 'auth/invalid-credential' })).toBe(
      'Correo o contraseña incorrectos.'
    );
  });

  it('passes through a server-authored callable message', () => {
    expect(friendlyError({ code: 'functions/invalid-argument', message: 'Plazo inválido' })).toBe(
      'Plazo inválido'
    );
  });

  it('never shows functions/internal details — the server did not author that message', () => {
    expect(friendlyError({ code: 'functions/internal', message: 'INTERNAL' })).toBe(GENERIC_ERROR);
  });

  it('falls back to the generic line for anything unrecognized', () => {
    expect(friendlyError(new Error('boom'))).toBe(GENERIC_ERROR);
    expect(friendlyError(undefined)).toBe(GENERIC_ERROR);
    expect(friendlyError('string error')).toBe(GENERIC_ERROR);
  });
});
