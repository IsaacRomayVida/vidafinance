/**
 * The hero film must not compete with its own poster: the poster is the
 * page's LCP image, and the film (0.3–1.8 MB) starts from that exact frame,
 * so it is only requested once the page has finished loading.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeroFilm, type Film } from './HeroFilm';

const REEL: Film[] = [{ film: '/video/hero-dawn-9x16.mp4', still: '/images/brand/hero-dawn-9x16.webp' }];

let readyState: DocumentReadyState;
let reducedMotion: boolean;

beforeEach(() => {
  readyState = 'loading';
  reducedMotion = false;
  vi.spyOn(document, 'readyState', 'get').mockImplementation(() => readyState);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('HeroFilm', () => {
  it('shows the poster at once but requests the film only after the page has loaded', () => {
    const { container } = render(<HeroFilm reel={REEL} className="mk-stage-film tall" />);
    const video = container.querySelector('video') as HTMLVideoElement;

    expect(video.getAttribute('poster')).toBe('/images/brand/hero-dawn-9x16.webp');
    expect(video.hasAttribute('src')).toBe(false);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();

    readyState = 'complete';
    act(() => {
      window.dispatchEvent(new Event('load'));
    });

    expect(video.getAttribute('src')).toBe('/video/hero-dawn-9x16.mp4');
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(true);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('starts the film straight away when mounted after load (client-side navigation)', () => {
    readyState = 'complete';
    const { container } = render(<HeroFilm reel={REEL} />);
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/video/hero-dawn-9x16.mp4');
  });

  it('never requests the film under reduced motion: the still stands alone', () => {
    reducedMotion = true;
    readyState = 'complete';
    const { container } = render(<HeroFilm reel={REEL} />);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/images/brand/hero-dawn-9x16.webp');
  });
});
