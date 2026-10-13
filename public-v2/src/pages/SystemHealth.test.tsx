/**
 * SystemHealth — overlapping fetchHealth calls.
 *
 * fetchHealth() is called from three places that can legitimately overlap:
 * the mount effect, its own 60s setInterval, and the manual refresh button.
 * Before the requestIdRef guard, a slow response from an older call could
 * resolve after a newer one and clobber it — the ops dashboard would then
 * show a stale health snapshot with no way to tell it was stale. This pins
 * that a call that resolves out of order cannot win.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

let resolvers: Array<(v: unknown) => void> = [];

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => () => new Promise((resolve) => { resolvers.push(resolve); })),
}));

import '../i18n';
import { SystemHealth } from './SystemHealth';

describe('SystemHealth — a stale in-flight refresh cannot overwrite a newer result', () => {
  beforeEach(() => {
    resolvers = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the later call's data even when the earlier call resolves after it", async () => {
    render(<SystemHealth />);

    // Mount fires call #1 (left pending). Advancing past the 60s interval
    // fires call #2 while #1 is still in flight — the exact overlap
    // requestIdRef exists to survive.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolvers).toHaveLength(2);

    // Resolve out of order: the newer call (#2) first, the stale one (#1)
    // after.
    // 'degraded'/'down' both render their `detail` string verbatim (only
    // 'ok' overrides it to a fixed "Healthy"), so distinct detail text is
    // what tells the two responses apart on screen.
    resolvers[1]({
      data: {
        railway: [{ name: 'pdf-generator', status: 'degraded', detail: 'fresh-note' }],
        config: {},
        firestoreHealth: null,
        checkedAt: 'second',
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    resolvers[0]({
      data: {
        railway: [{ name: 'pdf-generator', status: 'down', detail: 'STALE-note' }],
        config: {},
        firestoreHealth: null,
        checkedAt: 'first',
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.queryByText('STALE-note')).toBeNull();
    expect(screen.getByText('fresh-note')).toBeTruthy();
  });
});
