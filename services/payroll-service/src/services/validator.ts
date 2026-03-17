import { RawPayrollRow, FieldMapping } from './csvParser';

export interface ValidationError {
  row: number;
  field: string;
  message: string;
}

export interface ValidatedRow extends RawPayrollRow {
  isValid: boolean;
  errors: ValidationError[];
}

const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
const CLABE_REGEX = /^\d{18}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateRfc(rfc: string): boolean {
  return RFC_REGEX.test(rfc.replace(/\s/g, ''));
}

function validateClabe(clabe: string): boolean {
  return CLABE_REGEX.test(clabe.replace(/\s/g, ''));
}

/**
 * Validate a single payroll row. At minimum, employee_name or employee_number
 * must be present. Numeric fields are range-checked. RFC and CLABE are format-validated.
 */
export function validateRow(row: RawPayrollRow, mapping: FieldMapping): ValidatedRow {
  const errors: ValidationError[] = [];

  // Name or number required for identification
  if (!row.employee_name && !row.employee_number) {
    errors.push({
      row: row._rowIndex,
      field: 'employee_name / employee_number',
      message: 'Se requiere nombre o número de empleado para identificar al trabajador',
    });
  }

  // RFC: optional but if provided must be valid format
  if (row.employee_rfc) {
    const clean = row.employee_rfc.replace(/\s/g, '');
    if (!validateRfc(clean)) {
      errors.push({
        row: row._rowIndex,
        field: 'employee_rfc',
        message: `RFC inválido: "${row.employee_rfc}"`,
      });
    }
  }

  // Salary fields: must be positive numbers
  if (mapping.gross_salary !== undefined) {
    if (row.gross_salary === undefined || row.gross_salary === null) {
      errors.push({ row: row._rowIndex, field: 'gross_salary', message: 'Salario bruto no pudo ser procesado' });
    } else if (row.gross_salary < 0) {
      errors.push({ row: row._rowIndex, field: 'gross_salary', message: 'Salario bruto no puede ser negativo' });
    } else if (row.gross_salary > 500000) {
      errors.push({ row: row._rowIndex, field: 'gross_salary', message: 'Salario bruto parece inusualmente alto (>$500,000)' });
    }
  }

  if (mapping.net_salary !== undefined) {
    if (row.net_salary === undefined || row.net_salary === null) {
      errors.push({ row: row._rowIndex, field: 'net_salary', message: 'Salario neto no pudo ser procesado' });
    } else if (row.net_salary < 0) {
      errors.push({ row: row._rowIndex, field: 'net_salary', message: 'Salario neto no puede ser negativo' });
    }
  }

  // Net should not exceed gross
  if (
    row.gross_salary !== undefined &&
    row.net_salary !== undefined &&
    row.net_salary > row.gross_salary * 1.05
  ) {
    errors.push({
      row: row._rowIndex,
      field: 'net_salary',
      message: 'Salario neto supera el salario bruto — revisar datos',
    });
  }

  // CLABE: optional but if provided must be 18 digits
  if (row.bank_clabe) {
    if (!validateClabe(row.bank_clabe)) {
      errors.push({
        row: row._rowIndex,
        field: 'bank_clabe',
        message: `CLABE inválida: debe tener 18 dígitos (encontrado: "${row.bank_clabe}")`,
      });
    }
  }

  // Email: optional but if provided must be valid format
  if (row.email && !EMAIL_REGEX.test(row.email)) {
    errors.push({
      row: row._rowIndex,
      field: 'email',
      message: `Email inválido: "${row.email}"`,
    });
  }

  return { ...row, isValid: errors.length === 0, errors };
}

export function validateRows(rows: RawPayrollRow[], mapping: FieldMapping): ValidatedRow[] {
  return rows.map((row) => validateRow(row, mapping));
}
