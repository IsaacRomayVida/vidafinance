/**
 * PayrollRemittances — the ops screen over the remittance ledger (E18).
 *
 * What is pinned here: the list shows expected / received / outstanding from
 * integer centavos with status and aging; recording a transfer validates on
 * the client the way the server does (amount, real non-future Mexico City
 * date, reference) and sends the exact callable payload; voiding needs a
 * reason and a second, explicit confirmation before anything is sent; voided
 * receipts read as voided; and server refusals are shown in words ops can act
 * on (the duplicate-reference cases in particular) — in Spanish, keyed on the
 * server's `details.reason`, never its English message. The list is paged:
 * "load more" sends the server's cursor and appends, the totals are sums of
 * what is on screen and say so while there is another page, and a void's
 * timestamp is shown as the Mexico City date.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  getDocs: vi.fn(async () => ({
    docs: [{ id: 'emp-hotel', data: () => ({ companyName: 'Hotel Xcaret' }) }],
  })),
}));

type Handler = (args: unknown) => Promise<{ data: unknown }>;
const handlers: Record<string, ReturnType<typeof vi.fn<Handler>>> = {};

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn((_functions: unknown, name: string) => (args: unknown) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected callable ${name}`);
    return handler(args);
  }),
}));

import '../i18n';
import { PayrollRemittances } from './PayrollRemittances';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const receipt = (over: Record<string, unknown> = {}) => ({
  receiptId: 'r-1',
  amountCents: 200000,
  receivedOn: '2026-03-02',
  bankReference: 'SPEI-AAA',
  recordedBy: 'ops-1',
  recordedAt: '2026-03-02T18:00:00.000Z',
  voided: false,
  voidedBy: null,
  voidedAt: null,
  voidReason: null,
  ...over,
});

const overdueBatch = {
  batchId: 'batch-overdue',
  employerId: 'emp-hotel',
  payPeriodStart: '2026-02-01',
  payPeriodEnd: '2026-02-15',
  expectedCents: 1234567,
  receivedCents: 200000,
  status: 'partial',
  deductionCount: 12,
  lastReceivedOn: '2026-03-02',
  aging: { outstandingCents: 1034567, daysSincePeriodEnd: 23, daysOverdue: 16, overdue: true, bucket: 'overdue_16_30' },
  receipts: [
    receipt(),
    receipt({
      receiptId: 'r-void',
      amountCents: 999900,
      bankReference: 'SPEI-ZZZ',
      voided: true,
      voidedBy: 'ops-2',
      voidedAt: '2026-03-03T10:00:00.000Z',
      voidReason: 'Capturado en el lote equivocado',
    }),
  ],
};

const currentBatch = {
  batchId: 'batch-current',
  employerId: 'emp-unknown',
  payPeriodStart: '2026-03-01',
  payPeriodEnd: '2026-03-08',
  expectedCents: 50000,
  receivedCents: 0,
  status: 'expected',
  deductionCount: 1,
  lastReceivedOn: null,
  aging: { outstandingCents: 50000, daysSincePeriodEnd: 2, daysOverdue: 0, overdue: false, bucket: 'current' },
  receipts: [],
};

// `totals` is deliberately nonsense: the server totals one page, the screen
// must show the sum of the rows it holds, so nothing may be read from here.
const listResult = (remittances: unknown[] = [overdueBatch, currentBatch], nextCursor: string | null = null) => ({
  data: {
    asOf: '2026-03-10',
    graceDays: 7,
    pageSize: 50,
    nextCursor,
    truncated: nextCursor !== null,
    totals: { count: 999, expectedCents: 1, receivedCents: 1, outstandingCents: 1, overdueCount: 999, overdueCents: 1 },
    remittances,
  },
});

/** A plain outstanding batch, for filling pages. */
const batch = (batchId: string, expectedCents: number, over: Record<string, unknown> = {}) => ({
  ...currentBatch,
  batchId,
  expectedCents,
  aging: { ...currentBatch.aging, outstandingCents: expectedCents },
  ...over,
});

const kpi = (label: string) => screen.getByText(label, { selector: '.ops-kpi small' }).closest('.ops-kpi') as HTMLElement;

/** The shape the Firebase client throws for an HttpsError. */
function httpsError(code: string, message: string, details?: unknown) {
  return Object.assign(new Error(message), { code: `functions/${code}`, details });
}

const row = (batchId: string) => screen.findByTestId(`remittance-${batchId}`);

async function openRecordDialog(batchId = 'batch-overdue') {
  fireEvent.click(within(await row(batchId)).getByRole('button', { name: /Registrar transferencia/ }));
  return screen.getByRole('dialog');
}

function fillRecordForm(dialog: HTMLElement, v: { amount?: string; date?: string; reference?: string }) {
  const d = within(dialog);
  if (v.amount !== undefined) fireEvent.change(d.getByLabelText('Monto recibido (MXN)'), { target: { value: v.amount } });
  if (v.date !== undefined) fireEvent.change(d.getByLabelText('Fecha en que llegó al banco'), { target: { value: v.date } });
  if (v.reference !== undefined) fireEvent.change(d.getByLabelText('Referencia bancaria'), { target: { value: v.reference } });
}

const submitRecord = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Registrar' }));

beforeEach(() => {
  // Only the clock is faked, so findBy*/waitFor keep polling on real timers.
  // 03:30 UTC on 11 March is 21:30 on 10 March in Mexico City: the evening
  // window where a UTC (or browser-local) "today" is already tomorrow.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-11T03:30:00Z'));

  for (const k of Object.keys(handlers)) delete handlers[k];
  handlers.listPayrollRemittances = vi.fn<Handler>(async () => listResult());
  handlers.recordPayrollRemittance = vi.fn<Handler>(async () => ({
    data: { batchId: 'batch-overdue', receiptId: 'r-new', expectedCents: 1234567, receivedCents: 1234567, status: 'received', createdRecord: false },
  }));
  handlers.voidPayrollRemittanceReceipt = vi.fn<Handler>(async () => ({
    data: { batchId: 'batch-overdue', receiptId: 'r-1', expectedCents: 1234567, receivedCents: 0, status: 'expected', alreadyVoided: false },
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

/* ── list ─────────────────────────────────────────────────────────────────── */

describe('PayrollRemittances — list', () => {
  it('asks for outstanding remittances and shows expected, received and outstanding from centavos', async () => {
    render(<PayrollRemittances />);

    const overdue = within(await row('batch-overdue'));
    expect(handlers.listPayrollRemittances).toHaveBeenCalledWith({ view: 'outstanding', limit: 50 });

    expect(overdue.getByText('$12,345.67')).toBeInTheDocument(); // expected
    expect(overdue.getAllByText('$2,000.00').length).toBeGreaterThan(0); // received (and the receipt)
    expect(overdue.getByText('$10,345.67')).toBeInTheDocument(); // outstanding
    expect(overdue.getByText('Parcial')).toBeInTheDocument();
    expect(overdue.getByText(/Lote batch-overdue · 12 descuentos/)).toBeInTheDocument();
    // Employer name resolved from the employers collection, id as the fallback.
    expect(await overdue.findByText('Hotel Xcaret')).toBeInTheDocument();
    expect(within(await row('batch-current')).getByText('emp-unknown')).toBeInTheDocument();
  });

  it('makes overdue visible on the row and in the totals, and leaves a current batch unflagged', async () => {
    render(<PayrollRemittances />);

    const overduePill = within(await row('batch-overdue')).getByText('Vencida 16 días');
    expect(overduePill.className).toContain('bad');

    const current = within(await row('batch-current'));
    expect(current.getByText('Al corriente')).toBeInTheDocument();
    expect(current.queryByText(/Vencida/)).toBeNull();
    expect(current.getByText('Por recibir')).toBeInTheDocument();

    // Totals are the sum of the rows on screen (the server totals one page only).
    const overdueKpi = kpi('Vencido');
    expect(overdueKpi.className).toContain('warn');
    expect(within(overdueKpi).getByText('$10,345.67')).toBeInTheDocument();
    expect(within(overdueKpi).getByText('1 remesa')).toBeInTheDocument();
    expect(within(kpi('Esperado')).getByText('$12,845.67')).toBeInTheDocument();
    expect(within(kpi('Recibido')).getByText('$2,000.00')).toBeInTheDocument();
    expect(within(kpi('Pendiente')).getByText('$10,845.67')).toBeInTheDocument();
    // One page, nothing more to load: no caveat and no button.
    expect(screen.queryByTestId('remit-totals-partial')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cargar más remesas' })).toBeNull();
  });

  it('shows a voided receipt as voided, with its reason, and offers no void action on it', async () => {
    render(<PayrollRemittances />);
    await row('batch-overdue');

    const voided = screen.getByTestId('receipt-r-void');
    expect(voided).toHaveAttribute('data-voided', 'true');
    expect(within(voided).getByText('Anulado')).toBeInTheDocument();
    expect(within(voided).getByText(/Motivo: Capturado en el lote equivocado/)).toBeInTheDocument();
    // Struck through by `.ops-remit-receipts li.voided .amt` (ops.css).
    expect(voided).toHaveClass('voided');
    expect(within(voided).getByText('$9,999.00')).toHaveClass('amt');
    expect(within(voided).queryByRole('button')).toBeNull();

    const live = screen.getByTestId('receipt-r-1');
    expect(live).toHaveAttribute('data-voided', 'false');
    expect(live).not.toHaveClass('voided');
    expect(within(live).queryByText('Anulado')).toBeNull();
    expect(within(live).getByRole('button', { name: /Anular/ })).toBeInTheDocument();
  });

  it('re-queries with the chosen filters', async () => {
    render(<PayrollRemittances />);
    await row('batch-overdue');

    fireEvent.click(screen.getByRole('button', { name: 'Todas' }));
    await waitFor(() => expect(handlers.listPayrollRemittances).toHaveBeenLastCalledWith({ view: 'all', limit: 50 }));

    fireEvent.click(screen.getByRole('button', { name: 'Solo vencidas' }));
    await waitFor(() =>
      expect(handlers.listPayrollRemittances).toHaveBeenLastCalledWith({ view: 'all', overdueOnly: true, limit: 50 }),
    );
  });

  it('shows when a receipt was voided as the Mexico City date, not the UTC date', async () => {
    // 03:00 UTC on 3 March is 21:00 on 2 March in Mexico City.
    const lateVoid = {
      ...overdueBatch,
      receipts: [receipt({ receiptId: 'r-late', voided: true, voidedBy: 'ops-2', voidedAt: '2026-03-03T03:00:00.000Z', voidReason: 'Duplicado' })],
    };
    handlers.listPayrollRemittances.mockResolvedValue(listResult([lateVoid]));
    render(<PayrollRemittances />);

    const voided = within(await screen.findByTestId('receipt-r-late'));
    expect(voided.getByText(/Anulado el 2 mar\.? 2026/)).toBeInTheDocument();
    expect(voided.queryByText(/Anulado el 3 mar/)).toBeNull();
    // The receipt's own date is a calendar date and is not shifted.
    expect(voided.getByText(/^2 mar\.? 2026$/)).toBeInTheDocument();
  });

  it('says which way the list is ordered: oldest first when outstanding, newest first for all', async () => {
    render(<PayrollRemittances />);
    await row('batch-overdue');
    expect(screen.getByText(/Orden: periodo más antiguo primero\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Todas' }));
    expect(await screen.findByText(/Orden: periodo más reciente primero\./)).toBeInTheDocument();

    // "Only overdue" implies outstanding on the server, whatever the view.
    fireEvent.click(screen.getByRole('button', { name: 'Solo vencidas' }));
    expect(await screen.findByText(/Orden: periodo más antiguo primero\./)).toBeInTheDocument();
  });

  it('says so when nothing is outstanding', async () => {
    handlers.listPayrollRemittances.mockResolvedValue(listResult([]));
    render(<PayrollRemittances />);
    expect(await screen.findByText('No hay remesas pendientes.')).toBeInTheDocument();
  });

  it('shows a load failure in words and lets ops retry', async () => {
    handlers.listPayrollRemittances.mockRejectedValueOnce(httpsError('permission-denied', 'Insufficient permissions'));
    render(<PayrollRemittances />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No pudimos cargar las remesas.');
    expect(alert).toHaveTextContent('No tienes permiso para realizar esta acción.');

    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    await row('batch-overdue');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/* ── record ───────────────────────────────────────────────────────────────── */

describe('PayrollRemittances — recording a transfer', () => {
  it('sends integer centavos, the date and the trimmed reference, then confirms and reloads', async () => {
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog();
    expect(dialog).toHaveTextContent('Hotel Xcaret · lote batch-overdue. Pendiente: $10,345.67 MXN.');

    fillRecordForm(dialog, { amount: '10,345.67', date: '2026-03-10', reference: '  SPEI-NEW-1  ' });
    submitRecord(dialog);

    await waitFor(() => expect(handlers.recordPayrollRemittance).toHaveBeenCalledTimes(1));
    expect(handlers.recordPayrollRemittance).toHaveBeenCalledWith({
      batchId: 'batch-overdue',
      amountCents: 1034567,
      receivedOn: '2026-03-10',
      bankReference: 'SPEI-NEW-1',
    });

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Transferencia de $10,345.67 MXN registrada. La remesa queda: Recibida.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(handlers.listPayrollRemittances).toHaveBeenCalledTimes(2));
  });

  it('blocks an empty form on the client and names each problem', async () => {
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog();
    submitRecord(dialog);

    expect(within(dialog).getByText(/Escribe un monto en pesos/)).toBeInTheDocument();
    expect(within(dialog).getByText('Indica la fecha en que se recibió la transferencia.')).toBeInTheDocument();
    expect(within(dialog).getByText('Indica la referencia bancaria de la transferencia.')).toBeInTheDocument();
    expect(handlers.recordPayrollRemittance).not.toHaveBeenCalled();
  });

  it.each([
    ['12.345', /Escribe un monto en pesos/],
    ['doce mil', /Escribe un monto en pesos/],
    ['0', /mayor que cero/],
    ['0.00', /mayor que cero/],
  ])('rejects the amount %s without calling the server', async (amount, message) => {
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog();
    fillRecordForm(dialog, { amount, date: '2026-03-10', reference: 'SPEI-1' });
    submitRecord(dialog);

    expect(within(dialog).getByText(message)).toBeInTheDocument();
    expect(handlers.recordPayrollRemittance).not.toHaveBeenCalled();
  });

  it('rejects a date after today in Mexico City, even though it is already that date in UTC', async () => {
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog();

    // The clock is 2026-03-11 in UTC but still 2026-03-10 in Mexico City.
    expect(within(dialog).getByLabelText('Fecha en que llegó al banco')).toHaveAttribute('max', '2026-03-10');
    fillRecordForm(dialog, { amount: '100', date: '2026-03-11', reference: 'SPEI-1' });
    submitRecord(dialog);
    expect(within(dialog).getByText(/no puede ser posterior a hoy \(2026-03-10, hora de Ciudad de México\)/)).toBeInTheDocument();
    expect(handlers.recordPayrollRemittance).not.toHaveBeenCalled();

    // The same form with the Mexico City "today" goes through.
    fillRecordForm(dialog, { date: '2026-03-10' });
    submitRecord(dialog);
    await waitFor(() => expect(handlers.recordPayrollRemittance).toHaveBeenCalledTimes(1));
  });

  it('rejects a reference longer than the server accepts', async () => {
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog();
    fillRecordForm(dialog, { amount: '100', date: '2026-03-10', reference: 'X'.repeat(101) });
    submitRecord(dialog);

    expect(within(dialog).getByText('La referencia no puede pasar de 100 caracteres.')).toBeInTheDocument();
    expect(handlers.recordPayrollRemittance).not.toHaveBeenCalled();
  });

  it('warns, without blocking, when the amount is more than what is outstanding', async () => {
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog('batch-current');
    fillRecordForm(dialog, { amount: '500.01' });
    expect(within(dialog).getByText(/quedará como recibida de más/)).toBeInTheDocument();
    fillRecordForm(dialog, { amount: '500.00' });
    expect(within(dialog).queryByText(/quedará como recibida de más/)).toBeNull();
  });

  it('explains a reference already recorded on this batch and offers no way around it', async () => {
    handlers.recordPayrollRemittance.mockRejectedValue(
      httpsError('already-exists', 'Bank reference SPEI-AAA is already recorded for batch batch-overdue', {
        reason: 'bank-reference-in-batch',
        batchIds: ['batch-overdue'],
      }),
    );
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog();
    fillRecordForm(dialog, { amount: '100', date: '2026-03-10', reference: 'SPEI-AAA' });
    submitRecord(dialog);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Esa referencia bancaria ya está registrada en este lote. No se registró de nuevo.');
    expect(within(dialog).queryByRole('button', { name: /la misma transferencia cubre/ })).toBeNull();
    // The dialog stays open with the form intact; nothing was reloaded.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(handlers.listPayrollRemittances).toHaveBeenCalledTimes(1);
  });

  it('names the other batch for a cross-batch duplicate and resends as a shared transfer only when ops says so', async () => {
    handlers.recordPayrollRemittance.mockRejectedValueOnce(
      httpsError('already-exists', 'Bank reference SPEI-AAA is already recorded for batch batch-other', {
        reason: 'bank-reference-in-other-batch',
        batchIds: ['batch-other'],
      }),
    );
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog();
    fillRecordForm(dialog, { amount: '100', date: '2026-03-10', reference: 'SPEI-AAA' });
    submitRecord(dialog);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Esa referencia bancaria ya está registrada en otro lote (batch-other). No se registró.');
    expect(handlers.recordPayrollRemittance).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ sharedTransfer: true }),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, la misma transferencia cubre también este lote' }));
    await waitFor(() => expect(handlers.recordPayrollRemittance).toHaveBeenCalledTimes(2));
    expect(handlers.recordPayrollRemittance).toHaveBeenLastCalledWith({
      batchId: 'batch-overdue',
      amountCents: 10000,
      receivedOn: '2026-03-10',
      bankReference: 'SPEI-AAA',
      sharedTransfer: true,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('registrada');
  });

  it('withdraws the shared-transfer offer once the reference is edited', async () => {
    handlers.recordPayrollRemittance.mockRejectedValueOnce(
      httpsError('already-exists', 'dup', { reason: 'bank-reference-in-other-batch', batchIds: ['batch-other'] }),
    );
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog();
    fillRecordForm(dialog, { amount: '100', date: '2026-03-10', reference: 'SPEI-AAA' });
    submitRecord(dialog);
    await within(dialog).findByRole('button', { name: /la misma transferencia cubre/ });

    fillRecordForm(dialog, { reference: 'SPEI-BBB' });
    expect(within(dialog).queryByRole('button', { name: /la misma transferencia cubre/ })).toBeNull();
  });

  it.each([
    [
      'invalid-argument',
      'receivedOn 2026-03-10 is in the future',
      { reason: 'received-on-future', field: 'receivedOn', today: '2026-03-09' },
      /La fecha no puede ser posterior a hoy \(9 mar\.? 2026, hora de Ciudad de México\)\./,
    ],
    [
      'invalid-argument',
      'receivedOn 2026-01-10 is before the pay period of batch batch-overdue began (2026-02-01)',
      { reason: 'received-on-before-pay-period', field: 'receivedOn', payPeriodStart: '2026-02-01' },
      /La fecha es anterior al inicio del periodo de nómina de este lote \(1 feb\.? 2026\)\. Revisa el año y que sea el lote correcto\./,
    ],
    [
      'invalid-argument',
      'Too small: expected number to be >0',
      { reason: 'amount-invalid', field: 'amountCents' },
      'El monto no es válido. Debe ser mayor que cero, en pesos con hasta dos decimales.',
    ],
    [
      'not-found',
      'No remittance expected for batch batch-overdue',
      { reason: 'remittance-not-expected' },
      'No hay una remesa esperada para este lote: el lote no existe o no tuvo descuentos.',
    ],
    // No reason, or one this screen does not know yet: the generic friendly
    // error — never the server's English sentence.
    ['invalid-argument', 'receivedOn must be a string', undefined, 'Algo salió mal. Por favor inténtalo de nuevo.'],
    ['invalid-argument', 'some new rule', { reason: 'a-reason-added-later' }, 'Algo salió mal. Por favor inténtalo de nuevo.'],
    ['resource-exhausted', 'Too many requests', undefined, 'Demasiadas solicitudes. Por favor espera un minuto e inténtalo de nuevo.'],
    ['permission-denied', 'Insufficient permissions', undefined, 'No tienes permiso para realizar esta acción.'],
  ])('shows a %s refusal (%s) in Spanish', async (code, serverMessage, details, shown) => {
    handlers.recordPayrollRemittance.mockRejectedValue(httpsError(code, serverMessage, details));
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog();
    fillRecordForm(dialog, { amount: '100', date: '2026-03-10', reference: 'SPEI-1' });
    submitRecord(dialog);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(shown);
    expect(alert).not.toHaveTextContent(serverMessage);
    expect(within(dialog).queryByRole('button', { name: /la misma transferencia cubre/ })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('refuses a date before the batch pay period began, before any round trip', async () => {
    render(<PayrollRemittances />);
    const dialog = await openRecordDialog(); // pay period starts 2026-02-01
    fillRecordForm(dialog, { amount: '100', date: '2026-01-31', reference: 'SPEI-1' });
    submitRecord(dialog);

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      /La fecha no puede ser anterior al inicio del periodo de nómina de este lote \(1 feb\.? 2026\)\./,
    );
    expect(handlers.recordPayrollRemittance).not.toHaveBeenCalled();

    // The first day of the period is fine.
    fillRecordForm(dialog, { date: '2026-02-01' });
    submitRecord(dialog);
    await waitFor(() => expect(handlers.recordPayrollRemittance).toHaveBeenCalledTimes(1));
  });
});

/* ── pagination ───────────────────────────────────────────────────────────── */

describe('PayrollRemittances — pages', () => {
  const pageOne = [batch('b-1', 10000), batch('b-2', 20000, { status: 'partial', receivedCents: 5000, aging: { ...currentBatch.aging, outstandingCents: 15000, overdue: true, daysOverdue: 3, bucket: 'overdue_1_15' } })];
  const pageTwo = [batch('b-3', 40000)];

  /** Answers by cursor, like the server: no cursor is page one. */
  const paged = () =>
    vi.fn<Handler>(async (args) => {
      const cursor = (args as { cursor?: string }).cursor;
      if (cursor === undefined) return listResult(pageOne, 'cursor-after-b-2');
      if (cursor === 'cursor-after-b-2') return listResult(pageTwo, null);
      throw httpsError('invalid-argument', 'cursor is not a page cursor for this view', { reason: 'cursor-invalid', field: 'cursor' });
    });

  it('loads the next page with the server cursor, appends it, and re-sums the totals', async () => {
    handlers.listPayrollRemittances = paged();
    render(<PayrollRemittances />);
    await row('b-2');

    // While there is another page the figures are labelled as partial.
    expect(screen.getByRole('heading', { name: '2 remesas cargadas · hay más' })).toBeInTheDocument();
    expect(screen.getByTestId('remit-totals-partial')).toHaveTextContent(
      'Los totales de arriba suman solo las remesas cargadas hasta ahora, no toda la vista.',
    );
    expect(within(kpi('Esperado')).getByText('$300.00')).toBeInTheDocument();
    expect(within(kpi('Vencido')).getByText('$150.00')).toBeInTheDocument();
    expect(screen.queryByTestId('remittance-b-3')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más remesas' }));
    await row('b-3');
    expect(handlers.listPayrollRemittances).toHaveBeenLastCalledWith({ view: 'outstanding', limit: 50, cursor: 'cursor-after-b-2' });

    // Appended in the server's order, nothing replaced.
    const ids = screen.getAllByTestId(/^remittance-/).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['remittance-b-1', 'remittance-b-2', 'remittance-b-3']);
    expect(within(kpi('Esperado')).getByText('$700.00')).toBeInTheDocument();
    expect(within(kpi('Pendiente')).getByText('$650.00')).toBeInTheDocument();

    // Last page: the caveat and the button go away.
    expect(screen.getByRole('heading', { name: '3 remesas' })).toBeInTheDocument();
    expect(screen.queryByTestId('remit-totals-partial')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cargar más remesas' })).toBeNull();
  });

  it('never shows the same batch twice if a page repeats one', async () => {
    handlers.listPayrollRemittances = vi.fn<Handler>(async (args) =>
      (args as { cursor?: string }).cursor ? listResult([pageOne[1], ...pageTwo], null) : listResult(pageOne, 'c'),
    );
    render(<PayrollRemittances />);
    await row('b-2');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más remesas' }));
    await row('b-3');
    expect(screen.getAllByTestId(/^remittance-/)).toHaveLength(3);
  });

  it('starts again from page one, without a cursor, when a filter changes', async () => {
    handlers.listPayrollRemittances = paged();
    render(<PayrollRemittances />);
    await row('b-2');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más remesas' }));
    await row('b-3');

    fireEvent.click(screen.getByRole('button', { name: 'Todas' }));
    await waitFor(() => expect(handlers.listPayrollRemittances).toHaveBeenLastCalledWith({ view: 'all', limit: 50 }));
    // Page one replaced the list: the row that only page two had is gone.
    await waitFor(() => expect(screen.queryByTestId('remittance-b-3')).toBeNull());
    expect(screen.getByRole('button', { name: 'Cargar más remesas' })).toBeInTheDocument();
  });

  it('a refresh reloads from page one and keeps as many rows as were on screen', async () => {
    const many = Array.from({ length: 50 }, (_, i) => batch(`p1-${i}`, 100));
    const more = Array.from({ length: 30 }, (_, i) => batch(`p2-${i}`, 100));
    handlers.listPayrollRemittances = vi.fn<Handler>(async (args) => {
      const { cursor, limit } = args as { cursor?: string; limit: number };
      if (cursor) return listResult(more, null);
      return limit >= 80 ? listResult([...many, ...more], null) : listResult(many, 'c2');
    });
    render(<PayrollRemittances />);
    await row('p1-0');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más remesas' }));
    await row('p2-29');

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(handlers.listPayrollRemittances).toHaveBeenLastCalledWith({ view: 'outstanding', limit: 80 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Actualizar' })).toBeEnabled());
    expect(screen.getAllByTestId(/^remittance-/)).toHaveLength(80);
  });

  it('keeps the loaded rows when the next page fails, says why in Spanish, and offers a reload', async () => {
    handlers.listPayrollRemittances = vi.fn<Handler>(async (args) => {
      if ((args as { cursor?: string }).cursor) {
        throw httpsError('invalid-argument', 'cursor is not a page cursor for this view', { reason: 'cursor-invalid', field: 'cursor' });
      }
      return listResult(pageOne, 'stale-cursor');
    });
    render(<PayrollRemittances />);
    await row('b-2');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más remesas' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'No pudimos cargar más remesas. La página siguiente ya no corresponde a esta vista. Vuelve a cargar la lista desde el inicio.',
    );
    expect(alert).not.toHaveTextContent('cursor is not a page cursor');
    expect(screen.getAllByTestId(/^remittance-/)).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Recargar desde el inicio' }));
    await waitFor(() => expect(handlers.listPayrollRemittances).toHaveBeenLastCalledWith({ view: 'outstanding', limit: 50 }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('drops a late next page that belongs to a view the user has left', async () => {
    let releaseMore: (value: { data: unknown }) => void = () => {};
    handlers.listPayrollRemittances = vi.fn<Handler>((args) => {
      const { cursor, view } = args as { cursor?: string; view: string };
      if (cursor) return new Promise((resolvePage) => { releaseMore = resolvePage; });
      return Promise.resolve(view === 'all' ? listResult([batch('all-1', 100)], null) : listResult(pageOne, 'c'));
    });
    render(<PayrollRemittances />);
    await row('b-2');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más remesas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Todas' }));
    await row('all-1');

    releaseMore(listResult(pageTwo, null));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Actualizar' })).toBeEnabled());
    expect(screen.queryByTestId('remittance-b-3')).toBeNull();
    expect(screen.getAllByTestId(/^remittance-/)).toHaveLength(1);
  });

  it('shows a first-page refusal by its reason, in Spanish', async () => {
    handlers.listPayrollRemittances.mockRejectedValueOnce(
      httpsError('invalid-argument', 'Too big: expected number to be <=500', { reason: 'limit-invalid', field: 'limit' }),
    );
    render(<PayrollRemittances />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No pudimos cargar las remesas. El tamaño de página debe ser un número entero entre 1 y 500.');
    expect(alert).not.toHaveTextContent('Too big');
  });
});

/* ── void ─────────────────────────────────────────────────────────────────── */

describe('PayrollRemittances — voiding a receipt', () => {
  async function openVoidDialog() {
    render(<PayrollRemittances />);
    await row('batch-overdue');
    fireEvent.click(within(screen.getByTestId('receipt-r-1')).getByRole('button', { name: /Anular/ }));
    return screen.getByRole('dialog');
  }

  it('requires a reason before it will even ask for confirmation', async () => {
    const dialog = await openVoidDialog();
    expect(dialog).toHaveTextContent('Recibo de $2,000.00 MXN · SPEI-AAA · lote batch-overdue.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Continuar' }));
    expect(within(dialog).getByText(/Escribe el motivo de la anulación/)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Motivo de la anulación'), { target: { value: '  a ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continuar' }));
    expect(within(dialog).getByText(/Escribe el motivo de la anulación/)).toBeInTheDocument();

    expect(within(dialog).queryByRole('button', { name: 'Sí, anular recibo' })).toBeNull();
    expect(handlers.voidPayrollRemittanceReceipt).not.toHaveBeenCalled();
  });

  it('sends nothing until the second, explicit confirmation — then voids with the trimmed reason', async () => {
    const dialog = await openVoidDialog();
    fireEvent.change(within(dialog).getByLabelText('Motivo de la anulación'), {
      target: { value: '  Transferencia duplicada  ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continuar' }));

    // Confirmation step: says what will change, and still has not called.
    expect(within(dialog).getByText('Confirma la anulación')).toBeInTheDocument();
    expect(within(dialog).getByText(/bajará \$2,000.00 MXN/)).toBeInTheDocument();
    expect(within(dialog).getByText('Motivo: Transferencia duplicada')).toBeInTheDocument();
    expect(handlers.voidPayrollRemittanceReceipt).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, anular recibo' }));
    await waitFor(() => expect(handlers.voidPayrollRemittanceReceipt).toHaveBeenCalledTimes(1));
    expect(handlers.voidPayrollRemittanceReceipt).toHaveBeenCalledWith({
      batchId: 'batch-overdue',
      receiptId: 'r-1',
      reason: 'Transferencia duplicada',
    });

    expect(await screen.findByRole('status')).toHaveTextContent('Recibo anulado. La remesa queda: Por recibir.');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(handlers.listPayrollRemittances).toHaveBeenCalledTimes(2));
  });

  it('lets ops back out of the confirmation without voiding', async () => {
    const dialog = await openVoidDialog();
    fireEvent.change(within(dialog).getByLabelText('Motivo de la anulación'), { target: { value: 'Lote equivocado' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continuar' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Volver' }));

    expect(within(dialog).getByLabelText('Motivo de la anulación')).toHaveValue('Lote equivocado');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(handlers.voidPayrollRemittanceReceipt).not.toHaveBeenCalled();
  });

  it('shows a server refusal on the confirmation step and keeps the dialog open', async () => {
    handlers.voidPayrollRemittanceReceipt.mockRejectedValue(
      httpsError('not-found', 'No receipt r-1 on batch batch-overdue', { reason: 'receipt-not-found' }),
    );
    const dialog = await openVoidDialog();
    fireEvent.change(within(dialog).getByLabelText('Motivo de la anulación'), { target: { value: 'Lote equivocado' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continuar' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, anular recibo' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Ese recibo ya no existe en este lote. Actualiza la lista.');
    expect(alert).not.toHaveTextContent('No receipt r-1');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports a receipt that was already voided as such', async () => {
    handlers.voidPayrollRemittanceReceipt.mockResolvedValue({
      data: { batchId: 'batch-overdue', receiptId: 'r-1', expectedCents: 1234567, receivedCents: 0, status: 'expected', alreadyVoided: true },
    });
    const dialog = await openVoidDialog();
    fireEvent.change(within(dialog).getByLabelText('Motivo de la anulación'), { target: { value: 'Lote equivocado' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continuar' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, anular recibo' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Ese recibo ya estaba anulado.');
  });
});
