// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LocalizedDateTimeField from './LocalizedDateTimeField';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
  useI18n: () => ({
    currentLanguage: 'en-US',
    formatDate: (date: Date) => date.toISOString(),
    formatNumber: (value: number) => String(value),
    t: (key: string) => key,
  }),
}));

vi.mock('@/infrastructure/appearance/runtime/AppearanceOverlayHost', () => ({
  getAppearanceOverlayHost: () => document.body,
}));

describe('LocalizedDateTimeField picker action', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelector('[data-testid="datetime-picker"]')?.remove();
  });

  it('opens the picker from an accessible design-system icon button', () => {
    act(() => {
      root.render(
        <LocalizedDateTimeField
          value="2026-08-27T09:30"
          onChange={vi.fn()}
        />,
      );
    });

    const pickerButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="dateTimeField.openPicker"]',
    );

    expect(pickerButton?.dataset.openbitfunComponent).toBe('icon-button');
    expect(pickerButton?.getAttribute('aria-expanded')).toBe('false');

    act(() => pickerButton?.click());

    expect(pickerButton?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-testid="datetime-picker"]')).not.toBeNull();
  });
  it('exposes native day buttons in grid rows and restores focus after keyboard dismissal', () => {
    const onChange = vi.fn();
    act(() => root.render(<LocalizedDateTimeField value="2026-08-31T09:30" onChange={onChange} />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="dateTimeField.openPicker"]')!;
    act(() => trigger.click());
    const grid = document.querySelector('[role="grid"]')!;
    expect(grid.querySelectorAll(':scope > [role="row"]')).toHaveLength(6);
    expect(grid.querySelectorAll('[role="gridcell"] > button:not([role])')).toHaveLength(42);
    expect(grid.querySelectorAll('button[tabindex="0"]')).toHaveLength(1);
    const key = (value: string) => act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
    });
    expect((document.activeElement as HTMLElement).dataset.day).toBe(String(new Date(2026, 7, 31).getTime()));
    key('ArrowRight');
    expect((document.activeElement as HTMLElement).dataset.day).toBe(String(new Date(2026, 8, 1).getTime()));
    key('PageDown');
    expect((document.activeElement as HTMLElement).dataset.day).toBe(String(new Date(2026, 9, 1).getTime()));
    key('Escape');
    expect(document.querySelector('[data-testid="datetime-picker"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
    act(() => trigger.click());
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith('2026-08-31T09:30');
    expect(document.activeElement).toBe(trigger);
  });

});
