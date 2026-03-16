export interface CurpValidationRequest {
  curp: string;
  expectedName?: string;
}

export interface CurpValidationResult {
  valid: boolean;
  curp: string;
  fullName?: string;
  dateOfBirth?: string;
  stateOfBirth?: string;
  gender?: 'M' | 'F';
  nationality?: string;
  matchesExpectedName?: boolean;
  source: 'cache' | 'renapo_api';
  validatedAt: string;
}

export interface RenapoApiResponse {
  statusOper: string;
  nombre: string;
  primerApellido: string;
  segundoApellido: string;
  fechaNacimiento: string;
  claveEntidadRegistro: string;
  sexo: 'H' | 'M';
  nacionalidad: string;
}
