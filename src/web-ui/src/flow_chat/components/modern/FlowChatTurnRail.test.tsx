// @vitest-environment jsdom

import React from 'react';
import { resolve } from 'node:path';
import { compile } from 'sass';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowChatTurnRail, type FlowChatTurnRailItem } from './FlowChatTurnRail';
import { FLOWCHAT_TURN_RAIL_ROW_HEIGHT_PX } from './flowChatTurnRailWindow';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { current?: number }) => {
      if (key === 'flowChatTurnRail.label') return 'Turns';
      if (key === 'flowChatTurnRail.untitledTurn') return 'Untitled turn';
      if (key === 'flowChatHeader.turnBadge') return `Turn ${options?.current ?? 0}`;
      return key;
    },
  }),
}));

vi.mock('@openbitfun/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  OverflowText: ({ children, behavior: _behavior, marqueeActive: _marqueeActive, ...props }: any) => <span {...props}>{children}</span>,
  Tooltip: ({
    children,
    content,
  }: {
    children: React.ReactElement;
    content: React.ReactNode;
  }) => (
    <span data-testid="tooltip-wrapper">
      {children}
      <span data-testid="tooltip-content">{content}</span>
    </span>
  ),
}));

const turns: FlowChatTurnRailItem[] = [
  { itemKey: 'storage:0', turnId: 'turn-1', ordinal: 0, turnIndex: 1, content: 'First user message' },
  { itemKey: 'storage:1', turnId: 'turn-2', ordinal: 1, turnIndex: 2, content: 'Second user message' },
  { itemKey: 'storage:2', turnId: 'turn-3', ordinal: 2, turnIndex: 3, content: 'Third user message' },
  { itemKey: 'storage:3', turnId: 'turn-4', ordinal: 3, turnIndex: 4, content: 'Fourth user message' },
];

function createTurns(count: number): FlowChatTurnRailItem[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    itemKey: `storage:${ordinal}`,
    turnId: `turn-${ordinal + 1}`,
    ordinal,
    turnIndex: ordinal + 1,
    content: `Message ${ordinal + 1}`,
  }));
}

const railCss = compile(resolve(__dirname, 'FlowChatTurnRail.scss')).css;
const fullBarWidth = 'var(--openbitfun-control-flow-chat-turn-rail-width)';

describe('FlowChatTurnRail', () => {
  let container: HTMLDivElement;
  let root: Root;
  let style: HTMLStyleElement;

  const emphasizedBars = () => {
    const selectors = Array.from(style.sheet!.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter(rule => rule.style.getPropertyValue('background') === 'var(--openbitfun-color-content-primary)'
        && rule.style.getPropertyValue('opacity') === '0.8')
      .map(rule => rule.selectorText);
    expect(selectors.length).toBeGreaterThan(0);
    // Both current and hover may use primary ink, but their compiled selectors
    // must never emphasize multiple markers at once. Visibility is not selection.
    expect(selectors.every(selector => !selector.includes('__item--visible'))).toBe(true);
    return container.querySelectorAll(selectors.join(', '));
  };

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = railCss;
    document.head.appendChild(style);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    style.remove();
  });

  function hover(item: HTMLElement, pointerType = 'mouse') {
    const event = new MouseEvent('pointerover', { bubbles: true });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    act(() => item.dispatchEvent(event));
  }

  function leave(item: HTMLElement) {
    act(() => item.dispatchEvent(new MouseEvent('pointerout', {
      bubbles: true,
      relatedTarget: document.body,
    })));
  }

  function barWidth(item: Element) {
    return getComputedStyle(item.querySelector('.flowchat-turn-rail__bar')!).width;
  }

  it('fans out neighboring markers around hover without changing the current turn', () => {
    const onNavigate = vi.fn();
    act(() => root.render(
      <FlowChatTurnRail turns={createTurns(12)} currentTurnId="turn-6" visibleTurnIds={['turn-6']} onNavigate={onNavigate} />,
    ));
    const items = container.querySelectorAll<HTMLButtonElement>('.flowchat-turn-rail__item');
    const current = container.querySelector<HTMLButtonElement>('[data-turn-id="turn-6"]')!;
    const target = container.querySelector<HTMLButtonElement>('[data-turn-id="turn-7"]')!;
    const restingPositions = Array.from(items, item => item.style.top);
    hover(target);

    expect(emphasizedBars()).toHaveLength(1);
    expect(emphasizedBars()[0].parentElement).toBe(target);
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(target.hasAttribute('aria-current')).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
    for (const item of items) {
      const distance = Math.abs(Number(item.dataset.turnOrdinal) - 6);
      expect(barWidth(item)).toBe(distance === 0 ? fullBarWidth : `${[20, 15, 10, 8][distance] ?? 5}px`);
      expect(getComputedStyle(item.querySelector('.flowchat-turn-rail__bar')!).opacity)
        .toBe(distance === 0 ? '0.8' : '0.2');
    }
    expect(Array.from(items, item => item.style.top)).toEqual(restingPositions);
    // Even the longest bar fits inside its stable hit area and clipped list.
    expect(barWidth(target)).toBe(getComputedStyle(target).width);

    leave(target);
    expect(emphasizedBars()).toHaveLength(1);
    expect(emphasizedBars()[0].parentElement).toBe(current);
    expect(Array.from(items, barWidth)).toEqual(
      Array(items.length).fill('5px'),
    );
  });

  it('moves the hover fan at both ends and restores the latest selection on leave', () => {
    const onNavigate = vi.fn();
    const render = (currentTurnId: string) => act(() => root.render(
      <FlowChatTurnRail turns={turns} currentTurnId={currentTurnId} visibleTurnIds={[]} onNavigate={onNavigate} />,
    ));
    render('turn-2');
    const items = container.querySelectorAll<HTMLButtonElement>('.flowchat-turn-rail__item');
    hover(items[0]);
    expect(Array.from(items, barWidth)).toEqual([fullBarWidth, '15px', '10px', '8px']);
    leave(items[0]);
    hover(items[3]);
    expect(Array.from(items, barWidth)).toEqual(['8px', '10px', '15px', fullBarWidth]);
    act(() => items[3].click());
    expect(onNavigate).toHaveBeenCalledWith(turns[3]);
    render('turn-4');
    expect(emphasizedBars()).toHaveLength(1);
    leave(items[3]);
    expect(emphasizedBars()[0].parentElement).toBe(items[3]);
    expect(items[3].getAttribute('aria-current')).toBe('step');
  });

  it('does not leave a hover preview after touch or rail scrolling', () => {
    const onNavigate = vi.fn();
    act(() => root.render(
      <FlowChatTurnRail turns={turns} currentTurnId="turn-2" visibleTurnIds={[]} onNavigate={onNavigate} />,
    ));
    const target = container.querySelector<HTMLButtonElement>('[data-turn-id="turn-4"]')!;
    hover(target, 'touch');
    expect(barWidth(target)).toBe('5px');
    hover(target);
    expect(barWidth(target)).toBe(fullBarWidth);
    act(() => container.querySelector('.flowchat-turn-rail__list')!
      .dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(barWidth(target)).toBe('5px');
    expect(emphasizedBars()).toHaveLength(1);
    expect(emphasizedBars()[0].parentElement?.getAttribute('data-turn-id')).toBe('turn-2');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('disables marker transitions when reduced motion is requested', () => {
    const media = Array.from(style.sheet!.cssRules)
      .find((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule
        && rule.conditionText === '(prefers-reduced-motion: reduce)');
    expect(media).toBeDefined();
    const rule = Array.from(media!.cssRules).find((candidate): candidate is CSSStyleRule => (
      candidate instanceof CSSStyleRule && candidate.selectorText === '.flowchat-turn-rail__bar'
    ));
    expect(rule?.style.getPropertyValue('transition')).toBe('none');
  });

  it('emphasizes only the current turn when several turns share the viewport', () => {
    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={turns}
          currentTurnId="turn-2"
          visibleTurnIds={['turn-2', 'turn-3', 'turn-4']}
          onNavigate={vi.fn()}
        />,
      );
    });

    const items = container.querySelectorAll<HTMLButtonElement>('.flowchat-turn-rail__item');
    expect(items).toHaveLength(4);
    expect(items[1].getAttribute('aria-current')).toBe('step');
    expect(barWidth(items[1])).toBe('5px');
    expect(barWidth(items[0])).toBe('5px');
    expect(items[1].className).toContain('flowchat-turn-rail__item--visible');
    expect(items[2].className).toContain('flowchat-turn-rail__item--visible');
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(emphasizedBars()).toHaveLength(1);
    expect(emphasizedBars()[0].parentElement).toBe(items[1]);
    expect(items[0].getAttribute('aria-current')).toBeNull();
    expect(items[0].className).not.toContain('flowchat-turn-rail__item--visible');
  });

  it('moves emphasis with the current turn without retaining emphasis on other visible turns', () => {
    const onNavigate = vi.fn();
    const renderCurrent = (currentTurnId: string | null) => act(() => {
      root.render(
        <FlowChatTurnRail
          turns={turns}
          currentTurnId={currentTurnId}
          visibleTurnIds={['turn-2', 'turn-3', 'turn-4']}
          onNavigate={onNavigate}
        />,
      );
    });
    renderCurrent('turn-2');
    const target = container.querySelector<HTMLButtonElement>('[data-turn-id="turn-4"]')!;
    act(() => target.click());
    expect(onNavigate).toHaveBeenCalledWith(turns[3]);
    renderCurrent('turn-4');
    expect(emphasizedBars()).toHaveLength(1);
    expect(emphasizedBars()[0].parentElement).toBe(target);
    expect(container.querySelector('[data-turn-id="turn-2"]')?.hasAttribute('aria-current')).toBe(false);

    renderCurrent(null);
    expect(emphasizedBars()).toHaveLength(0);
    expect(container.querySelectorAll('[aria-current]')).toHaveLength(0);
  });

  it('shows the turn number and user message in the tooltip without a timestamp', () => {
    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={turns.slice(0, 1)}
          currentTurnId="turn-1"
          visibleTurnIds={['turn-1']}
          onNavigate={vi.fn()}
        />,
      );
    });

    const tooltip = container.querySelector('[data-testid="tooltip-content"]');
    expect(tooltip?.textContent).toContain('Turn 1');
    expect(tooltip?.textContent).toContain('First user message');
    expect(tooltip?.querySelector('.flowchat-turn-rail__tooltip-time')).toBeNull();
  });

  it('renders catalog-only capsule previews without the raw prompt markers', () => {
    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={[{
            ...turns[0],
            content: '[$pdf] #file: src/auth.ts',
            capsulePreview: {
              segments: [
                { kind: 'inlineToken', tokenType: 'skill', label: 'pdf' },
                { kind: 'text', text: ' ' },
                { kind: 'context', contextType: 'file', label: 'auth.ts', title: 'src/auth.ts' },
              ],
            },
          }]}
          currentTurnId="turn-1"
          visibleTurnIds={['turn-1']}
          onNavigate={vi.fn()}
        />,
      );
    });

    const tooltip = container.querySelector('[data-testid="tooltip-content"]');
    expect(tooltip?.textContent).toContain('pdf');
    expect(tooltip?.textContent).toContain('auth.ts');
    expect(tooltip?.textContent).not.toContain('[$pdf]');
    expect(tooltip?.textContent).not.toContain('#file:');
    expect(tooltip?.querySelectorAll('.user-message-item__reference')).toHaveLength(2);
    expect(tooltip?.querySelector('[data-testid="icon-book-open"]')).not.toBeNull();
    expect(tooltip?.querySelector('[data-testid="icon-book-open"]')?.closest('.message-reference-capsule')
      ?.textContent).toContain('pdf');
  });

  it('delegates clicks to the shared turn navigation callback', () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={turns}
          currentTurnId="turn-1"
          visibleTurnIds={['turn-1']}
          onNavigate={onNavigate}
        />,
      );
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-turn-id="turn-3"]')?.click();
    });

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(turns[2]);
  });

  it('keeps placeholder markers visible and navigable by ordinal', () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={[
            turns[0],
            { itemKey: 'storage:1', turnId: null, ordinal: 1, turnIndex: 2, content: null },
          ]}
          currentTurnId="turn-1"
          visibleTurnIds={['turn-1']}
          onNavigate={onNavigate}
        />,
      );
    });

    const placeholder = container.querySelector<HTMLButtonElement>('[data-turn-key="storage:1"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute('aria-disabled')).toBeNull();
    expect(placeholder?.getAttribute('data-turn-id')).toBeNull();

    act(() => placeholder?.click());

    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({
      ordinal: 1,
      turnId: null,
    }));
    const tooltipMessages = container.querySelectorAll('.flowchat-turn-rail__tooltip-message');
    expect(tooltipMessages).toHaveLength(1);
  });

  it('keeps marker identity stable when a placeholder resolves', () => {
    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={[{ itemKey: 'storage:7', turnId: null, ordinal: 7, turnIndex: 8, content: null }]}
          currentTurnId={null}
          visibleTurnIds={[]}
          onNavigate={vi.fn()}
        />,
      );
    });
    const placeholder = container.querySelector<HTMLButtonElement>('[data-turn-key="storage:7"]');
    expect(placeholder?.getAttribute('aria-disabled')).toBeNull();

    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={[{
            itemKey: 'storage:7',
            turnId: 'turn-8',
            ordinal: 7,
            turnIndex: 8,
            content: 'Resolved message',
          }]}
          currentTurnId="turn-8"
          visibleTurnIds={['turn-8']}
          onNavigate={vi.fn()}
        />,
      );
    });

    const resolved = container.querySelector<HTMLButtonElement>('[data-turn-key="storage:7"]');
    expect(resolved).toBe(placeholder);
    expect(resolved?.getAttribute('data-turn-id')).toBe('turn-8');
    expect(resolved?.getAttribute('aria-disabled')).toBeNull();
  });

  it('keeps the active turn visible by scrolling only the rail list', () => {
    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={turns}
          currentTurnId="turn-1"
          visibleTurnIds={['turn-1']}
          onNavigate={vi.fn()}
        />,
      );
    });

    const list = container.querySelector<HTMLElement>('.flowchat-turn-rail__list');
    expect(list).not.toBeNull();
    if (!list) return;

    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 30 });
    list.scrollTop = 0;

    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={turns}
          currentTurnId="turn-4"
          visibleTurnIds={['turn-4']}
          onNavigate={vi.fn()}
        />,
      );
    });

    expect(list.scrollTop).toBe(9);
  });

  it('moves keyboard focus through the vertical turn list', () => {
    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={turns}
          currentTurnId="turn-2"
          visibleTurnIds={['turn-2']}
          onNavigate={vi.fn()}
        />,
      );
    });

    const current = container.querySelector<HTMLButtonElement>('[data-turn-id="turn-2"]');
    const next = container.querySelector<HTMLButtonElement>('[data-turn-id="turn-3"]');
    expect(current).not.toBeNull();
    expect(next).not.toBeNull();
    if (!current || !next) return;

    act(() => {
      current.focus();
      current.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
      }));
    });

    expect(document.activeElement).toBe(next);
    expect(next.tabIndex).toBe(0);
    expect(current.tabIndex).toBe(-1);
    expect(emphasizedBars()).toHaveLength(1);
    expect(emphasizedBars()[0].parentElement).toBe(current);
    expect(barWidth(current)).toBe('5px');
  });

  it('bounds rendered markers to the viewport plus overscan', () => {
    const manyTurns = createTurns(100);
    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={manyTurns}
          currentTurnId="turn-1"
          visibleTurnIds={['turn-1']}
          onNavigate={vi.fn()}
        />,
      );
    });

    const rail = container.querySelector<HTMLElement>('[data-testid="flowchat-turn-rail"]');
    const list = container.querySelector<HTMLDivElement>('.flowchat-turn-rail__list');
    expect(rail?.dataset.totalTurnCount).toBe('100');
    expect(list).not.toBeNull();
    if (!list) return;

    Object.defineProperty(list, 'clientHeight', {
      configurable: true,
      value: 4 * FLOWCHAT_TURN_RAIL_ROW_HEIGHT_PX,
    });
    list.scrollTop = 50 * FLOWCHAT_TURN_RAIL_ROW_HEIGHT_PX;
    act(() => {
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const renderedItems = container.querySelectorAll<HTMLButtonElement>('.flowchat-turn-rail__item');
    expect(renderedItems.length).toBeLessThanOrEqual(18);
    expect(renderedItems.length).toBeGreaterThanOrEqual(10);
    expect(container.querySelector('[data-turn-ordinal="50"]')).not.toBeNull();
    expect(container.querySelector('[data-turn-ordinal="0"]')).toBeNull();
    expect(Array.from(renderedItems).filter(item => item.tabIndex === 0)).toHaveLength(1);
  });

  it('moves virtual keyboard focus across unmounted markers', () => {
    const manyTurns = createTurns(100);
    act(() => {
      root.render(
        <FlowChatTurnRail
          turns={manyTurns}
          currentTurnId="turn-1"
          visibleTurnIds={['turn-1']}
          onNavigate={vi.fn()}
        />,
      );
    });

    const list = container.querySelector<HTMLDivElement>('.flowchat-turn-rail__list');
    const first = container.querySelector<HTMLButtonElement>('[data-turn-ordinal="0"]');
    expect(list).not.toBeNull();
    expect(first).not.toBeNull();
    if (!list || !first) return;
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 42 });

    act(() => {
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'End',
        bubbles: true,
      }));
    });

    const last = container.querySelector<HTMLButtonElement>('[data-turn-ordinal="99"]');
    expect(last).not.toBeNull();
    expect(document.activeElement).toBe(last);
    expect(last?.getAttribute('aria-posinset')).toBe('100');
    expect(last?.getAttribute('aria-setsize')).toBe('100');
    expect(container.querySelector('[data-turn-ordinal="0"]')).toBeNull();
  });
});
