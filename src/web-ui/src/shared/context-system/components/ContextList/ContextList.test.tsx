// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContextItem } from '../../../types/context';
import { useContextStore } from '../../../stores/contextStore';
import { ContextList } from './ContextList';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const implementation: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: implementation,
  });
  return implementation;
});

const confirmation = vi.hoisted(() => vi.fn());
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDanger: confirmation }));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../ContextCard/ContextCard', () => ({
  ContextCard: ({ context, onRemove }: {
    context: ContextItem;
    onRemove?: (id: string) => void;
  }) => (
    <button
      type="button"
      data-context-id={context.id}
      onClick={() => onRemove?.(context.id)}
    >
      {context.id}
    </button>
  ),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const context = (id: string): ContextItem => ({
  id,
  type: 'file',
  timestamp: 1,
  filePath: `/${id}.ts`,
  fileName: `${id}.ts`,
});

const contextIds = () => useContextStore.getState().contexts.map(item => item.id);

describe('ContextList removal presence', () => {
  let container: HTMLDivElement | null;
  let root: Root | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    storage.clear();
    confirmation.mockReset().mockResolvedValue(false);
    useContextStore.setState({
      contexts: [context('a'), context('b'), context('c')],
      validationStates: new Map(),
      validatingIds: new Set(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<ContextList />));
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    useContextStore.setState({
      contexts: [],
      validationStates: new Map(),
      validatingIds: new Set(),
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retains sequential removals in stable order until both exits finish', () => {
    const removeButton = (id: string) => (
      container?.querySelector<HTMLButtonElement>(`[data-context-id="${id}"]`)
    );

    act(() => removeButton('b')?.click());
    act(() => removeButton('c')?.click());

    expect([...(container?.querySelectorAll('[data-context-id]') ?? [])]
      .map(element => element.getAttribute('data-context-id'))).toEqual(['a', 'b', 'c']);
    expect(container?.querySelector('[data-context-id="b"]')
      ?.closest('.openbitfun-context-list__item')?.getAttribute('data-exiting')).toBe('true');
    expect(container?.querySelector('[data-context-id="c"]')
      ?.closest('.openbitfun-context-list__item')?.getAttribute('data-exiting')).toBe('true');
    expect(contextIds()).toEqual(['a', 'b', 'c']);

    act(() => vi.advanceTimersByTime(159));
    expect(contextIds()).toEqual(['a', 'b', 'c']);

    act(() => vi.advanceTimersByTime(1));
    expect(contextIds()).toEqual(['a']);
  });

  it('confirms clearing beside its button and keeps contexts on cancellation', async () => {
    const clear = container!.querySelector<HTMLButtonElement>('[title="contextSystem.contextList.clearAllTitle"]')!;
    await act(async () => clear.click());
    expect(confirmation).toHaveBeenCalledWith('contextSystem.contextList.clearAllTitle', 'contextSystem.contextList.clearAllConfirm', {
      anchor: expect.objectContaining({ element: clear }), confirmText: 'contextSystem.contextList.clearAll',
    });
    act(() => vi.advanceTimersByTime(160));
    expect(contextIds()).toEqual(['a', 'b', 'c']);
    confirmation.mockResolvedValueOnce(true);
    await act(async () => clear.click());
    expect(contextIds()).toEqual(['a', 'b', 'c']);
    act(() => vi.advanceTimersByTime(160));
    expect(contextIds()).toEqual([]);
  });

  it('commits a requested removal if the list unmounts during its exit', () => {
    act(() => container?.querySelector<HTMLButtonElement>('[data-context-id="b"]')?.click());

    act(() => root?.unmount());
    root = null;

    expect(contextIds()).toEqual(['a', 'c']);
  });

  it('removes immediately when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));

    act(() => container?.querySelector<HTMLButtonElement>('[data-context-id="b"]')?.click());

    expect(contextIds()).toEqual(['a', 'c']);
    expect(container?.querySelector('[data-context-id="b"]')).toBeNull();
  });
});
