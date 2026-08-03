/**
 * A failed read of the review queue must never render as an empty one.
 *
 * The page passed `() => setLoading(false)` as its onSnapshot error handler,
 * discarding the error. The empty branch then rendered "No pending reviews.
 * All caught up." — so a query that failed told the ops team that every
 * borrower waiting on a loan decision had already been dealt with. Silence and
 * "all clear" looked identical, and the queue gates money.
 *
 * This is the rule #503 established for borrower surfaces ("no spinner and no
 * lie when a read fails"), applied to the console, which never got it.
 *
 * The failure mode is live, not hypothetical: the query orders by `queuedAt`
 * ascending, which needs the (status ASC, queuedAt ASC) composite index, and
 * index deploys have been 403'ing since 2026-07-31 on a missing IAM role
 * (#414). A missing index surfaces as FAILED_PRECONDITION, so it lands exactly
 * on this path.
 */
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../i18n';

/** Captures the error callback the page registers, so a test can fire it. */
let errorHandler: ((err: { code?: string; message?: string }) => void) | null = null;
let nextCallback: ((snap: { docs: unknown[] }) => void) | null = null;

vi.mock('../lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { uid: 'ops-1' }, role: 'ops', loading: false }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  onSnapshot: vi.fn((_q: unknown, next: never, error: never) => {
    nextCallback = next;
    errorHandler = error;
    return () => {};
  }),
}));

const { ReviewQueue } = await import('./ReviewQueue');

const ALL_CLEAR = /all caught up/i;

beforeEach(() => {
  errorHandler = null;
  nextCallback = null;
});

describe('ReviewQueue read failure', () => {
  it('registers a real error handler, not a discard', () => {
    render(<ReviewQueue />);
    expect(errorHandler).toBeTypeOf('function');
  });

  it('a missing index does not read as "all caught up"', () => {
    render(<ReviewQueue />);

    act(() => errorHandler!({ code: 'failed-precondition', message: 'The query requires an index.' }));

    expect(screen.queryByText(ALL_CLEAR)).toBeNull();
    // And it must say plainly that this is not a statement about the backlog.
    expect(screen.getByRole('alert').textContent).toMatch(/NO significa que no haya revisiones/i);
  });

  it('any other read failure is surfaced too', () => {
    render(<ReviewQueue />);

    act(() => errorHandler!({ code: 'permission-denied', message: 'Missing or insufficient permissions.' }));

    expect(screen.queryByText(ALL_CLEAR)).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('a genuinely empty queue still says "all caught up"', () => {
    render(<ReviewQueue />);

    // A real, successful read that returned nothing — the one case where the
    // claim is true and should still be made.
    act(() => nextCallback!({ docs: [] }));

    expect(screen.getByText(ALL_CLEAR)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a recovered read clears the banner', () => {
    render(<ReviewQueue />);

    act(() => errorHandler!({ code: 'unavailable', message: 'backend unavailable' }));
    expect(screen.getByRole('alert')).toBeTruthy();

    // onSnapshot retries; a later success must not leave a stale error up.
    act(() => nextCallback!({ docs: [] }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
