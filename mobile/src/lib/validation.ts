/**
 * Client-side validation for employee registration. Mirrors the web wizard
 * (public-v2/src/pages/Onboarding.tsx) exactly — these are UX gates; the
 * server and firestore.rules remain the enforcement boundary.
 */

/** Same regex the web wizard uses before hitting checkEmailAvailability. */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Employer access codes: uppercased, 4–8 chars typed (server takes 4–16). */
export function normalizeEmployerCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8);
}

/** Phone gate: at least 10 digits once formatting is stripped. */
export function phoneValid(phone: string): boolean {
  return phone.replace(/\D/g, '').length >= 10;
}

/** Strip everything but digits, +, -, space (the web's keystroke filter). */
export function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+\- ]/g, '');
}

/**
 * Age in full years from an ISO date string (YYYY-MM-DD), with month/day
 * correction. Returns null when the string does not parse.
 */
export function ageFromIso(dateOfBirth: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const now = new Date();
  let age = now.getFullYear() - year;
  const beforeBirthday =
    now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day);
  if (beforeBirthday) age -= 1;
  return age;
}

/** The web wizard's eligibility window, inclusive. */
export function ageEligible(dateOfBirth: string): boolean {
  const age = ageFromIso(dateOfBirth);
  return age !== null && age >= 18 && age <= 65;
}

/**
 * CLABE check-digit validation — the real mod-10 routine, not a length
 * check. Weights 3,7,1 repeat over the first 17 digits; each product is
 * reduced mod 10 before summing; the 18th digit must equal (10 - sum%10)%10.
 */
export function validateClabe(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += (Number(clabe[i]) * weights[i % 3]) % 10;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(clabe[17]);
}

/** Parse the salary input ("15,000" style) into a number; NaN-safe. */
export function parseSalary(raw: string): number {
  const value = parseFloat(raw.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Display-only credit preview. Mirrors the server's formula
 * (EMPLOYEE_CREDIT_SALARY_RATIO = 0.3, EMPLOYEE_CREDIT_CEILING = 5000) —
 * never write the result anywhere; the server derives the real one.
 */
export function previewCreditLine(monthlySalary: number): number {
  return Math.max(Math.min(monthlySalary * 0.3, 5000), 0);
}

export const PAY_FREQUENCIES = ['weekly', 'semimonthly', 'biweekly', 'monthly'] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export const EMPLOYMENT_TENURES = ['<6m', '6m-1y', '1-2y', '2-5y', '5y+'] as const;
export type EmploymentTenure = (typeof EMPLOYMENT_TENURES)[number];

/** CURP: 18 chars, uppercased. Optional at signup (the web writes ''). */
export function normalizeCurp(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 18);
}

export function curpValid(curp: string): boolean {
  return curp === '' || /^[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(curp);
}

/** Digits-only DOB entry that auto-inserts the ISO dashes: 19900115 → 1990-01-15. */
export function formatDobInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

/** Thousands separators as the borrower types: 15000 → 15,000. */
export function formatSalaryInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 7);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
