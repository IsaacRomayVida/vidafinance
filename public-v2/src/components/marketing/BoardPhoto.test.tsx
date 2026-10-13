/**
 * Board photographs sit below the fold: nothing of theirs may be requested
 * while the page loads, or it competes with the hero image (the LCP). The
 * still and the film are only given a source once the board is near the
 * viewport, and the film never carries an eagerly fetched `poster`.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardPhoto } from './BoardPhoto';
import { NEAR_VIEWPORT_MARGIN } from '../../hooks/useNearViewport';
import { stubIntersectionObserver, type FakeObserver } from '../../test/intersectionObserver';
import { BOARD_PLACEHOLDERS } from './boardPlaceholders';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

let observers: FakeObserver[];

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  observers = stubIntersectionObserver();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderBoard = () =>
  render(<BoardPhoto still="/images/brand/moment-school-walk.webp" film="/video/board-trust-walk.mp4" />);

describe('BoardPhoto', () => {
  it('requests neither the still nor the film while the board is far from the viewport', () => {
    const { container } = renderBoard();
    const img = container.querySelector('img') as HTMLImageElement;
    const video = container.querySelector('video') as HTMLVideoElement;

    expect(img.hasAttribute('src')).toBe(false);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(video.hasAttribute('src')).toBe(false);
    expect(video.hasAttribute('poster')).toBe(false);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();

    // It is watching its own frame, a screen or so ahead of the viewport.
    expect(observers).toHaveLength(1);
    expect(observers[0].targets).toEqual([container.querySelector('.mk-board-film')]);
    expect(observers[0].options?.rootMargin).toBe(NEAR_VIEWPORT_MARGIN);
  });

  it('loads the still and arms the film once the board nears the viewport', () => {
    const { container } = renderBoard();
    act(() => observers[0].enter());

    const img = container.querySelector('img') as HTMLImageElement;
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(img.getAttribute('src')).toBe('/images/brand/moment-school-walk.webp');
    expect(video.getAttribute('src')).toBe('/video/board-trust-walk.mp4');
    expect(video.hasAttribute('poster')).toBe(false);
    expect(video.muted).toBe(true);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
    expect(observers[0].disconnected).toBe(true);
  });

  it('loads straight away where IntersectionObserver does not exist', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { container } = renderBoard();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/images/brand/moment-school-walk.webp');
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/video/board-trust-walk.mp4');
  });

  // A reader who arrives before the still has loaded (a flick, an anchor
  // jump) must not see the scrim over the bare board.
  it('paints an inline copy of the still under it before anything is requested', () => {
    const { container } = renderBoard();
    const frame = container.querySelector('.mk-board-film') as HTMLDivElement;

    expect(container.querySelector('img')?.hasAttribute('src')).toBe(false);
    const placeholder = BOARD_PLACEHOLDERS['/images/brand/moment-school-walk.webp'];
    expect(placeholder).toMatch(/^data:image\/webp;base64,/);
    expect(frame.style.backgroundImage).toContain(placeholder);

    // It stays once the photograph is in: the still simply covers it.
    act(() => observers[0].enter());
    expect(frame.style.backgroundImage).toContain(placeholder);
  });

  it('crops the placeholder the way the still is cropped', () => {
    const { container } = render(<BoardPhoto still="/images/brand/moment-clinic.webp" position="30% 20%" />);
    const frame = container.querySelector('.mk-board-film') as HTMLDivElement;
    expect(frame.style.backgroundPosition).toBe('30% 20%');
    expect((container.querySelector('img') as HTMLImageElement).style.objectPosition).toBe('30% 20%');

    const css = readFileSync(resolve(__dirname, '../../styles/marketing.css'), 'utf8');
    const rule = css.match(/\.mk-board-film\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('background-size:cover');
    expect(rule).toContain('background-position:50% 50%');
  });
});

describe('board placeholders', () => {
  const srcDir = resolve(__dirname, '../..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
    });
  const stillsInUse = sources(srcDir).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/<BoardPhoto\s[^>]*?still="([^"]+)"/g)].map((m) => m[1]),
  );

  it('exist for every still a board uses', () => {
    expect(stillsInUse.length).toBeGreaterThanOrEqual(2);
    for (const still of stillsInUse) expect(BOARD_PLACEHOLDERS[still], still).toBeTruthy();
  });

  it('are real WebP images small enough to inline', () => {
    for (const [still, uri] of Object.entries(BOARD_PLACEHOLDERS)) {
      // The file it stands in for is in public/.
      expect(statSync(resolve(srcDir, '../public', '.' + still)).isFile()).toBe(true);
      const bytes = Buffer.from(uri.replace(/^data:image\/webp;base64,/, ''), 'base64');
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
      expect(bytes.length).toBeLessThan(400);
    }
  });
});
