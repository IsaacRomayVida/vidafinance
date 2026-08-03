export interface Repayment {
  id: string;
  loanId: string;
  amount: number;
  paidAt?: { seconds: number };
  createdAt?: { seconds: number };
  method?: string;
  status?: string;
  [key: string]: unknown;
}

export interface EmployeeData {
  name?: string;
  email?: string;
  employerName?: string;
  employerId?: string;
  bankClabe?: string;
  creditLimit: number;
  availableCredit: number;
  kycStatus?: string;
  employerCode?: string;
}

export interface Loan {
  id: string;
  amount: number;
  termDays?: number;
  term?: number;
  repaymentAmount?: number;
  total?: number;
  status: string;
  createdAt?: { seconds: number };
  dueDate?: { seconds: number };
  [key: string]: unknown;
}

export const LOAN_PURPOSES = [
  'emergency',
  'medical',
  'education',
  'home_repair',
  'transportation',
  'debt_consolidation',
  'other',
] as const;

export function fmt(n: number): string {
  return n.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
