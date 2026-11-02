// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AmbientToolCard, AmbientToolCardHeader, ReadFileToolCard, ToolCapsulePresentationProvider } from '@openbitfun/ui/flow-chat';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('keeps the disclosure control and open result mounted while a call completes', () => {
  function Harness({ completed }: { completed: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const status = completed ? 'completed' : 'running';
    return <ToolCapsulePresentationProvider value={{ label: 'pattern', description: 'Search · pattern', status, statusLabel: status, expanded, onExpandedChange: setExpanded }}>
      <AmbientToolCard status={status} header={<AmbientToolCardHeader icon={<svg />} content="native" />}
        onClick={() => { throw new Error('Controlled capsule should own disclosure'); }}
        expandedContent={<input aria-label="Result selection" defaultValue="result" />} />
    </ToolCapsulePresentationProvider>;
  }
  act(() => root.render(<Harness completed={false} />));
  const button = container.querySelector('button')!;
  expect(button.type).toBe('button');
  expect(button.getAttribute('aria-expanded')).toBe('false');
  act(() => button.click());
  const result = container.querySelector('input')!;
  result.value = 'User selection';
  act(() => root.render(<Harness completed />));
  expect(container.querySelector('button')).toBe(button);
  expect(container.querySelector('input')).toBe(result);
  expect(result.value).toBe('User selection');
  expect(button.getAttribute('aria-expanded')).toBe('true');
  act(() => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

it('keeps completed file actions and does not discard a record already opened during execution', () => {
  const onOpen = vi.fn();
  function Harness({ completed }: { completed: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const status = completed ? 'completed' : 'running';
    return <ToolCapsulePresentationProvider value={{ label: 'main.ts', description: 'Read · main.ts', status, statusLabel: status, expanded, onExpandedChange: setExpanded, fallbackContent: <p>Recorded input</p> }}>
      <ReadFileToolCard status={status} interactive={completed} onOpen={onOpen} />
    </ToolCapsulePresentationProvider>;
  }
  act(() => root.render(<Harness completed={false} />));
  act(() => container.querySelector('button')!.click());
  act(() => root.render(<Harness completed />));
  expect(container.textContent).toContain('Recorded input');
  act(() => container.querySelector('button')!.click());
  act(() => vi.runAllTimers());
  act(() => container.querySelector('button')!.click());
  expect(onOpen).toHaveBeenCalledTimes(1);
});
