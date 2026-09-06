/**
 * Typed wrappers over the Cloud Functions callables these screens use.
 * Input/output shapes mirror the web app's usage (public-v2 LoanWizard,
 * MyLoans, PaymentModal), which mirrors functions/src/index.ts — the server
 * is the single source of truth; these types are documentation with teeth,
 * not a contract the server owes us.
 */
import { httpsCallable } from 'firebase/functions';

import { functions } from '../lib/firebase';

export interface LoanConfig {
  feeRate: number;
  defaultTermDays?: number;
  repayment: unknown[];
  [key: string]: unknown;
}

export interface RequestLoanInput {
  amount: number;
  employerCode: string;
  bankAccountClabe: string;
  termsAccepted: true;
  termDays: number;
  loanPurpose?: string;
}

export interface RequestLoanResult {
  loanId: string;
  loanRef?: string;
  status: string;
  message: string;
}

export async function fetchLoanConfig(): Promise<LoanConfig> {
  const call = httpsCallable<Record<string, never>, LoanConfig>(functions, 'getLoanConfig');
  const result = await call();
  const config = result.data;
  // Same refusal the web app makes (#424): a response without a usable rate
  // and repayment schedule is a failure, not a quote — a borrower must never
  // see a rate nobody approved, and never a blank where a rate should be.
  if (
    !config ||
    typeof config.feeRate !== 'number' ||
    !Array.isArray(config.repayment) ||
    config.repayment.length === 0
  ) {
    throw new Error('loan config unavailable');
  }
  return config;
}

export async function submitLoanRequest(input: RequestLoanInput): Promise<RequestLoanResult> {
  const call = httpsCallable<RequestLoanInput, RequestLoanResult>(functions, 'requestLoan');
  const result = await call(input);
  return result.data;
}

export async function fetchPaymentUrl(loanId: string): Promise<string> {
  const call = httpsCallable<{ loanId: string }, { paymentUrl: string }>(
    functions,
    'generatePaymentLink'
  );
  const result = await call({ loanId });
  const url = result.data?.paymentUrl;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('payment link unavailable');
  }
  return url;
}
