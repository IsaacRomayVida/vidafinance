import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicAsset } from './publicAsset';

describe('publicAsset', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('leaves root paths unchanged when the base is /', () => {
    vi.stubEnv('BASE_URL', '/');
    expect(publicAsset('/video/live-kitchen.mp4')).toBe('/video/live-kitchen.mp4');
  });

  it('prefixes root paths with a holding-portal base', () => {
    vi.stubEnv('BASE_URL', '/funpay/web/');
    expect(publicAsset('/video/live-kitchen.mp4')).toBe('/funpay/web/video/live-kitchen.mp4');
  });

  it('leaves absolute and relative URLs alone', () => {
    vi.stubEnv('BASE_URL', '/funpay/web/');
    expect(publicAsset('https://cdn.example.com/a.mp4')).toBe('https://cdn.example.com/a.mp4');
    expect(publicAsset('video/a.mp4')).toBe('video/a.mp4');
  });
});
