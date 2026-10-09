import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { ReadFileDisplay } from './ReadFileDisplay';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const messages: Record<string, string> = {
  'toolCards.readFile.permissionRequest': 'Requesting read permission:',
};

const readConfig: ToolCardConfig = {
  attention: 'ambient',
  presentation: 'standard',
  toolName: 'Read',
  displayName: 'Read File',
  icon: 'R',
  requiresConfirmation: false,
  resultDisplayType: 'summary',
  description: 'Read file contents',
  displayMode: 'compact',
};

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) => messages[key] ?? options?.defaultValue ?? key,
    }),
  };
});

describe('ReadFileDisplay', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.unstubAllGlobals();
  });

  it('renders pending read confirmation copy without inline approval actions', () => {
    const toolItem: FlowToolItem = {
      id: 'tool-read-1',
      type: 'tool',
      toolName: 'Read',
      status: 'pending_confirmation',
      timestamp: Date.now(),
      requiresConfirmation: true,
      userConfirmed: false,
      toolCall: {
        id: 'call-read-1',
        input: {
          file_path: '/',
        },
      },
      acpPermission: {
        permissionId: 'perm-1',
        requestedAt: Date.now(),
        options: [
          {
            optionId: 'once',
            name: 'Allow once',
            kind: 'allow_once',
          },
          {
            optionId: 'reject',
            name: 'Reject',
            kind: 'reject_once',
          },
        ],
      },
    };

    act(() => {
      root.render(
        <ReadFileDisplay
          toolItem={toolItem}
          config={readConfig}
        />
      );
    });

    expect(container.textContent).toContain('Requesting read permission:');
    expect(container.textContent).toContain('/');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('does not report a file size for session preview truncation markers', () => {
    const toolItem: FlowToolItem = {
      id: 'tool-read-2',
      type: 'tool',
      toolName: 'Read',
      status: 'completed',
      timestamp: Date.now(),
      toolCall: {
        id: 'call-read-2',
        input: {
          file_path: 'src/main.rs',
        },
      },
      toolResult: {
        id: 'result-read-2',
        result: {
          content: '[truncated for session view]',
        },
        timestamp: Date.now(),
      },
    };

    act(() => {
      root.render(
        <ReadFileDisplay
          toolItem={toolItem}
          config={readConfig}
        />
      );
    });

    expect(container.textContent).toContain('main.rs');
    expect(container.textContent).not.toMatch(/\(\d+B\)/);
  });

  it('opens a completed file from Enter or Space without a second clickable flag', () => {
    const onOpenInEditor = vi.fn();
    const toolItem: FlowToolItem = {
      id: 'tool-read-keyboard',
      type: 'tool',
      toolName: 'Read',
      status: 'completed',
      timestamp: Date.now(),
      toolCall: {
        id: 'call-read-keyboard',
        input: {
          file_path: 'src/keyboard.ts',
        },
      },
    };

    act(() => {
      root.render(
        <ReadFileDisplay
          toolItem={toolItem}
          config={readConfig}
          onOpenInEditor={onOpenInEditor}
        />
      );
    });

    const card = container.querySelector<HTMLElement>('[data-openbitfun-tool-card="read-file"]');
    expect(card?.getAttribute('role')).toBe('button');
    expect(card?.tabIndex).toBe(0);

    act(() => {
      card?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Enter',
      }));
      card?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        key: ' ',
      }));
    });

    expect(onOpenInEditor).toHaveBeenCalledTimes(2);
    expect(onOpenInEditor).toHaveBeenLastCalledWith('src/keyboard.ts');
  });

  it('opens a completed file once from its trailing button and preserves the row action', () => {
    const onOpenInEditor = vi.fn();
    const toolItem: FlowToolItem = {
      id: 'tool-read-action',
      type: 'tool',
      toolName: 'Read',
      status: 'completed',
      timestamp: Date.now(),
      toolCall: {
        id: 'call-read-action',
        input: { file_path: 'src/action.ts' },
      },
    };

    act(() => {
      root.render(
        <ReadFileDisplay
          toolItem={toolItem}
          config={readConfig}
          onOpenInEditor={onOpenInEditor}
        />
      );
    });

    const openButton = container.querySelector<HTMLButtonElement>(
      '[data-openbitfun-part="actionRegion"] button',
    );
    expect(openButton).not.toBeNull();
    expect(openButton?.type).toBe('button');
    expect(openButton?.disabled).toBe(false);
    expect(openButton?.getAttribute('aria-label')).toBeTruthy();

    act(() => {
      openButton?.querySelector('svg')?.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
      }));
    });
    expect(onOpenInEditor).toHaveBeenCalledTimes(1);
    expect(onOpenInEditor).toHaveBeenLastCalledWith('src/action.ts');

    openButton?.focus();
    expect(dom.window.document.activeElement).toBe(openButton);
    for (const key of ['Enter', ' ']) {
      const event = new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key,
      });
      act(() => { openButton?.dispatchEvent(event); });
      // Let the native button own activation; the row must not cancel or handle it.
      expect(event.defaultPrevented).toBe(false);
      expect(onOpenInEditor).toHaveBeenCalledTimes(1);
    }

    act(() => { openButton?.click(); });
    expect(onOpenInEditor).toHaveBeenCalledTimes(2);

    const surface = container.querySelector<HTMLElement>('[data-openbitfun-part="surface"]');
    act(() => { surface?.click(); });
    expect(onOpenInEditor).toHaveBeenCalledTimes(3);
    expect(onOpenInEditor).toHaveBeenLastCalledWith('src/action.ts');
  });
});
