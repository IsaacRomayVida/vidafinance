import { initializeApp } from 'firebase-admin/app';

initializeApp();

// ── Health ──────────────────────────────────────────────────────────────────────
export { api } from './health/api';

// ── Loans ───────────────────────────────────────────────────────────────────────
export { requestLoan } from './loans/requestLoan';
export { updateLoanStatus } from './loans/updateLoanStatus';
export { markLoanDisbursed } from './loans/markLoanDisbursed';
export { onLoanStatusChange } from './loans/onLoanStatusChange';
export { onLoanApproved } from './loans/onLoanApproved';

// ── Payments ────────────────────────────────────────────────────────────────────
export { generatePaymentLink } from './payments/generatePaymentLink';

// ── Employers ───────────────────────────────────────────────────────────────────
export { approveEmployer } from './employers/approveEmployer';
export { getEmployerDashboard } from './employers/getEmployerDashboard';

// ── Employees ───────────────────────────────────────────────────────────────────
export { getEmployeeDashboard } from './employees/getEmployeeDashboard';

// ── Admin ───────────────────────────────────────────────────────────────────────
export { setAdminClaim, revokeAdminClaim } from './admin/adminClaims';
export { getAdminDashboard } from './admin/getAdminDashboard';
export { getPortfolioReport } from './admin/getPortfolioReport';

// ── Contact ─────────────────────────────────────────────────────────────────────
export { submitContactForm } from './contact/submitContactForm';

// ── Scheduled ───────────────────────────────────────────────────────────────────
export { dailyLoanCheck } from './scheduled/dailyLoanCheck';
export { weeklyPortfolioSnapshot } from './scheduled/weeklyPortfolioSnapshot';
export { systemHealthCheck } from './scheduled/systemHealthCheck';
export { queueHealthCheck } from './scheduled/queueHealthCheck';
