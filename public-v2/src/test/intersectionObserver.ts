/**
 * A controllable IntersectionObserver for tests (jsdom has none): every
 * observer is recorded, and `enter()` reports its targets as intersecting.
 */
import { vi } from 'vitest';

export interface FakeObserver {
  options: IntersectionObserverInit | undefined;
  targets: Element[];
  disconnected: boolean;
  enter(): void;
}

export function stubIntersectionObserver(): FakeObserver[] {
  const observers: FakeObserver[] = [];
  class FakeIntersectionObserver {
    private record: FakeObserver;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = {
        options,
        targets: [],
        disconnected: false,
        enter: () =>
          callback(
            this.record.targets.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry),
            this as unknown as IntersectionObserver,
          ),
      };
      observers.push(this.record);
    }
    observe(el: Element) {
      this.record.targets.push(el);
    }
    unobserve() {}
    disconnect() {
      this.record.disconnected = true;
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  return observers;
}
