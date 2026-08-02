/**
 * LoanWizard — pricing availability states.
 *
 * Every money figure on the quote (comisión, total, deducción quincenal) and the
 * CAT disclosure are priced by the server-held fee rate. This file pins the three
 * things that must be true when that rate is unavailable:
 *
 *   1. No price ever renders as 0. A zero comisión quotes a free loan and a zero
 *      CAT is a false statement in a legally required disclosure — both are worse
 *      than showing nothing, because both are believable.
 *   2. A failure to READ the rate is never reported in the eligibility-rejection
 *      chrome. That card means "you do not qualify"; this is our outage, and the
 *      borrower is still eligible.
 *   3. The failure is retryable in place, and recovering restores real figures.
 *
 * Firebase is mocked at module scope. `getLoanConfig` is the callable under test;
 * the employee document is stubbed to an eligible borrower so nothing else
 * short-circuits the render.
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getLoanConfigMock = vi.fn();
const navigateMock = vi.fn();

vi.mock('../lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { uid: 'emp-1' } }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: () => getLoanConfigMock,
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  onSnapshot: vi.fn(() => () => {}),
  getDoc: vi.fn(async () => ({
    exists: () => true,
    data: () => ({
      creditLimit: 5000,
      availableCredit: 5000,
      kycStatus: 'approved',
      employerCode: 'ACME',
      employerId: 'acme',
      monthlySalary: 20000,
    }),
  })),
  getDocs: vi.fn(async () => ({ docs: [] })),
}));

import '../i18n';
import { LoanWizard } from './LoanWizard';

/** 1,000 principal at the real 30% rate ⇒ 300 fee, 1,300 total. */
const READY_CONFIG = {
  data: { feeRate: 0.3, allowedTermDays: [30], defaultTermDays: 30 },
};

const forwardButtons = () =>
  screen.getAllByRole('button', { name: /^(continuar|siguiente|next)$/i }) as HTMLButtonElement[];

/** Click the step's forward control. Returns false if it is disabled. */
function advance(): boolean {
  const btn = forwardButtons().find((b) => !b.disabled);
  if (!btn) return false;
  fireEvent.click(btn);
  return true;
}

/** Step 1 (amount) → step 2 (term) → step 3 (the quote breakdown). */
async function goToQuote() {
  await waitFor(() => expect(forwardButtons().length).toBeGreaterThan(0));
  advance();
  await waitFor(() => expect(screen.getAllByText(/paso 2|step 2/i).length).toBeGreaterThan(0));
  advance();
  await waitFor(() => expect(screen.getAllByText(/paso 3|step 3/i).length).toBeGreaterThan(0));
}

/** Step 1 → step 2, the first step that displays a server-priced figure. */
async function goToTermStep() {
  await waitFor(() => expect(forwardButtons().length).toBeGreaterThan(0));
  advance();
  await waitFor(() => expect(screen.getAllByText(/paso 2|step 2/i).length).toBeGreaterThan(0));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LoanWizard — pricing unavailable', () => {
  it('keeps the borrower in the wizard instead of the eligibility-rejection card', async () => {
    getLoanConfigMock.mockRejectedValue(new Error('unavailable'));

    render(<LoanWizard />);
    await goToTermStep();

    expect(await screen.findByTestId('pricing-error-banner')).toBeInTheDocument();
    // The eligibility card is a dead end with no retry, and it means "you do not
    // qualify". Reaching it on a pricing outage is the bug this test guards.
    expect(screen.queryByText(/no ha sido verificada|has not been verified/i)).toBeNull();
    expect(screen.queryByText(/préstamo activo|active or pending loan/i)).toBeNull();
  });

  it('never renders a price as 0 when the rate is unknown', async () => {
    getLoanConfigMock.mockRejectedValue(new Error('unavailable'));

    render(<LoanWizard />);
    await goToTermStep();
    await screen.findByTestId('pricing-error-banner');

    // The regression this file exists for: `loanConfig?.feeRate ?? 0` rendered
    // "$0" as the biweekly deduction here, and "$0" / "0%" further on.
    expect(screen.queryByText(/^\$0$/)).toBeNull();
    expect(screen.queryByText(/^0\s*%/)).toBeNull();
    // The term options are themselves server-supplied, so an unpriced step 2
    // offers no choices at all rather than an empty list, which would read as
    // "no terms are available to you" — a statement about the borrower.
    expect(screen.queryAllByText(/\d+ días|\d+ days/i)).toHaveLength(0);
  });

  it('shows a placeholder, not a digit or a zero, while the rate is in flight', async () => {
    // Design's loading state: a bar the size of a figure. Never "$", never "0",
    // never "—" in the value position, all three of which read as a price.
    getLoanConfigMock.mockReturnValue(new Promise(() => {}));

    render(<LoanWizard />);
    await goToTermStep();

    expect(await screen.findByTestId('price-shimmer')).toBeInTheDocument();
    expect(screen.queryByTestId('pricing-error-banner')).toBeNull();
    expect(screen.queryByText(/^\$0$/)).toBeNull();
    expect(advance()).toBe(false);
  });

  it('blocks advancing to the quote while the price is unknown', async () => {
    getLoanConfigMock.mockRejectedValue(new Error('unavailable'));

    render(<LoanWizard />);
    await goToTermStep();
    await screen.findByTestId('pricing-error-banner');

    // A borrower must never reach terms-and-confirm on a quote we could not
    // compute, so the forward control on a priced step is disabled outright.
    expect(advance()).toBe(false);
    expect(screen.queryAllByText(/paso 3|step 3/i)).toHaveLength(0);
  });

  it('says plainly that nothing was charged, and avoids rejection language', async () => {
    getLoanConfigMock.mockRejectedValue(new Error('unavailable'));

    render(<LoanWizard />);
    await goToTermStep();
    const banner = await screen.findByTestId('pricing-error-banner');

    expect(banner.textContent ?? '').toMatch(/no se te ha cobrado|not been charged/i);
    expect(banner.textContent ?? '').not.toMatch(
      /rechaz|denegad|no calificas|rejected|denied|do not qualify/i
    );
  });

  it('treats a response carrying no usable rate as a failure, not as a quote', async () => {
    // A malformed or partial payload is the one path that could otherwise reach
    // the price slots with status "ready" — a permanent blank with no retry.
    getLoanConfigMock.mockResolvedValue({ data: { allowedTermDays: [30] } });

    render(<LoanWizard />);
    await goToTermStep();

    expect(await screen.findByTestId('pricing-error-banner')).toBeInTheDocument();
    expect(screen.queryByText(/^\$0$/)).toBeNull();
  });

  it('retries in place and renders real figures once the rate comes back', async () => {
    getLoanConfigMock
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(READY_CONFIG);

    render(<LoanWizard />);
    await goToTermStep();
    const banner = await screen.findByTestId('pricing-error-banner');

    fireEvent.click(within(banner).getByRole('button', { name: /reintentar|try again/i }));

    // Recovery is the banner disappearing and the figures arriving. Nothing else
    // announces it — a success toast would frame our own outage as an event.
    await waitFor(() => expect(screen.queryByTestId('pricing-error-banner')).toBeNull());
    expect(screen.queryAllByTestId('price-unavailable')).toHaveLength(0);
    expect(getLoanConfigMock).toHaveBeenCalledTimes(2);
  });
});

describe('LoanWizard — pricing available', () => {
  it('renders the fee and total derived from the server rate', async () => {
    getLoanConfigMock.mockResolvedValue(READY_CONFIG);

    render(<LoanWizard />);
    await goToQuote();

    expect(screen.queryByTestId('pricing-error-banner')).toBeNull();
    expect(screen.getByText(/\$300/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,300/)).toBeInTheDocument();
  });
});
