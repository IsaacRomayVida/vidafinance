/**
 * The employer stage's photograph is a CSS background several screens down
 * the home page. A browser fetches CSS backgrounds during page load wherever
 * they are, so the class that carries the image (`.shown`, marketing.css) is
 * only added once the stage is near the viewport.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../i18n';
import { EmployerSection } from './EmployerSection';
import { BOARD_PLACEHOLDERS } from './boardPlaceholders';
import { stubIntersectionObserver, type FakeObserver } from '../../test/intersectionObserver';

let observers: FakeObserver[];

beforeEach(() => {
  observers = stubIntersectionObserver();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const renderSection = () =>
  render(
    <MemoryRouter>
      <EmployerSection />
    </MemoryRouter>,
  );

describe('EmployerSection — stage photograph', () => {
  it('is held back until the stage nears the viewport', () => {
    const { container } = renderSection();
    const stage = container.querySelector('.mk-panel.stage.photo') as HTMLElement;

    expect(stage).not.toHaveClass('shown');
    expect(observers.map((o) => o.targets)).toContainEqual([stage]);

    act(() => observers.forEach((o) => o.enter()));
    expect(stage).toHaveClass('shown');
  });

  it('only the .shown rule carries the image', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/marketing.css'), 'utf8');
    const rules = css.split('\n').filter((line) => line.includes('stage-employer'));
    expect(rules).toHaveLength(1);
    expect(rules[0].startsWith('.mk-panel.stage.photo.shown{')).toBe(true);
  });

  // A reader who gets to the stage faster than the photograph downloads (a
  // flick, an anchor jump, the End key) arrives while it is still in flight,
  // and a CSS background paints nothing until it has loaded. The stage must
  // never be bare: an inline copy of the photograph is under it throughout.
  it('has a picture under it from the first paint, before and after the photograph is requested', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/marketing.css'), 'utf8');
    const rule = (selector: string) => css.split('\n').find((line) => line.startsWith(`${selector}{`)) ?? '';
    const placeholder = BOARD_PLACEHOLDERS['/images/brand/stage-employer.webp'];
    expect(placeholder).toMatch(/^data:image\/webp;base64,/);

    const { container } = renderSection();
    const stage = container.querySelector('.mk-panel.stage.photo') as HTMLElement;
    expect(stage.style.getPropertyValue('--stage-ph')).toBe(`url("${placeholder}")`);

    // Not near yet: the placeholder is the picture.
    expect(stage).not.toHaveClass('shown');
    expect(rule('.mk-panel.stage.photo')).toContain('var(--stage-ph,none) center/cover');

    // The observer reports the stage in one jump: the photograph is added on
    // top, and the placeholder stays under it until the file has loaded.
    act(() => observers.forEach((o) => o.enter()));
    expect(stage).toHaveClass('shown');
    expect(stage.style.getPropertyValue('--stage-ph')).toBe(`url("${placeholder}")`);
    const shown = rule('.mk-panel.stage.photo.shown');
    const photoAt = shown.indexOf("url('/images/brand/stage-employer.webp') center/cover");
    const placeholderAt = shown.indexOf('var(--stage-ph,none) center/cover');
    expect(photoAt).toBeGreaterThan(-1);
    expect(placeholderAt).toBeGreaterThan(photoAt);
  });
});
