import crypto from 'crypto';
import {
  buildStpCadena,
  signStpOrder,
  verifyStpSignature,
  validateClabe,
  StpOrder,
} from '../src/lib/stpSigning';

// Generate a fresh key pair for each test run
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const sampleOrder: StpOrder = {
  empresa: 'VIDA SOFOM',
  folioOrigen: 'VIDA-loan123-1700000000000',
  causaDevolucion: '',
  cuenta: '646180110400000007',
  rfcCurpBeneficiario: 'ND',
  nombreBeneficiario: 'Juan Pérez García',
  conceptoPago: 'Prestamo VIDA Finance',
  monto: 2000,
  tipoPago: 1,
  topologia: 'T',
  medioEntrega: 3,
  prioridad: 1,
  iva: 0,
};

describe('buildStpCadena', () => {
  it('should return a pipe-delimited string starting with |', () => {
    const cadena = buildStpCadena(sampleOrder);
    expect(cadena).toMatch(/^\|/);
  });

  it('should include the empresa, folioOrigen, monto, cuenta', () => {
    const cadena = buildStpCadena(sampleOrder);
    expect(cadena).toContain('VIDA SOFOM');
    expect(cadena).toContain('VIDA-loan123-1700000000000');
    expect(cadena).toContain('2000');
    expect(cadena).toContain('646180110400000007');
  });

  it('should produce consistent output for identical input', () => {
    const a = buildStpCadena(sampleOrder);
    const b = buildStpCadena({ ...sampleOrder });
    expect(a).toBe(b);
  });

  it('should produce different output when a field changes', () => {
    const a = buildStpCadena(sampleOrder);
    const b = buildStpCadena({ ...sampleOrder, monto: 3000 });
    expect(a).not.toBe(b);
  });
});

describe('signStpOrder / verifyStpSignature', () => {
  it('should produce a base64 signature', () => {
    const sig = signStpOrder(sampleOrder, privateKey);
    expect(typeof sig).toBe('string');
    // Base64 encoded — no whitespace, valid chars
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('should verify a valid signature', () => {
    const sig = signStpOrder(sampleOrder, privateKey);
    const isValid = verifyStpSignature(sampleOrder, sig, publicKey);
    expect(isValid).toBe(true);
  });

  it('should reject a tampered signature', () => {
    const sig = signStpOrder(sampleOrder, privateKey);
    const tampered = sig.slice(0, -4) + 'XXXX';
    const isValid = verifyStpSignature(sampleOrder, tampered, publicKey);
    expect(isValid).toBe(false);
  });

  it('should reject if order fields change after signing', () => {
    const sig = signStpOrder(sampleOrder, privateKey);
    const modified = { ...sampleOrder, monto: 9999 };
    const isValid = verifyStpSignature(modified, sig, publicKey);
    expect(isValid).toBe(false);
  });

  it('should reject with wrong public key', () => {
    const sig = signStpOrder(sampleOrder, privateKey);
    const { publicKey: wrongPubKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const isValid = verifyStpSignature(sampleOrder, sig, wrongPubKey);
    expect(isValid).toBe(false);
  });
});

describe('validateClabe', () => {
  it('should accept known valid CLABE numbers', () => {
    // Standard CLABE test vectors
    expect(validateClabe('646180110400000007')).toBe(true);
    expect(validateClabe('032180000118359719')).toBe(true);
  });

  it('should reject CLABEs shorter or longer than 18 digits', () => {
    expect(validateClabe('12345678901234567')).toBe(false);   // 17 digits
    expect(validateClabe('1234567890123456789')).toBe(false); // 19 digits
  });

  it('should reject CLABEs with non-digit characters', () => {
    expect(validateClabe('64618011040000000X')).toBe(false);
    expect(validateClabe('64618011040000 007')).toBe(false);
  });

  it('should reject a CLABE with wrong control digit', () => {
    // Flip last digit of a valid CLABE
    expect(validateClabe('646180110400000008')).toBe(false);
  });
});
