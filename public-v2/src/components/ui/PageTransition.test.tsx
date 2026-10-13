/**
 * The route fade must not hide the first page — fading the landing route in
 * from opacity 0 delayed first paint and the hero's LCP — and must not pull
 * an animation library into the marketing pages' critical JavaScript.
 */
import { useEffect } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTransition, PAGE_FADE_MS } from './PageTransition';

let reducedMotion: boolean;
const cancel = vi.fn();
const animate = vi.fn<(keyframes: Keyframe[], options: KeyframeAnimationOptions) => { cancel: () => void }>(() => ({ cancel }));

beforeEach(() => {
  reducedMotion = false;
  animate.mockClear();
  cancel.mockClear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // jsdom has no Web Animations API.
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
});

afterEach(() => {
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  vi.unstubAllGlobals();
});

const nav: { go: (to: string) => void } = { go: () => {} };
function Page() {
  const navigate = useNavigate();
  useEffect(() => {
    nav.go = navigate;
  }, [navigate]);
  return <p>page</p>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <PageTransition><Page /></PageTransition>
    </MemoryRouter>,
  );
}

describe('PageTransition', () => {
  it('renders the first route visible: no fade, no opacity 0', () => {
    renderPage();
    const wrapper = screen.getByText('page').parentElement as HTMLElement;
    expect(wrapper.style.opacity).toBe('');
    expect(wrapper.style.willChange).toBe('opacity');
    expect(animate).not.toHaveBeenCalled();
  });

  it('dips out and back in, 0.25s each way, when the route changes', () => {
    renderPage();
    act(() => nav.go('/employers'));

    expect(animate).toHaveBeenCalledTimes(1);
    const [keyframes, options] = animate.mock.calls[0];
    expect(keyframes.map((k) => k.opacity)).toEqual([1, 0, 1]);
    expect(keyframes[0].easing).toBe('ease-in-out');
    expect(keyframes[1].easing).toBe('ease-in-out');
    expect(options.duration).toBe(PAGE_FADE_MS);
    expect(PAGE_FADE_MS).toBe(500);

    // A second navigation interrupts the first fade instead of stacking on it.
    act(() => nav.go('/employees'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(2);
  });

  // Parity with the motion AnimatePresence version this replaced, measured
  // against main 23d03d2 in jsdom: right after navigating / -> /about its
  // exiting wrapper already held the About page at opacity 1 (an <Outlet />
  // renders the current route even inside a held element). So the dip plays
  // on the incoming page, in one wrapper, and nothing of the old page stays.
  it('with an <Outlet /> child, swaps to the new page at once and dips that page', () => {
    function Layout() {
      const navigate = useNavigate();
      useEffect(() => {
        nav.go = navigate;
      }, [navigate]);
      return <main><PageTransition><Outlet /></PageTransition></main>;
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<p>home page</p>} />
            <Route path="/about" element={<p>about page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const main = screen.getByRole('main');
    expect(main.textContent).toBe('home page');

    act(() => nav.go('/about'));

    // One wrapper, holding only the incoming page; the fade ran on it.
    expect(main.children).toHaveLength(1);
    expect(main.textContent).toBe('about page');
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(main.firstElementChild);
    expect(animate.mock.calls[0][0].map((k) => k.opacity)).toEqual([1, 0, 1]);
  });

  it('does not fade when only the hash or query changes', () => {
    renderPage();
    act(() => nav.go('/#how'));
    act(() => nav.go('/?x=1'));
    expect(animate).not.toHaveBeenCalled();
  });

  it('does nothing under reduced motion', () => {
    reducedMotion = true;
    renderPage();
    act(() => nav.go('/employers'));
    expect(animate).not.toHaveBeenCalled();
  });

  it('imports no animation library on the marketing critical path', () => {
    const source = readFileSync(resolve(__dirname, 'PageTransition.tsx'), 'utf8');
    const imports = source.split('\n').filter((l) => l.startsWith('import'));
    expect(imports.join('\n')).not.toMatch(/motion/);
  });
});
