// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoadingState } from './ConfigLoadingState';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('settings loading geometry', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

  it('reserves the requested rows immediately and only delays the announcement', () => {
    act(() => root.render(<ConfigLoadingState label="Loading settings" rows={2} />));
    const skeleton = container.querySelector('[aria-hidden="true"]');
    expect(skeleton?.children).toHaveLength(2);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
    act(() => vi.advanceTimersByTime(200));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading settings');
    expect(container.querySelector('[aria-hidden="true"]')).toBe(skeleton);
  });

  it('cancels delayed feedback when content becomes ready', () => {
    act(() => root.render(<ConfigLoadingState label="Loading settings" variant="list" />));
    act(() => root.render(<input aria-label="Setting" defaultValue="Loaded" />));
    act(() => vi.runAllTimers());
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('input')?.value).toBe('Loaded');
  });
});
