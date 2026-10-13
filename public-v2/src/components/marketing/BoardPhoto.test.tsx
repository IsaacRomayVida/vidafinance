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
});
