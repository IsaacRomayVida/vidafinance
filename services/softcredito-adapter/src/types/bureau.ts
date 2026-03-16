export interface BureauQueryRequest {
  curp: string;
  fullName: string;
  dateOfBirth: string;
  rfc?: string;
}

export interface BureauQueryResult {
  found: boolean;
  riskScore?: number;
  openAccounts?: number;
  totalDebt?: number;
  paymentHistory?: 'good' | 'irregular' | 'bad';
  fraudFlags?: string[];
  source: 'cache' | 'softcredito_api';
  queriedAt: string;
}

export interface SoftcreditoApiResponse {
  encontrado?: boolean;
  score?: number;
  cuentasAbiertas?: number;
  deudaTotal?: number;
  historialPagos?: string;
  alertasFraude?: string[];
}
