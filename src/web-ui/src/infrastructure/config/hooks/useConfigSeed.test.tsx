// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfigSeed } from './useConfigSeed';

const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../services/ConfigManager', () => ({ configManager: {
  hasCachedConfig: (path: string) => values.has(path),
  getCachedConfig: (path: string) => values.get(path),
} }));

function Form() {
  const seed = useConfigSeed(['editor', 'optional']);
  const [draft, setDraft] = useState(seed.get('editor', 'default'));
  return <button data-loaded={seed.loaded} onClick={() => setDraft('edited')}>{draft}</button>;
}

describe('settings form snapshots', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    values.clear();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it('uses a complete snapshot on the first render, including a missing optional field', () => {
    values.set('editor', 'saved');
    values.set('optional', undefined);
    act(() => root.render(<Form />));
    expect(container.querySelector('button')?.dataset.loaded).toBe('true');
    expect(container.textContent).toBe('saved');
    act(() => container.querySelector('button')!.click());
    values.set('editor', 'late read');
    act(() => root.render(<Form />));
    expect(container.textContent).toBe('edited');
  });

  it('does not make a partially loaded form editable', () => {
    values.set('editor', 'partial');
    act(() => root.render(<Form />));
    expect(container.querySelector('button')?.dataset.loaded).toBe('false');
    expect(container.textContent).toBe('default');
  });
});
