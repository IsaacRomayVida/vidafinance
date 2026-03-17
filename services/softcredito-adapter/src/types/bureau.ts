export interface BureauQueryRequest {
  curp: string;
  fullName: string;
  dateOfBirth: string;
  rfc?: string;
}

export interface BureauQueryResult {
  found: boolean;
  cdcScore?: number;
  bdcScore?: number;
  riskScore?: number;
  openAccounts?: number;
  totalDebt?: number;
  paymentHistory?: 'good' | 'irregular' | 'bad';
  scDiasAtraso?: number;
  scCarteraVencida?: boolean;
  fraudFlags?: string[];
  source: 'cache' | 'softcredito_api';
  queriedAt: string;
}

export interface SoftcreditoApiResponse {
  encontrado?: boolean;
  score?: number;
  scoreCDC?: number;
  scoreBDC?: number;
  cuentasAbiertas?: number;
  deudaTotal?: number;
  historialPagos?: string;
  alertasFraude?: string[];
  diasAtraso?: number;
  carteraVencida?: boolean;
  cuentas?: Array<{
    diasAtraso?: number;
    saldoVencido?: number;
  }>;
}
