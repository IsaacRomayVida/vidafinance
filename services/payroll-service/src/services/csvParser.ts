import { parse } from 'csv-parse';
import { Readable } from 'stream';

// ── Canonical field names ────────────────────────────────────────────────────

export type CanonicalField =
  | 'employee_rfc'
  | 'employee_name'
  | 'employee_number'
  | 'department'
  | 'gross_salary'
  | 'net_salary'
  | 'pay_period'
  | 'bank_clabe'
  | 'email'
  | 'position';

// ── Spanish + English aliases for each canonical field ──────────────────────

const FIELD_ALIASES: Record<CanonicalField, string[]> = {
  employee_rfc: [
    'rfc', 'r.f.c.', 'clave rfc', 'tax id', 'rfc code',
    'curp/rfc', 'clave del rfc', 'identificacion fiscal',
  ],
  employee_name: [
    'nombre', 'nombre completo', 'empleado', 'name', 'employee name',
    'full name', 'nombre del empleado', 'nombre empleado',
  ],
  employee_number: [
    'no. empleado', 'número de empleado', 'numero de empleado',
    'clave empleado', 'employee number', 'employee id',
    'no empleado', 'num empleado', 'clave del empleado', 'id empleado',
    'no. de empleado', 'núm. empleado',
  ],
  department: [
    'departamento', 'área', 'area', 'department', 'depto',
    'depto.', 'area de trabajo',
  ],
  gross_salary: [
    'salario bruto', 'sueldo bruto', 'gross salary', 'gross pay',
    'sueldo', 'percepciones brutas', 'total percepciones',
    'salario', 'remuneracion bruta',
  ],
  net_salary: [
    'salario neto', 'sueldo neto', 'net salary', 'net pay',
    'neto', 'sueldo neto a pagar', 'remuneracion neta',
    'importe neto', 'total neto',
  ],
  pay_period: [
    'período', 'periodo', 'período de pago', 'pay period', 'period',
    'periodo de pago', 'fecha periodo', 'fecha de pago', 'quincena',
    'periodo nomina', 'periodo de nomina',
  ],
  bank_clabe: [
    'clabe', 'cuenta clabe', 'clabe interbancaria', 'bank clabe',
    'clabe account', 'clave interbancaria', 'numero clabe',
    'numero de clabe', 'clabeinterbancaria',
  ],
  email: [
    'correo', 'correo electrónico', 'correo electronico',
    'email', 'email address', 'e-mail', 'mail',
  ],
  position: [
    'puesto', 'cargo', 'position', 'job title', 'plaza',
    'puesto de trabajo', 'categoria', 'categoría',
  ],
};

export type FieldMapping = Partial<Record<CanonicalField, string>>;

/**
 * Auto-detect field mapping from CSV headers.
 * Returns a map of canonical field → actual CSV column name.
 */
export function detectFieldMapping(headers: string[]): FieldMapping {
  const mapping: FieldMapping = {};
  const normalizedHeaders = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));

  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES) as [CanonicalField, string[]][]) {
    for (let i = 0; i < normalizedHeaders.length; i++) {
      if (aliases.includes(normalizedHeaders[i])) {
        mapping[canonical] = headers[i];
        break;
      }
    }
  }
  return mapping;
}

export interface RawPayrollRow {
  employee_rfc?: string;
  employee_name?: string;
  employee_number?: string;
  department?: string;
  gross_salary?: number;
  net_salary?: number;
  pay_period?: string;
  bank_clabe?: string;
  email?: string;
  position?: string;
  _rowIndex: number;
  _raw: Record<string, string>;
}

export interface ParseResult {
  headers: string[];
  fieldMapping: FieldMapping;
  rows: RawPayrollRow[];
  totalRows: number;
}

function parseNumeric(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const cleaned = val.replace(/[$,\s]/g, '').replace(/,/g, '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? undefined : n;
}

/**
 * Parse CSV buffer into structured rows using auto-detected or provided field mapping.
 */
export async function parseCSV(
  csvBuffer: Buffer,
  explicitMapping?: FieldMapping,
): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const records: Record<string, string>[] = [];
    let headers: string[] = [];

    const parser = parse({
      columns: (hdrs: string[]) => {
        headers = hdrs;
        return hdrs;
      },
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    });

    parser.on('readable', () => {
      let record: Record<string, string>;
      while ((record = parser.read()) !== null) {
        records.push(record);
      }
    });

    parser.on('error', reject);

    parser.on('end', () => {
      const fieldMapping = explicitMapping ?? detectFieldMapping(headers);

      const rows: RawPayrollRow[] = records.map((rec, idx) => {
        const row: RawPayrollRow = { _rowIndex: idx + 2, _raw: rec };

        const get = (field: CanonicalField): string | undefined => {
          const col = fieldMapping[field];
          return col ? rec[col] : undefined;
        };

        row.employee_rfc = get('employee_rfc');
        row.employee_name = get('employee_name');
        row.employee_number = get('employee_number');
        row.department = get('department');
        row.bank_clabe = get('bank_clabe');
        row.email = get('email');
        row.position = get('position');
        row.pay_period = get('pay_period');
        row.gross_salary = parseNumeric(get('gross_salary'));
        row.net_salary = parseNumeric(get('net_salary'));

        return row;
      });

      resolve({ headers, fieldMapping, rows, totalRows: records.length });
    });

    const stream = Readable.from(csvBuffer);
    stream.pipe(parser);
  });
}
