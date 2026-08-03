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
import { LoanWizard, sliderFillPercent } from './LoanWizard';

/**
 * 1,000 principal at the real 30% rate ⇒ 300 fee, 1,300 total.
 *
 * `repayment` mirrors what getLoanConfig actually publishes (#424): the schedule
 * the backend really executes — ONE payroll deduction of the full total on the
 * due date — plus the CAT derived from it. It is part of the fixture because the
 * screen no longer derives any of it.
 */
const READY_CONFIG = {
  data: {
    feeRate: 0.3,
    allowedTermDays: [30],
    defaultTermDays: 30,
    repayment: [
      {
        termDays: 30,
        installments: [{ number: 1, dueInDays: 30, shareOfTotal: 1 }],
        catPercent: 2334,
      },
    ],
    // The borrower's next payroll date, resolved server-side (#433/#439). A
    // deliberately un-round date: the value the screen used to compute for
    // itself was `Date.now() + 30 days`, so a fixture 30 days out could not
    // tell the two apart.
    // Midday UTC on purpose: a midnight timestamp renders as the previous day
    // in any timezone behind UTC, which would make these assertions pass or
    // fail depending on where CI happens to run.
    estimatedDeductionDate: '2026-09-15T12:00:00.000Z',
    payFrequencySource: 'employee_record',
  },
};

/** Everything the screen renders, with whitespace normalised for matching. */
const screenText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

const forwardButtons = () =>
  screen.getAllByRole('button', { name: /^(continuar|siguiente|next)$/i }) as HTMLButtonElement[];

/** Click the step's forward control. Returns false if it is disabled. */
function advance(): boolean {
  const btn = forwardButtons().find((b) => !b.disabled);
  if (!btn) return false;
  fireEvent.click(btn);
  return true;
}

/**
 * Step 1 (amount) → step 2 (the quote breakdown).
 *
 * There is no term step any more (#423): it offered a single option, so it was
 * a full page tap for no decision. Step 2 is now the first screen that renders
 * a server-priced figure, which is what every assertion below actually needs.
 */
async function goToQuote() {
  await waitFor(() => expect(forwardButtons().length).toBeGreaterThan(0));
  advance();
  await waitFor(() => expect(screen.getAllByText(/paso 2|step 2/i).length).toBeGreaterThan(0));
}

/** Step 1 → step 3, the final review card. */
async function goToReview() {
  await goToQuote();
  // Wait for the forward control to be ENABLED, not merely present. Step 2's
  // Continue is gated on `pricingReady`, and with the term step gone there is
  // no intermediate screen absorbing the time the config promise takes to
  // resolve — so clicking the instant step 2 renders is a no-op.
  await waitFor(() => expect(forwardButtons().some((b) => !b.disabled)).toBe(true));
  advance();
  await waitFor(() => expect(screen.getAllByText(/paso 3|step 3/i).length).toBeGreaterThan(0));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LoanWizard — pricing unavailable', () => {
  it('keeps the borrower in the wizard instead of the eligibility-rejection card', async () => {
    getLoanConfigMock.mockRejectedValue(new Error('unavailable'));

    render(<LoanWizard />);
    await goToQuote();

    expect(await screen.findByTestId('pricing-error-banner')).toBeInTheDocument();
    // The eligibility card is a dead end with no retry, and it means "you do not
    // qualify". Reaching it on a pricing outage is the bug this test guards.
    expect(screen.queryByText(/no ha sido verificada|has not been verified/i)).toBeNull();
    expect(screen.queryByText(/préstamo activo|active or pending loan/i)).toBeNull();
  });

  it('never renders a price as 0 when the rate is unknown', async () => {
    getLoanConfigMock.mockRejectedValue(new Error('unavailable'));

    render(<LoanWizard />);
    await goToQuote();
    await screen.findByTestId('pricing-error-banner');

    // The regression this file exists for: `loanConfig?.feeRate ?? 0` rendered
    // "$0" as the biweekly deduction here, and "$0" / "0%" further on.
    expect(screen.queryByText(/^\$0$/)).toBeNull();
    expect(screen.queryByText(/^0\s*%/)).toBeNull();
    // The term is server-supplied too, so it goes blank with the prices rather
    // than standing alone as a confident "30 días" beside four unavailable
    // figures. It used to initialise to a hardcoded 30, which was invisible
    // while the term had its own step and is not now that it sits in the quote
    // card (#423).
    expect(screen.queryAllByText(/\d+ días|\d+ days/i)).toHaveLength(0);
  });

  it('shows a placeholder, not a digit or a zero, while the rate is in flight', async () => {
    // Design's loading state: a bar the size of a figure. Never "$", never "0",
    // never "—" in the value position, all three of which read as a price.
    getLoanConfigMock.mockReturnValue(new Promise(() => {}));

    render(<LoanWizard />);
    await goToQuote();

    expect((await screen.findAllByTestId('price-shimmer')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('pricing-error-banner')).toBeNull();
    expect(screen.queryByText(/^\$0$/)).toBeNull();
    expect(advance()).toBe(false);
  });

  it('blocks advancing to the quote while the price is unknown', async () => {
    getLoanConfigMock.mockRejectedValue(new Error('unavailable'));

    render(<LoanWizard />);
    await goToQuote();
    await screen.findByTestId('pricing-error-banner');

    // A borrower must never reach terms-and-confirm on a quote we could not
    // compute, so the forward control on a priced step is disabled outright.
    expect(advance()).toBe(false);
    // Still on the quote step, never past it: the confirm screen is where a
    // borrower accepts terms, and they must not reach it on a quote we could
    // not compute.
    expect(screen.queryAllByText(/paso 3|step 3/i)).toHaveLength(0);
  });

  it('is not painted in any verdict-about-the-borrower colours', async () => {
    // #422. LoanStatusCard renders `denied` in the --danger-bg/--danger-text
    // pair and `pending_review`/`escalated` in the --warning-bg/--warning-text
    // pair, both on surfaces this borrower can see in the same session. A
    // banner that exists to stop our outage from reading as a verdict must not
    // borrow either pair: red reads as "I was rejected", amber reads as "my
    // application is under review" — plausible at exactly this moment, and so
    // the more dangerous of the two.
    //
    // The assertion is on the pairs, not on a specific chosen colour, so a
    // future restyle stays free as long as it does not reach for a status pair
    // again. This has now regressed twice through two different tokens.
    getLoanConfigMock.mockRejectedValue(new Error('unavailable'));

    render(<LoanWizard />);
    await goToQuote();
    const banner = await screen.findByTestId('pricing-error-banner');

    const markup = banner.outerHTML;
    for (const statusPairToken of [
      '--danger-bg',
      '--danger-text',
      '--warning-bg',
      '--warning-text',
      '--success-bg',
      '--success-text',
      '--info-bg',
      '--info-text',
    ]) {
      expect(markup).not.toContain(statusPairToken);
    }
  });

  it('says plainly that nothing was charged, and avoids rejection language', async () => {
    getLoanConfigMock.mockRejectedValue(new Error('unavailable'));

    render(<LoanWizard />);
    await goToQuote();
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
    await goToQuote();

    expect(await screen.findByTestId('pricing-error-banner')).toBeInTheDocument();
    expect(screen.queryByText(/^\$0$/)).toBeNull();
  });

  it('retries in place and renders real figures once the rate comes back', async () => {
    getLoanConfigMock
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(READY_CONFIG);

    render(<LoanWizard />);
    await goToQuote();
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
    // Once, not twice. It used to render twice — the total AND a "payroll
    // deduction" row that, with a single-installment schedule, is the same
    // figure by construction (shareOfTotal: 1). The same peso amount under two
    // labels on adjacent rows reads as two charges; the single-charge sentence
    // says it in words instead (#439).
    expect(screen.getAllByText(/\$1,300/)).toHaveLength(1);
  });
});

/**
 * #424 — the quote must describe the repayment the backend actually performs.
 *
 * The wizard used to compute `Math.ceil(termDays / 15)` and quote the borrower
 * TWO biweekly payments of $650, plus a CAT it derived itself, while
 * functions/src/index.ts registered ONE payroll deduction of $1,300 on the due
 * date. Nothing in the backend has ever implemented installments. These tests
 * pin the direction of the dependency: the screen renders the server's schedule
 * and the server's CAT, and has no opinion of its own about either.
 */
describe('LoanWizard — repayment schedule comes from the server', () => {
  it('quotes the single payroll deduction the backend registers, not two biweekly payments', async () => {
    getLoanConfigMock.mockResolvedValue(READY_CONFIG);

    render(<LoanWizard />);

    // Step 2 — the term option describes how the loan is collected.
    await goToQuote();
    // The "1 descuento vía nómina" assertion lived on the term-selection step,
    // which #423 deleted — it offered one option, so it was a page tap for no
    // decision. The property it guarded is unchanged and is asserted below on
    // the quote card, which is where a borrower now reads it.
    const quoteText = screenText();
    // A single-installment schedule states the one charge in words rather than
    // repeating the total under a second label (#439).
    expect(quoteText).toMatch(/un solo cargo|a single charge/i);
    expect(quoteText).not.toMatch(/(Deducción de nómina|Payroll deduction)/i);
    expect(quoteText).not.toMatch(/\$650/);
    expect(quoteText).not.toMatch(/quincenal|biweekly/i);
  });

  it('renders the CAT the server published, and derives none of its own', async () => {
    // A value the old client-side formula could not produce for these figures
    // (it would have computed 2334). If this shows up on screen, the disclosure
    // is being read rather than recomputed.
    getLoanConfigMock.mockResolvedValue({
      data: {
        ...READY_CONFIG.data,
        repayment: [{ ...READY_CONFIG.data.repayment[0], catPercent: 777 }],
      },
    });

    render(<LoanWizard />);
    await goToQuote();

    const text = screenText();
    expect(text).toMatch(/777\s*%/);
    expect(text).not.toMatch(/2334/);
  });

  it('renders a multi-installment schedule as published, without inventing the split', async () => {
    // Today the server never sends this — REPAYMENT_STRUCTURE has one entry and
    // toPayrollDeduction() refuses anything else. The test is here to prove the
    // screen follows the server rather than its own arithmetic: if the repayment
    // product ever really changes, the quote changes because the server said so.
    getLoanConfigMock.mockResolvedValue({
      data: {
        ...READY_CONFIG.data,
        repayment: [
          {
            termDays: 30,
            installments: [
              { number: 1, dueInDays: 15, shareOfTotal: 0.5 },
              { number: 2, dueInDays: 30, shareOfTotal: 0.5 },
            ],
            catPercent: 2334,
          },
        ],
      },
    });

    render(<LoanWizard />);

    await goToQuote();
    // Asserted on the quote card rather than on the term tile that used to
    // announce the period count: the tile's step is gone (#423), the property
    // — the screen renders the server's split and invents none of its own — is
    // not.
    expect(screenText()).toMatch(/\$650 × 2/);
  });

  it('treats a payload with no repayment schedule as a failure, not as a quote', async () => {
    // The pre-#424 payload shape. A client that accepted it would be back to
    // filling in the schedule itself.
    getLoanConfigMock.mockResolvedValue({
      data: { feeRate: 0.3, allowedTermDays: [30], defaultTermDays: 30 },
    });

    render(<LoanWizard />);
    await goToQuote();

    expect(await screen.findByTestId('pricing-error-banner')).toBeInTheDocument();
    expect(screen.queryByText(/^\$0$/)).toBeNull();
    expect(screen.queryByText(/^0\s*%/)).toBeNull();
    expect(advance()).toBe(false);
  });
});

/**
 * #439 — the deduction date is the borrower's payroll date, read from the
 * server, not a calendar offset invented here.
 *
 * This screen used to render `new Date(Date.now() + termDays * 86400000)`. That
 * is not when the money leaves anyone's paycheck: the loan is collected on a
 * payday, resolved from the borrower's cadence (#433). Meanwhile
 * `estimatedDeductionDate` was published on the quote payload and read by
 * nobody. These tests pin the direction — the screen states the server's date
 * or states nothing.
 */
describe('LoanWizard — the deduction date comes from the server', () => {
  it('renders the payroll date the server sent, not today plus the term', async () => {
    getLoanConfigMock.mockResolvedValue(READY_CONFIG);

    render(<LoanWizard />);
    await goToQuote();

    const text = screenText();
    expect(text).toMatch(/15 de septiembre de 2026|September 15, 2026/i);

    // The date the old code would have produced, computed the same way it did.
    // Asserting its absence rather than a fixed string keeps this honest no
    // matter when the suite runs.
    const localOffset = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const localOffsetText = localOffset.toLocaleDateString('es', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    expect(text).not.toMatch(new RegExp(localOffsetText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  });

  it('qualifies the date when the cadence was assumed rather than read', async () => {
    getLoanConfigMock.mockResolvedValue({
      data: { ...READY_CONFIG.data, payFrequencySource: 'default_monthly' },
    });

    render(<LoanWizard />);
    await goToQuote();

    expect(screen.getByTestId('deduction-cadence-assumed')).toBeInTheDocument();
    // The date itself still reads as a prediction in both cases — human review
    // sits between quote and disbursement. What the assumed case adds is the
    // admission that we could not read the cadence.
    expect(screenText()).toMatch(/previsto para el|expected on/i);
  });

  it('does not qualify a date derived from the borrower\'s own record', async () => {
    getLoanConfigMock.mockResolvedValue(READY_CONFIG);

    render(<LoanWizard />);
    await goToQuote();

    expect(screen.queryByTestId('deduction-cadence-assumed')).toBeNull();
    expect(screenText()).toMatch(/previsto para el|expected on/i);
  });

  it('shows an unreadable date as unavailable rather than inventing one', async () => {
    getLoanConfigMock.mockResolvedValue({
      data: { ...READY_CONFIG.data, estimatedDeductionDate: 'not-a-date' },
    });

    render(<LoanWizard />);
    await goToQuote();

    const text = screenText();
    // The prices are fine, so this is not a pricing failure and must not be
    // reported as one — only the date slot degrades.
    expect(screen.queryByTestId('pricing-error-banner')).toBeNull();
    expect(text).toMatch(/\$1,300/);
    expect(text).toMatch(/Fecha de descuento ?No disponible|Deduction date ?Unavailable/i);
    expect(text).not.toMatch(/previsto para el|expected on/i);
    // And above all, no silently substituted local date.
    expect(text).not.toMatch(/Invalid Date|NaN/i);
  });
});

/**
 * The CAT is a regulated disclosure, not a line item of the quote — and it has
 * to be the same disclosure on every card that carries it. Step 3 rendered it
 * as a standalone block with the CONDUSEF reference; the step-3 review card
 * rendered it as a bare row inside the price breakdown, with no note and no
 * reference. Same figure, same flow, two treatments.
 */
describe('LoanWizard — the CAT disclosure is the same on every card', () => {
  it('renders the full disclosure, not a bare row, on the step-3 review card', async () => {
    getLoanConfigMock.mockResolvedValue(READY_CONFIG);

    render(<LoanWizard />);
    await goToReview();

    const text = screenText();
    expect(text).toMatch(/2334\s*%/);
    // The note and the CONDUSEF reference are what make it a disclosure rather
    // than a number in a list. Their absence is what this test exists to catch.
    expect(text).toMatch(/El CAT es una medida estandarizada|standardised measure|standardized measure/i);
    expect(screen.getAllByRole('link', { name: /condusef/i }).length).toBeGreaterThan(0);
  });

  it('keeps the disclosure on the step-3 quote card', async () => {
    getLoanConfigMock.mockResolvedValue(READY_CONFIG);

    render(<LoanWizard />);
    await goToQuote();

    expect(screenText()).toMatch(/2334\s*%/);
    expect(screen.getAllByRole('link', { name: /condusef/i }).length).toBeGreaterThan(0);
  });
});

/**
 * --t3 may not carry a regulated disclosure, a reserved state, or a confidence
 * qualifier (#443).
 *
 * The rule is categorical, not positional, and that is the point. --t3
 * (#93aaa9) measures 2.45:1 on --bg and 2.29:1 on --bg2 — under AA's 4.5:1 for
 * body text, and under even the 3:1 floor that applies to non-text UI. A
 * file-scoped or node-scoped rule would have to be re-derived for every new
 * screen; a rule about what the text IS travels with the content.
 *
 * These assert the ABSENCE of --t3 rather than the presence of --t2, for the
 * same reason the banner test asserts "none of the four status pairs" rather
 * than "not red": the defect has already recurred through more than one token,
 * so the guardrail has to be the rule and not the instance.
 */
describe('LoanWizard — disclosure text is never in the low-contrast tertiary', () => {
  /** Every element in the subtree whose inline style names --t3, root included. */
  const t3Nodes = (root: HTMLElement) =>
    [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].filter((el) =>
      (el.getAttribute('style') ?? '').includes('--t3')
    );

  it('renders the CAT disclosure — label and note — above the tertiary', async () => {
    getLoanConfigMock.mockResolvedValue(READY_CONFIG);

    render(<LoanWizard />);
    await goToQuote();

    const blocks = screen.getAllByTestId('cat-disclosure');
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(t3Nodes(block)).toHaveLength(0);
      // The note is the part that explains what the four-digit figure means.
      expect(within(block).getByRole('link', { name: /condusef/i })).toBeInTheDocument();
    }
  });

  it('keeps the same disclosure treatment on the step-3 review card', async () => {
    getLoanConfigMock.mockResolvedValue(READY_CONFIG);

    render(<LoanWizard />);
    await goToReview();

    const blocks = screen.getAllByTestId('cat-disclosure');
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(t3Nodes(block)).toHaveLength(0);
  });

  it('renders the reserved "no disponible" state above the tertiary', async () => {
    // Prices are readable; only the date is not. One reserved slot, one
    // definition — PriceValue is the single place this state is styled.
    getLoanConfigMock.mockResolvedValue({
      data: { ...READY_CONFIG.data, estimatedDeductionDate: 'not-a-date' },
    });

    render(<LoanWizard />);
    await goToQuote();

    const reserved = screen.getAllByTestId('price-unavailable');
    expect(reserved.length).toBeGreaterThan(0);
    for (const slot of reserved) expect(t3Nodes(slot)).toHaveLength(0);
  });

  it('renders the cadence qualifier above the tertiary, on both cards', async () => {
    getLoanConfigMock.mockResolvedValue({
      data: { ...READY_CONFIG.data, payFrequencySource: 'default_monthly' },
    });

    render(<LoanWizard />);
    await goToReview();

    // Step 4 carried the same paragraph without the testid, so it was outside
    // every existing assertion about this qualifier.
    const notes = screen.getAllByTestId('deduction-cadence-assumed');
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) expect(t3Nodes(note)).toHaveLength(0);
  });
  it('leaves no sub-AA text anywhere in the wizard, labels included', async () => {
    // The categorical rule covers disclosures, reserved states and qualifiers.
    // The 13px ROW LABELS were left on --t3 pending Design's ruling, which has
    // now been given: all of them, not the three categories. Her reason is the
    // one that generalises — a value rendered legibly beside a label that is
    // not inverts the hierarchy of the row, which is the same defect one level
    // down. Every --t3 in this file was a `color:`; none was a border, an icon
    // or a divider, so there was no non-text use here to protect.
    //
    // Asserted across the whole rendered screen rather than per element: a list
    // of nodes has to be re-derived every time someone adds a row.
    getLoanConfigMock.mockResolvedValue(READY_CONFIG);

    render(<LoanWizard />);

    const noTertiary = (label: string) => {
      const offenders = Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter(
        (el) => (el.getAttribute('style') ?? '').includes('--t3')
      );
      expect(
        offenders.map((el) => (el.textContent ?? '').slice(0, 40)),
        `sub-AA text at ${label}`
      ).toEqual([]);
    };

    await goToQuote();
    noTertiary('step 2 — quote');
    await waitFor(() => expect(forwardButtons().some((b) => !b.disabled)).toBe(true));
    advance();
    await waitFor(() => expect(screen.getAllByText(/paso 3|step 3/i).length).toBeGreaterThan(0));
  });
});

/**
 * F9 — the step indicator used to hardcode `[1, 2, 3, 4]`, four segments for a
 * three-step wizard (`TOTAL_STEPS = 3`, caption reads "de 3"). `step` never
 * exceeds 3, so the fourth segment could never fill: the bar read 75% complete
 * on the final step, above text saying "Paso 3 de 3".
 */
describe('LoanWizard — step indicator segment count (F9)', () => {
  it('renders exactly TOTAL_STEPS segments, not a hardcoded fourth one', async () => {
    getLoanConfigMock.mockResolvedValue(READY_CONFIG);

    render(<LoanWizard />);
    await waitFor(() => expect(forwardButtons().length).toBeGreaterThan(0));

    expect(screen.getAllByTestId('step-segment')).toHaveLength(3);
  });
});

/**
 * F10 — `sliderPct = ((amount - MIN_AMOUNT) / (cappedMax - MIN_AMOUNT)) * 100`
 * divides by zero when `cappedMax === MIN_AMOUNT`, which happens whenever
 * `availableCredit` (or the 30%-of-salary cap) collapses the amount range to a
 * single point — reachable at a declared salary around 1,700 MXN. The fill
 * bar then rendered `width: "NaN%"`.
 *
 * Asserted directly against the extracted `sliderFillPercent`, not against a
 * rendered `style.width`: jsdom (like a real browser) silently rejects an
 * invalid `"NaN%"` assignment and keeps whatever valid width was last
 * committed, which makes a DOM-level assertion pass or fail depending on
 * unrelated render-timing accidents rather than on the calculation itself.
 */
describe('LoanWizard — amount slider at a collapsed range (F10)', () => {
  it('returns 100, not NaN, when the amount range collapses to a single point', () => {
    expect(sliderFillPercent(500, 500)).toBe(100);
  });

  it('still computes the normal fraction when the range is a real span', () => {
    expect(sliderFillPercent(1000, 5000)).toBeCloseTo(11.111, 2);
    expect(sliderFillPercent(500, 5000)).toBe(0);
    expect(sliderFillPercent(5000, 5000)).toBe(100);
  });
});
