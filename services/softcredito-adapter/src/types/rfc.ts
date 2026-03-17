export interface RfcValidationRequest {
  rfc: string;
  expectedName?: string;
}

export interface RfcValidationResult {
  valid: boolean;
  rfc: string;
  legalName?: string;
  type?: 'persona_fisica' | 'persona_moral';
  taxStatus?: string;
  matchesExpectedName?: boolean;
  source: 'cache' | 'sat_api';
  validatedAt: string;
}

export interface SatRfcApiResponse {
  valid: boolean;
  rfc: string;
  razonSocial?: string;
  tipoPersona?: string;
  situacionFiscal?: string;
}
