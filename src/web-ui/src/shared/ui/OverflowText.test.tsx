// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListboxOption, OverflowText, Select, Tooltip } from '@openbitfun/ui';
import { CommandToolCard } from '@openbitfun/ui/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('overflow text full-content access', () => {
  let host: HTMLDivElement;
  let root: Root;
  let availableWidth: number;
  const resizeCallbacks = new Set<() => void>();
  const longLabel = 'Run independent tasks concurrently whenever possible';

  const flushMeasurement = () => act(() => vi.advanceTimersByTime(1));
  const render = (content: React.ReactNode) => {
    act(() => root.render(content));
    flushMeasurement();
  };
  const hover = (element: Element) => act(() => {
    element.dispatchEvent(new MouseEvent('mouseenter'));
  });
  const reveal = () => {
    act(() => vi.advanceTimersByTime(500));
    act(() => vi.advanceTimersByTime(20));
  };
  const tooltip = () => document.querySelector<HTMLElement>('[role="tooltip"]');

  beforeEach(() => {
    vi.useFakeTimers();
    availableWidth = 100;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-overflow') ? availableWidth : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-overflow') || this.hasAttribute('data-overflow-content')
        ? (this.textContent?.length ?? 0) * 8
        : 0;
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) { resizeCallbacks.add(callback); }
      observe() {}
      disconnect() { resizeCallbacks.delete(this.callback); }
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resizeCallbacks.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(['marquee', 'fade'] as const)('shows the complete %s label from the owning control and keeps its click behavior', (behavior) => {
    const onClick = vi.fn();
    render(<button data-overflow-trigger aria-describedby="help" onClick={onClick}>
      <OverflowText behavior={behavior}>{longLabel}</OverflowText>
    </button>);
    const button = host.querySelector('button')!;
    hover(button);
    reveal();
    expect(tooltip()?.textContent).toBe(longLabel);
    expect(button.getAttribute('aria-describedby')).toContain(tooltip()!.id);
    expect(host.querySelector('[title]')).toBeNull();
    expect(host.querySelector('[tabindex]')).toBeNull();
    act(() => button.click());
    expect(onClick).toHaveBeenCalledOnce();
    expect(tooltip()).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBe('help');
  });

  it('defers mount reads and coalesces repeated resize notifications for all labels', () => {
    const reads: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      reads.push(this.textContent ?? '');
      // No label may publish an overflow state while this batch is reading.
      expect(host.querySelector('[data-overflow="true"]')).toBeNull();
      return 500;
    });
    act(() => root.render(<><OverflowText>First</OverflowText><OverflowText>Second</OverflowText></>));
    act(() => {
      resizeCallbacks.forEach(callback => { callback(); callback(); });
    });
    expect(reads).toEqual([]);
    flushMeasurement();
    expect(reads).toEqual(['First', 'Second']);
    expect(host.querySelectorAll('[data-overflow="true"]')).toHaveLength(2);
  });

  it('cancels pending measurements on unmount and measures the latest props only', () => {
    const read = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get');
    act(() => root.render(<OverflowText>{longLabel}</OverflowText>));
    act(() => root.render(null));
    flushMeasurement();
    expect(read).not.toHaveBeenCalled();
    act(() => root.render(<OverflowText>{longLabel}</OverflowText>));
    act(() => root.render(<OverflowText>Short</OverflowText>));
    flushMeasurement();
    expect(read).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-overflow]')?.getAttribute('data-overflow')).toBe('false');
  });

  it('keeps interaction-only ellipsis idle on virtual selection and reveals full text on focus', () => {
    render(<button data-overflow-trigger data-overflow-active="true">
      <OverflowText overflowStyle="ellipsis" marqueeTrigger="interaction" marqueeActive>
        {longLabel}
      </OverflowText>
    </button>);
    const label = host.querySelector<HTMLElement>('[data-overflow]')!;
    expect(label.getAttribute('data-overflow')).toBe('true');
    expect(label.getAttribute('data-marquee-active')).toBeNull();
    reveal();
    expect(tooltip()).toBeNull();
    act(() => host.querySelector('button')!.focus());
    reveal();
    expect(tooltip()?.textContent).toBe(longLabel);
    act(() => {
      availableWidth = 1000;
      resizeCallbacks.forEach(callback => callback());
    });
    flushMeasurement();
    expect(label.getAttribute('data-overflow')).toBe('false');
    expect(tooltip()).toBeNull();
  });

  it('uses solid ellipsis for long commands and keeps the tooltip open across portal entry', () => {
    render(<CommandToolCard action="Run" command={longLabel} emptyCommand="Empty" isExpanded={false} status="completed" />);
    expect(host.querySelector('[title]')).toBeNull();
    const label = host.querySelector('[data-openbitfun-part="command"] [data-overflow]')!;
    expect(label.getAttribute('data-overflow-style')).toBe('ellipsis');
    const trigger = label.closest('[data-overflow-trigger]') ?? label;
    hover(trigger);
    reveal();
    const popup = tooltip()!;
    expect(popup.textContent).toBe(longLabel);
    act(() => {
      popup.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: trigger }));
      trigger.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: popup }));
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(tooltip()).toBe(popup);
    act(() => popup.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
    act(() => vi.advanceTimersByTime(500));
    expect(tooltip()).toBeNull();
  });

  it('does not toggle the command card when clicking inside its tooltip', () => {
    const onToggle = vi.fn();
    render(<CommandToolCard action="Run" command={longLabel} emptyCommand="Empty"
      isExpanded={false} status="completed" output="Output" onToggle={onToggle} />);
    const label = host.querySelector<HTMLElement>('[data-openbitfun-part="command"] [data-overflow]')!;
    hover(label.closest('[data-overflow-trigger]') ?? label);
    reveal();
    const popup = tooltip()!;
    act(() => popup.querySelector<HTMLElement>('[data-openbitfun-part="body"]')!.click());
    expect(onToggle).not.toHaveBeenCalled();
    expect(tooltip()).toBe(popup);
    act(() => label.click());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('reveals rich labels and plain-text arrays without waiting for a marquee', () => {
    render(<button data-overflow-trigger>
      <OverflowText>Run <strong>independent tasks</strong> concurrently whenever possible</OverflowText>
    </button>);
    hover(host.querySelector('button')!);
    reveal();
    expect(tooltip()?.textContent).toBe(longLabel);
    render(<button data-overflow-trigger><OverflowText>{['Run independent tasks ', 'concurrently whenever possible']}</OverflowText></button>);
    expect(tooltip()?.textContent).toBe(longLabel);
  });

  it('opens on keyboard focus, dismisses with Escape, and clears pending opens on blur', () => {
    render(<button data-overflow-trigger><OverflowText>{longLabel}</OverflowText></button>);
    const button = host.querySelector('button')!;
    act(() => button.focus());
    reveal();
    expect(tooltip()?.textContent).toBe(longLabel);
    act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    reveal();
    expect(tooltip()).toBeNull();
    act(() => { button.blur(); button.focus(); button.blur(); });
    reveal();
    expect(tooltip()).toBeNull();
  });

  it('combines overflowing label and metadata into one tooltip per control', () => {
    const metadata = 'A second long metadata string';
    render(<button data-overflow-trigger>
      <OverflowText>{longLabel}</OverflowText><OverflowText>{metadata}</OverflowText>
    </button>);
    hover(host.querySelector('button')!);
    reveal();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(tooltip()?.textContent).toBe(`${longLabel}\n${metadata}`);
  });

  it('cancels a delayed tooltip when the pointer leaves or Escape is pressed before opening', () => {
    render(<button data-overflow-trigger><OverflowText>{longLabel}</OverflowText></button>);
    const button = host.querySelector('button')!;
    hover(button);
    act(() => button.dispatchEvent(new MouseEvent('mouseleave')));
    reveal();
    expect(tooltip()).toBeNull();
    act(() => button.focus());
    act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    reveal();
    expect(tooltip()).toBeNull();
  });

  it('uses an explicit full title for shortened text and preserves the empty-title opt-out', () => {
    render(<OverflowText title={longLabel}>Run independent tasks...</OverflowText>);
    hover(host.querySelector('[data-overflow]')!);
    reveal();
    expect(tooltip()?.textContent).toBe(longLabel);
    render(<OverflowText title="">{longLabel}</OverflowText>);
    hover(host.querySelector('[data-overflow]')!);
    reveal();
    expect(tooltip()).toBeNull();
  });

  it('updates the open text and stops showing a tooltip when it fits after resizing', () => {
    render(<OverflowText>{longLabel}</OverflowText>);
    hover(host.querySelector('[data-overflow]')!);
    reveal();
    const updated = `${longLabel} on the selected host`;
    render(<OverflowText>{updated}</OverflowText>);
    expect(tooltip()?.textContent).toBe(updated);
    availableWidth = 1000;
    act(() => resizeCallbacks.forEach(callback => callback()));
    flushMeasurement();
    expect(tooltip()).toBeNull();
    hover(host.querySelector('[data-overflow]')!);
    reveal();
    expect(tooltip()).toBeNull();
  });

  it('keeps an explicit tooltip as the sole owner of the control', () => {
    render(<Tooltip content="Existing full description">
      <button data-overflow-trigger><OverflowText>{longLabel}</OverflowText></button>
    </Tooltip>);
    act(() => host.querySelector('button')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    reveal();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(tooltip()?.textContent).toBe('Existing full description');
  });

  it('detects vertical clipping and preserves multiline paragraph semantics', () => {
    availableWidth = 1000;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    render(<button data-overflow-trigger><OverflowText as="p" lines={2}>{longLabel}</OverflowText></button>);
    expect(host.querySelector('p')?.getAttribute('data-overflow')).toBe('true');
    expect(host.querySelector('p')?.getAttribute('data-overflow-behavior')).toBe('fade');
    expect(host.querySelector('[data-overflow-content]')).toBeNull();
    hover(host.querySelector('button')!);
    reveal();
    expect(tooltip()?.textContent).toBe(longLabel);
  });

  it('ignores harmless vertical ink overflow for a fully visible single-line label', () => {
    availableWidth = 1000;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(10);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(11);
    render(<OverflowText>Short</OverflowText>);
    expect(host.querySelector('[data-overflow]')?.getAttribute('data-overflow')).toBe('false');
  });

  it('leaves short, fully visible labels without a tooltip', () => {
    render(<button data-overflow-trigger><OverflowText>Short</OverflowText></button>);
    hover(host.querySelector('button')!);
    act(() => host.querySelector('button')!.focus());
    reveal();
    expect(tooltip()).toBeNull();
  });

  it('reveals a virtually focused listbox option without adding a tab stop', () => {
    render(<ListboxOption active>{longLabel}</ListboxOption>);
    reveal();
    expect(tooltip()?.textContent).toBe(longLabel);
    render(<ListboxOption active={false}>{longLabel}</ListboxOption>);
    reveal();
    expect(tooltip()).toBeNull();
    expect(host.querySelector('button')?.tabIndex).toBe(-1);
  });

  it('shows only the hovered option when another option still has keyboard focus', () => {
    const other = 'Another long option with a complete description';
    render(<><ListboxOption>{longLabel}</ListboxOption><ListboxOption>{other}</ListboxOption></>);
    const [first, second] = host.querySelectorAll('button');
    act(() => first.focus());
    reveal();
    hover(second);
    reveal();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(tooltip()?.textContent).toBe(other);
  });

  it('covers both the settings Select value and its portalled options', () => {
    render(<Select size="sm" aria-label="Task concurrency" options={[{ label: longLabel, value: 'parallel' }]} />);
    const trigger = host.querySelector<HTMLButtonElement>('[data-openbitfun-part="trigger"]')!;
    hover(trigger);
    reveal();
    expect(tooltip()?.textContent).toBe(longLabel);
    act(() => trigger.click());
    flushMeasurement();
    const option = document.querySelector<HTMLButtonElement>('[role="option"]')!;
    expect(host.contains(option)).toBe(false);
    hover(option);
    reveal();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(tooltip()?.textContent).toBe(longLabel);
    act(() => option.click());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(tooltip()).toBeNull();
  });
});
