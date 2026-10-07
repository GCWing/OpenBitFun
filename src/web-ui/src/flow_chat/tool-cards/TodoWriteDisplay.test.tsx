// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';
import { createTodoRenderItems } from './todoRenderItems';
import { TodoWriteDisplay } from './TodoWriteDisplay';
import { getToolCardConfig } from './toolCardMetadata';
import { FLOWCHAT_COLLAPSE_DURATION_MS } from '../components/modern/flowChatCollapseMotion';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => key === 'toolCards.todoWrite.summaryProgress'
      ? `${options?.task} · ${options?.completed}/${options?.total}` : key,
  }),
}));

vi.mock('../hooks/useDialogTurnTodos', () => ({
  useDialogTurnTodos: () => [],
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const config: ToolCardConfig = {
  toolName: 'TodoWrite',
  displayName: 'TodoWrite',
  icon: 'list-todo',
  requiresConfirmation: false,
  resultDisplayType: 'detailed',
  displayMode: 'standard',
};

function createTodoWriteItem(
  status: 'pending' | 'in_progress',
  todos = [{ id: 'todo-a', content: 'Implement change', status }],
): FlowToolItem {
  return {
    id: 'todo-tool-a',
    type: 'tool',
    toolName: 'TodoWrite',
    timestamp: 1,
    status: 'streaming',
    isParamsStreaming: true,
    partialParams: {
      todos,
    },
    toolCall: {
      id: 'todo-tool-a',
      input: {},
    },
  };
}

describe('createTodoRenderItems', () => {
  it('keeps React render keys unique when restored todos reuse ids', () => {
    const items = createTodoRenderItems([
      { id: '[truncated for session view]', content: 'Phase 1', status: 'completed' },
      { id: '[truncated for session view]', content: 'Phase 2', status: 'completed' },
      { id: 'p3-2', content: 'Phase 3', status: 'pending' },
    ]);

    expect(new Set(items.map(item => item.key)).size).toBe(items.length);
    expect(items.map(item => item.key)).toEqual([
      '[truncated for session view]-0',
      '[truncated for session view]-1',
      'p3-2',
    ]);
  });
});

describe('TodoWriteDisplay expansion', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const height = (this as HTMLElement).querySelector?.('[data-openbitfun-part="todoList"]') ? 320 : 64;
      return {
        bottom: height,
        height,
        left: 0,
        right: 300,
        top: 0,
        width: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stays collapsed during streaming until the user expands it', () => {
    vi.useFakeTimers();
    act(() => {
      root.render(<TodoWriteDisplay toolItem={createTodoWriteItem('pending')} config={config} />);
    });
    expect(container.querySelector('[data-openbitfun-part="todoList"]')).toBeNull();

    act(() => {
      root.render(<TodoWriteDisplay toolItem={createTodoWriteItem('in_progress')} config={config} />);
    });
    expect(container.querySelector('[data-openbitfun-part="todoList"]')).toBeNull();

    act(() => {
      container.querySelector<HTMLElement>('[data-testid="todo-tool-card-toggle"]')?.click();
    });
    expect(container.querySelector('[data-openbitfun-part="todoList"]')).not.toBeNull();

    act(() => {
      root.render(<TodoWriteDisplay toolItem={createTodoWriteItem('pending')} config={config} />);
    });
    expect(container.querySelector('[data-openbitfun-part="todoList"]')).not.toBeNull();

    act(() => {
      container.querySelector<HTMLElement>('[data-testid="todo-tool-card-toggle"]')?.click();
    });
    act(() => {
      vi.advanceTimersByTime(FLOWCHAT_COLLAPSE_DURATION_MS);
    });
    expect(container.querySelector('[data-openbitfun-part="todoList"]')).toBeNull();
  });

  it('shows the first task when all tasks are pending', () => {
    act(() => {
      root.render(
        <TodoWriteDisplay
          toolItem={createTodoWriteItem('pending', [
            { id: 'todo-a', content: 'First task', status: 'pending' },
            { id: 'todo-b', content: 'Second task', status: 'pending' },
          ])}
          config={config}
        />,
      );
    });

    const summary = container.querySelector('[data-openbitfun-tool-card="todo"] [data-openbitfun-part="summary"]');
    expect(summary?.textContent).toContain('First task');
    expect(summary?.textContent).not.toContain('Second task');
  });

  it('keeps the next task and expandable list prominent with a legacy compact config', () => {
    const toolItem = createTodoWriteItem('pending', [
      { id: 'todo-a', content: 'Finished task', status: 'completed' },
      { id: 'todo-b', content: 'Next task', status: 'pending' },
    ]);

    act(() => {
      root.render(<TodoWriteDisplay toolItem={toolItem} config={config} />);
    });
    const summary = container.querySelector('[data-openbitfun-part="summary"]');
    expect(summary?.textContent).toBe('Next task · 1/2');
    expect(container.querySelector('[data-openbitfun-component="icon"][data-openbitfun-name="list-todo"]')).not.toBeNull();
    expect(getToolCardConfig('TodoWrite').attention).toBe('prominent');
    expect(container.querySelector('[data-openbitfun-tool-card="todo"]')?.getAttribute('data-openbitfun-attention')).toBe('prominent');

    act(() => {
      root.render(<TodoWriteDisplay toolItem={toolItem} config={{ ...config, displayMode: 'compact' }} />);
    });
    expect(container.querySelector('[data-openbitfun-view="compact"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="summary"]')?.textContent).toBe('Next task · 1/2');
    act(() => {
      container.querySelector<HTMLElement>('[data-testid="todo-tool-card-toggle"]')?.click();
    });
    expect(container.querySelectorAll('[data-openbitfun-part="todoItem"]')).toHaveLength(2);
    expect(container.querySelector('[data-openbitfun-part="todoProgress"]')?.getAttribute('aria-valuenow')).toBe('1');
  });
});
