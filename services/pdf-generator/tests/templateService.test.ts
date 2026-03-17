import { renderTemplate, getAvailableTemplates } from '../src/services/templateService';

describe('templateService', () => {
  describe('getAvailableTemplates', () => {
    it('returns all four templates', () => {
      const templates = getAvailableTemplates();
      expect(templates).toContain('contract');
      expect(templates).toContain('receipt');
      expect(templates).toContain('deduction-report');
      expect(templates).toContain('portfolio-report');
      expect(templates).toHaveLength(4);
    });
  });

  describe('renderTemplate — contract', () => {
    it('renders loan contract with correct fields', () => {
      const html = renderTemplate('contract', {
        loanId: 'ABC12345',
        issuedDate: '17/03/2026',
        dueDate: '16/04/2026',
        employeeName: 'Juan Perez',
        employerName: 'ACME Corp',
        amount: '5,000.00',
        fee: '1,500.00',
        total: '6,500.00',
        cat: '1355',
        sofomRfc: 'VIDA240101XXX',
        sofomAddress: 'Reforma 250, CDMX',
      });

      expect(html).toContain('ABC12345');
      expect(html).toContain('Juan Perez');
      expect(html).toContain('ACME Corp');
      expect(html).toContain('$5,000.00 MXN');
      expect(html).toContain('$1,500.00 MXN');
      expect(html).toContain('$6,500.00 MXN');
      expect(html).toContain('1355% sin IVA');
      expect(html).toContain('VIDA240101XXX');
      expect(html).toContain('CONTRATO DE CR');
    });
  });

  describe('renderTemplate — receipt', () => {
    it('renders repayment receipt with correct fields', () => {
      const html = renderTemplate('receipt', {
        loanId: 'DEF67890',
        paymentDate: '17/03/2026',
        employeeName: 'Maria Lopez',
        employerName: 'Tech SA',
        amount: '6,500.00',
        reference: 'REF-123456',
        paymentMethod: 'Descuento via nomina',
        sofomRfc: 'VIDA240101XXX',
        sofomAddress: 'Reforma 250, CDMX',
      });

      expect(html).toContain('DEF67890');
      expect(html).toContain('Maria Lopez');
      expect(html).toContain('$6,500.00 MXN');
      expect(html).toContain('REF-123456');
      expect(html).toContain('COMPROBANTE DE PAGO');
    });
  });

  describe('renderTemplate — deduction-report', () => {
    it('renders deduction report with employee rows', () => {
      const html = renderTemplate('deduction-report', {
        employerName: 'ACME Corp',
        employerRfc: 'ACM010101XXX',
        periodLabel: 'marzo 2026',
        generatedDate: '17/03/2026',
        reportId: 'DED-ABC123',
        totalEmployees: 2,
        totalLoans: 2,
        totalAmount: '13,000.00',
        deductions: [
          {
            rowNum: 1,
            employeeName: 'Juan Perez',
            employeeNumber: 'EMP-001',
            loanFolio: 'AAAA1111',
            loanAmount: '5,000.00',
            deductionAmount: '6,500.00',
            remainingBalance: '6,500.00',
            dueDate: '16/04/2026',
          },
          {
            rowNum: 2,
            employeeName: 'Maria Lopez',
            employeeNumber: 'EMP-002',
            loanFolio: 'BBBB2222',
            loanAmount: '5,000.00',
            deductionAmount: '6,500.00',
            remainingBalance: '6,500.00',
            dueDate: '16/04/2026',
          },
        ],
        clabe: '012345678901234567',
        sofomRfc: 'VIDA240101XXX',
        sofomAddress: 'Reforma 250, CDMX',
      });

      expect(html).toContain('ACME Corp');
      expect(html).toContain('ACM010101XXX');
      expect(html).toContain('Juan Perez');
      expect(html).toContain('Maria Lopez');
      expect(html).toContain('$13,000.00');
      expect(html).toContain('REPORTE DE DEDUCCIONES');
      expect(html).toContain('012345678901234567');
    });
  });

  describe('renderTemplate — portfolio-report', () => {
    it('renders portfolio report with KPIs and employer table', () => {
      const html = renderTemplate('portfolio-report', {
        periodLabel: 'marzo 2026',
        generatedDate: '17/03/2026',
        reportId: 'PORT-ABC123',
        totalPortfolio: '100,000.00',
        activeLoans: 15,
        delinquencyRate: '6.7',
        activeEmployers: 3,
        monthlyDisbursed: '50,000.00',
        monthlyCollected: '45,000.00',
        currentCount: 14,
        currentAmount: '93,300.00',
        overdue30Count: 1,
        overdue30Amount: '6,700.00',
        overdue60Count: 0,
        overdue60Amount: '0.00',
        overdue90Count: 0,
        overdue90Amount: '0.00',
        overdueOver90Count: 0,
        overdueOver90Amount: '0.00',
        employers: [
          {
            rowNum: 1,
            name: 'ACME Corp',
            activeLoans: 10,
            currentPortfolio: '65,000.00',
            overduePortfolio: '5,000.00',
            delinquencyRate: '10.0',
          },
        ],
        sofomRfc: 'VIDA240101XXX',
        sofomAddress: 'Reforma 250, CDMX',
      });

      expect(html).toContain('REPORTE MENSUAL DE CARTERA');
      expect(html).toContain('$100,000.00');
      expect(html).toContain('6.7%');
      expect(html).toContain('ACME Corp');
      expect(html).toContain('$50,000.00');
    });
  });

  describe('renderTemplate — unknown template', () => {
    it('throws for unknown template name', () => {
      expect(() => renderTemplate('nonexistent' as any, {})).toThrow('Unknown template');
    });
  });
});
