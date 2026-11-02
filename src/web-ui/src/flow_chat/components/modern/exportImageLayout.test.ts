// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readExportImageLayout } from './exportImageLayout';

function makeColumn(width: number, turnId = 'turn-1') {
  const pane = document.createElement('div');
  pane.className = 'openbitfun-chat-pane__content';
  pane.innerHTML = '<div class="virtual-item-wrapper"><button></button></div>';
  const column = pane.firstElementChild as HTMLElement;
  column.dataset.turnId = turnId;
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({ width: 1600 } as DOMRect);
  vi.spyOn(column, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect);
  document.body.append(pane);
  return { column, trigger: column.querySelector('button')! };
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('conversation image layout', () => {
  it.each([900, 420.5])('preserves the %s px reading column instead of the full pane', width => {
    const { trigger } = makeColumn(width);
    expect(readExportImageLayout('turn-1', trigger).width).toBe(width);
  });

  it('uses the initiating column and its local font settings with multiple transcripts', () => {
    makeColumn(900);
    const { column, trigger } = makeColumn(560);
    column.style.setProperty('--openbitfun-type-flow-body-font-size', '18px');
    column.style.setProperty('--openbitfun-type-flow-body-line-height', '1.7');
    const layout = readExportImageLayout('turn-1', trigger);
    expect(layout.width).toBe(560);
    expect(layout.variables).toMatchObject({
      '--openbitfun-type-flow-body-font-size': '18px',
      '--openbitfun-type-flow-body-line-height': '1.7',
    });
  });

  it('finds the visible target turn when its trigger is unavailable', () => {
    makeColumn(900, 'another-turn');
    makeColumn(0);
    makeColumn(620);
    expect(readExportImageLayout('turn-1', null).width).toBe(620);
  });

  it('leaves missing-row sizing to the shared CSS limit and retains root appearance', () => {
    makeColumn(900, 'another-turn');
    document.documentElement.style.setProperty('--openbitfun-type-flow-body-font-size', '16px');
    const layout = readExportImageLayout('missing-turn', null);
    expect(layout.width).toBeUndefined();
    expect(layout.variables['--openbitfun-type-flow-body-font-size']).toBe('16px');
  });
});
