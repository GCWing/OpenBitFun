// @vitest-environment jsdom
import React, { act, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { CanvasToolbarContribution, CanvasToolbarHost, CanvasToolbarProvider } from './CanvasToolbar';
import { CanvasStoreModeContext } from './stores';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('external canvas toolbar ownership', () => {
  it('renders once in the shell, keeps source context and callbacks, and removes retired groups', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const select = vi.fn();
    function Tab({ title }: { title: string }) {
      const mode = useContext(CanvasStoreModeContext);
      return <button onClick={select} data-mode={mode}>{title}</button>;
    }
    const render = (split: boolean, title: string) => root.render(<CanvasToolbarProvider>
      <header><CanvasToolbarHost /></header>
      <main><CanvasStoreModeContext.Provider value="git">
        <CanvasToolbarContribution groupId="primary"><Tab title={title} /></CanvasToolbarContribution>
        {split && <CanvasToolbarContribution groupId="secondary"><Tab title="Second" /></CanvasToolbarContribution>}
      </CanvasStoreModeContext.Provider></main>
    </CanvasToolbarProvider>);
    try {
      act(() => render(true, 'First'));
      expect(container.querySelector('main')?.children).toHaveLength(0);
      expect([...container.querySelectorAll('header button')].map(tab => tab.textContent)).toEqual(['First', 'Second']);
      expect(container.querySelector('button')?.dataset.mode).toBe('git');
      act(() => container.querySelector('button')!.click());
      expect(select).toHaveBeenCalledOnce();
      act(() => render(false, 'Renamed'));
      expect([...container.querySelectorAll('header button')].map(tab => tab.textContent)).toEqual(['Renamed']);
    } finally { act(() => root.unmount()); }
  });
});
