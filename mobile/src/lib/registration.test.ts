import { describe, expect, it } from 'vitest';

import { buildEmployeeDoc, type RegistrationData } from './registration';

const base: RegistrationData = {
  name: 'María López García',
  email: 'maria@correo.com',
  password: 'secreta1',
  phone: '55 1234 5678',
  dateOfBirth: '1990-01-15',
  curp: '',
  employerId: 'employer-uid-1',
  employerName: 'Acme SA de CV',
  employerCode: 'acme01',
  monthlySalary: 15000,
  payFrequency: 'semimonthly',
  employmentTenure: '2-5y',
  bankClabe: '002010077777777771',
  kycStatus: 'pending_review',
  metamapVerificationId: '',
  metamapIdentityId: '',
};

const stamp = () => 'STAMP';

describe('buildEmployeeDoc — firestore.rules contract', () => {
  it('never contains a key from noSelfAssignedCredit or noSelfAssignedVerification', () => {
    const withKyc = buildEmployeeDoc(
      { ...base, metamapVerificationId: 'v1', metamapIdentityId: 'i1' },
      stamp
    );
    const withoutKyc = buildEmployeeDoc(base, stamp);
    const banned = [
      'creditLimit',
      'availableCredit',
      'creditLimitSetAt',
      'salarySource',
      'riskTier',
      'mlScore',
      'metamapStatus',
      'metamapVerifiedAt',
      'metamapLastEventAt',
    ];
    for (const key of banned) {
      expect(withKyc).not.toHaveProperty(key);
      expect(withoutKyc).not.toHaveProperty(key);
    }
  });

  it('only ever writes a rules-legal kycStatus value', () => {
    for (const status of ['not_started', 'pending_review', 'rejected'] as const) {
      expect(buildEmployeeDoc({ ...base, kycStatus: status }, stamp).kycStatus).toBe(status);
    }
    // 'approved' is not representable through the type; assert the runtime
    // value is passed through untouched so a future widening gets caught.
    const doc = buildEmployeeDoc(base, stamp);
    expect(['not_started', 'pending_review', 'rejected']).toContain(doc.kycStatus);
  });

  it('OMITS metamap keys entirely when there is no verification id (never writes "")', () => {
    const doc = buildEmployeeDoc(base, stamp);
    expect('metamapVerificationId' in doc).toBe(false);
    expect('metamapIdentityId' in doc).toBe(false);
    expect('kycStartedAt' in doc).toBe(false);
  });

  it('writes metamap ids + kycStartedAt together when verification ran', () => {
    const doc = buildEmployeeDoc(
      { ...base, metamapVerificationId: 'verif-1', metamapIdentityId: 'ident-1' },
      stamp
    );
    expect(doc.metamapVerificationId).toBe('verif-1');
    expect(doc.metamapIdentityId).toBe('ident-1');
    expect(doc.kycStartedAt).toBe('STAMP');
  });

  it('matches the web payload shape field-for-field', () => {
    const doc = buildEmployeeDoc(base, stamp);
    expect(doc).toEqual({
      name: 'María López García',
      email: 'maria@correo.com',
      phone: '55 1234 5678',
      dateOfBirth: '1990-01-15',
      curp: '',
      gender: null,
      rfc: '',
      employerId: 'employer-uid-1',
      employerName: 'Acme SA de CV',
      employerCode: 'ACME01',
      monthlySalary: 15000,
      payFrequency: 'semimonthly',
      employmentTenure: '2-5y',
      bankClabe: '002010077777777771',
      kycStatus: 'pending_review',
      createdAt: 'STAMP',
    });
  });

  it('uppercases employerCode and curp; keeps bankClabe a string', () => {
    const doc = buildEmployeeDoc({ ...base, curp: 'lopm900115mdfxxx01' }, stamp);
    expect(doc.employerCode).toBe('ACME01');
    expect(doc.curp).toBe('LOPM900115MDFXXX01');
    expect(typeof doc.bankClabe).toBe('string');
  });

  it('never writes totalEmployees or any employer-side field (the E2 regression)', () => {
    const doc = buildEmployeeDoc(base, stamp);
    expect(doc).not.toHaveProperty('totalEmployees');
  });
});
