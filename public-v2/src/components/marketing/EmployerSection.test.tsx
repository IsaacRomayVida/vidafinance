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
});
