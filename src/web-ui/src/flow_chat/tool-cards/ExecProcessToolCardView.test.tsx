import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { ExecProcessToolCardView, type ExecProcessCardModel } from './ExecProcessToolCardView';
import type { FlowToolItem } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const messages: Record<string, string> = {
  'toolCards.terminal.cancelled': 'Cancelled',
  'toolCards.terminal.rejected': 'Rejected',
  'toolCards.terminal.receivingParams': 'Receiving parameters...',
  'toolCards.terminal.exitCode': 'Exit code: {{code}}',
  'toolCards.approval.waiting': 'Waiting for confirmation',
  'toolCards.execProcess.copyPrimary': 'Copy',
  'toolCards.execProcess.primaryCopied': 'Copied',
  'toolCards.execProcess.copyPrimaryFailed': 'Failed to copy',
};

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const template = messages[key] ?? key;
        return template.replace(/{{(\w+)}}/g, (_, name) => String(options?.[name] ?? ''));
      },
    }),
  };
});

vi.mock('@/tools/terminal/components/LazyTerminalOutputRenderer', () => ({
  LazyTerminalOutputRenderer: React.forwardRef<
    { getVisibleText: () => string },
    { content: string; className?: string; maxRows?: number }
  >(({ content, className, maxRows }, ref) => {
    React.useImperativeHandle(ref, () => ({ getVisibleText: () => content }), [content]);
    return <pre className={className} data-max-rows={maxRows}>{content}</pre>;
  }),
}));

const baseModel: ExecProcessCardModel = {
  kind: 'command',
  actionLabel: 'Run command:',
  primaryText: 'npm test',
  emptyText: '[No command]',
  copyText: 'npm test',
  waitingText: 'Running command...',
  noOutputText: 'No output',
  resultOutput: '',
};

function makeToolItem(status: FlowToolItem['status'], isParamsStreaming = false): FlowToolItem {
  return {
    id: 'tool-exec-1',
    type: 'tool',
    toolName: 'ExecCommand',
    status,
    timestamp: Date.now(),
    isParamsStreaming,
    toolCall: {
      id: 'call-exec-1',
      input: { cmd: 'npm test' },
    },
  };
}

describe.each([
  ['command', 'ExecCommand'],
  ['stdin', 'WriteStdin'],
  ['control', 'ExecControl'],
] as const)('ExecProcessToolCardView (%s)', (kind, toolName) => {
  const model: ExecProcessCardModel = { ...baseModel, kind };
  const toolItem = (status: FlowToolItem['status'], isParamsStreaming = false): FlowToolItem => ({
    ...makeToolItem(status, isParamsStreaming),
    toolName,
  });
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
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
    });

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const expandedSurface = '[data-openbitfun-part="surface"][data-openbitfun-state~="expanded"]';

  it.each(['_progressLogs', '_progressMessage'])('expands only when live output arrives through %s, then collapses on completion', (field) => {
    vi.useFakeTimers();
    for (const status of ['preparing', 'streaming', 'running', 'receiving'] as const) {
      act(() => {
        root.render(<ExecProcessToolCardView toolItem={toolItem(status)} model={model} />);
      });
      expect(container.querySelector(expandedSurface)).toBeNull();
    }

    act(() => {
      root.render(<ExecProcessToolCardView toolItem={{ ...toolItem('running'), [field]: field === '_progressLogs' ? [''] : '' } as FlowToolItem} model={model} />);
    });
    expect(container.querySelector(expandedSurface)).toBeNull();

    act(() => {
      root.render(<ExecProcessToolCardView toolItem={{ ...toolItem('running'), [field]: field === '_progressLogs' ? ['hello'] : 'hello' } as FlowToolItem} model={model} />);
    });
    expect(container.querySelector(expandedSurface)).not.toBeNull();
    expect(container.textContent).toContain('hello');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.querySelector(expandedSurface)).not.toBeNull();

    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('completed')} model={{ ...model, resultOutput: 'hello' }} />);
    });
    expect(container.querySelector(expandedSurface)).toBeNull();
  });

  it('stays collapsed when buffered output arrives only on completion', () => {
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('running')} model={model} isLastItem />);
    });
    expect(container.querySelector(expandedSurface)).toBeNull();
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('completed')} model={{ ...model, resultOutput: 'buffered output' }} isLastItem />);
    });
    expect(container.querySelector(expandedSurface)).toBeNull();
  });

  it('respects manual collapse when more output arrives', () => {
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={{ ...toolItem('running'), _progressLogs: ['hello'] } as FlowToolItem} model={model} />);
    });
    act(() => {
      container.querySelector<HTMLElement>(expandedSurface)!.click();
    });
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={{ ...toolItem('running'), _progressLogs: ['hello', 'world'] } as FlowToolItem} model={model} />);
    });
    expect(container.querySelector(expandedSurface)).toBeNull();
  });

  it('does not restart the minimum duration for more output or a tail change', () => {
    vi.useFakeTimers();
    const render = (status: FlowToolItem['status'], output: string, tail: boolean) => {
      root.render(<ExecProcessToolCardView
        toolItem={{ ...toolItem(status), _progressLogs: [output] } as FlowToolItem}
        model={{ ...model, resultOutput: output }}
        isLastItem={tail}
      />);
    };
    act(() => { render('running', 'first', true); });
    act(() => { vi.advanceTimersByTime(100); });
    act(() => { render('running', 'first\nsecond', false); });
    act(() => { render('completed', 'first\nsecond', false); });
    act(() => { vi.advanceTimersByTime(899); });
    expect(container.querySelector(expandedSurface)).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(container.querySelector(expandedSurface)).toBeNull();
  });

  it('lets manual toggles override a pending automatic collapse', () => {
    vi.useFakeTimers();
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={{ ...toolItem('running'), _progressLogs: ['hello'] } as FlowToolItem} model={model} />);
    });
    act(() => { vi.advanceTimersByTime(100); });
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('completed')} model={{ ...model, resultOutput: 'hello' }} />);
    });
    act(() => { container.querySelector<HTMLElement>(expandedSurface)!.click(); });
    expect(container.querySelector(expandedSurface)).toBeNull();
    act(() => {
      container.querySelector<HTMLElement>('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"]')!.click();
    });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.querySelector(expandedSurface)).not.toBeNull();
  });

  it('shows cancelled state instead of receiving params when a stale streaming flag remains', () => {
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('running', true)} model={model} />);
    });

    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('cancelled', true)} model={model} />);
    });

    expect(container.textContent).toContain('Cancelled');
    expect(container.textContent).not.toContain('Receiving parameters...');
  });

  it('shows rejected state for user-rejected command confirmation', () => {
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('rejected', true)} model={model} />);
    });

    expect(container.textContent).toContain('Rejected');
    expect(container.textContent).not.toContain('Receiving parameters...');
  });

  it('keeps legacy cancelled rejection state labeled as rejected', () => {
    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={{
            ...toolItem('cancelled', true),
            userConfirmed: false,
          }}
          model={model}
        />,
      );
    });

    expect(container.textContent).toContain('Rejected');
    expect(container.textContent).not.toContain('Receiving parameters...');
  });

  it('treats a non-zero exit code as command result data, not an execution failure', () => {
    const nonZeroExitModel: ExecProcessCardModel = {
      ...model,
      resultOutput: 'npm ERR! test failed',
      exitCode: 2,
      wallTimeSeconds: 1.25,
    };

    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={toolItem('completed')}
          model={nonZeroExitModel}
        />,
      );
    });

    act(() => {
      container
        .querySelector<HTMLElement>('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"]')
        ?.click();
    });

    const exitCodeItem = Array.from(
      container.querySelectorAll('[data-openbitfun-part="footer"] > span'),
    ).find((item) => item.textContent?.includes('Exit code: 2'));
    expect(exitCodeItem?.getAttribute('data-tone')).toBe('neutral');
    expect(container.querySelector('.duration-text--completed-error')).toBeNull();
    expect(container.querySelector('.duration-text--completed-success')).not.toBeNull();
  });

  it('shows waiting confirmation instead of receiving params while confirmation is pending', () => {    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('pending_confirmation', true)} model={model} />);
    });

    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]')).toBeNull();
    expect(container.textContent).toContain('Waiting for confirmation');
    expect(container.textContent).not.toContain('Receiving parameters...');
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="outputFrame"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="footer"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="output"] pre')).toBeNull();
  });

  it('retains a compact completed result when it stops being the tail', () => {
    vi.useFakeTimers();
    const resultModel: ExecProcessCardModel = {
      ...model,
      resultOutput: 'All tests passed',
    };

    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={{ ...toolItem('running'), _progressLogs: ['All tests passed'] } as FlowToolItem}
          model={resultModel}
          isLastItem
        />,
      );
    });

    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]')).toBeNull();

    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={toolItem('completed')}
          model={resultModel}
          isLastItem
        />,
      );
    });

    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]')).toBeNull();
    expect(container.textContent).toContain('All tests passed');
    expect(container.querySelector('[data-openbitfun-part="output"] pre')?.getAttribute('data-max-rows')).toBe('4');

    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={toolItem('completed')}
          model={resultModel}
          isLastItem={false}
        />,
      );
    });

    expect(container.querySelector(expandedSurface)).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1000); });
    // Collapsed cards keep the prominent framework shell and animate height closed.
    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"][data-openbitfun-state~="expanded"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="output"] pre')?.getAttribute('data-max-rows')).toBe('4');
  });

  it('uses the expanded output preview after a completed card is manually expanded', () => {
    const resultModel: ExecProcessCardModel = {
      ...model,
      resultOutput: 'All tests passed',
    };

    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={toolItem('completed')}
          model={resultModel}
        />,
      );
    });

    act(() => {
      container
        .querySelector<HTMLElement>('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"]')
        ?.click();
    });

    expect(container.querySelector('[data-openbitfun-part="output"] pre')?.getAttribute('data-max-rows')).toBe('15');
    expect(container.querySelector('[data-openbitfun-part="outputFrame"]')?.getAttribute('data-density')).toBe('expanded');
    expect(container.querySelector('[data-openbitfun-part="outputFrame"]')?.getAttribute('data-sizing')).toBe('content');
  });

  it('content-sizes a manually expanded completed card with no output', () => {
    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={toolItem('completed')}
          model={model}
        />,
      );
    });

    act(() => {
      container
        .querySelector<HTMLElement>('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"]')
        ?.click();
    });

    expect(container.textContent).toContain('No output');
    expect(container.querySelector('[data-openbitfun-part="outputFrame"]')?.getAttribute('data-density')).toBe('expanded');
    expect(container.querySelector('[data-openbitfun-part="outputFrame"]')?.getAttribute('data-sizing')).toBe('content');
  });

  it('pushes session and execution metadata to the footer end', () => {
    const metadataModel: ExecProcessCardModel = {
      ...model,
      sessionId: 42,
      exitCode: 0,
      wallTimeSeconds: 1.25,
    };

    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={toolItem('completed')}
          model={metadataModel}
        />,
      );
    });

    act(() => {
      container
        .querySelector<HTMLElement>('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"]')
        ?.click();
    });

    const footerItems = Array.from(container.querySelectorAll('[data-openbitfun-part="footer"] > span'));
    expect(footerItems).toHaveLength(3);
    expect(footerItems[0]?.getAttribute('data-push-to-end')).toBe('true');
    expect(footerItems[0]?.textContent).toContain('#42');
    expect(footerItems[1]?.getAttribute('data-push-to-end')).toBe('false');
    expect(footerItems[1]?.textContent).toContain(kind === 'stdin' ? 'toolCards.execProcess.wallTime' : 'Exit code: 0');
    expect(footerItems[2]?.getAttribute('data-push-to-end')).toBe('false');
    expect(footerItems[2]?.textContent).toContain(kind === 'stdin' ? 'Exit code: 0' : 'toolCards.execProcess.wallTime');
  });

  it('keeps the output frame and footer mounted while content changes', () => {
    const streamingItem = {
      ...toolItem('running'),
      _progressLogs: ['line 1\nline 2\nline 3\nline 4'],
    } as FlowToolItem;
    const completedModel: ExecProcessCardModel = {
      ...model,
      resultOutput: 'line 1\nline 2\nline 3\nline 4',
      workdir: 'E:/workspace',
      exitCode: 0,
      wallTimeSeconds: 1.25,
    };

    act(() => {
      root.render(<ExecProcessToolCardView toolItem={streamingItem} model={model} />);
    });
    const frameBeforeOutput = container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="outputFrame"]');
    const footerBeforeOutput = container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="footer"]');
    expect(frameBeforeOutput?.getAttribute('data-density')).toBe('compact');
    expect(frameBeforeOutput?.getAttribute('data-sizing')).toBe('fixed');
    expect(footerBeforeOutput?.textContent).toBe('');
    expect(container.querySelector('[data-openbitfun-part="output"] pre')).not.toBeNull();

    act(() => {
      root.render(<ExecProcessToolCardView toolItem={{ ...streamingItem, _progressLogs: ['more output'] } as FlowToolItem} model={model} />);
    });
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="outputFrame"]')).toBe(frameBeforeOutput);
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="footer"]')).toBe(footerBeforeOutput);
    expect(container.querySelector('[data-openbitfun-part="output"] pre')).not.toBeNull();

    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={toolItem('completed')}
          model={completedModel}
          isLastItem
        />,
      );
    });
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="outputFrame"]')).toBe(frameBeforeOutput);
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="footer"]')).toBe(footerBeforeOutput);
    expect(footerBeforeOutput?.textContent).toContain('E:/workspace');
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="outputFrame"]')?.getAttribute('data-density')).toBe('compact');
  });

  it.each([true, false])('keeps a command expanded for 1000ms from first output (tail=%s)', (isLastItem) => {
    vi.useFakeTimers();
    const resultModel: ExecProcessCardModel = {
      ...model,
      resultOutput: 'All tests passed',
    };

    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={{ ...toolItem('running'), _progressLogs: ['All tests passed'] } as FlowToolItem}
          model={resultModel}
          isLastItem={isLastItem}
        />,
      );
    });

    act(() => { vi.advanceTimersByTime(100); });
    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={toolItem('completed')}
          model={resultModel}
          isLastItem={isLastItem}
        />,
      );
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(899);
    });
    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"][data-openbitfun-state~="expanded"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('[data-openbitfun-part="surface"][data-openbitfun-attention="prominent"][data-openbitfun-state~="expanded"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="details"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="details"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('[data-openbitfun-component="command-tool-card"] [data-openbitfun-part="details"]')).toBeNull();
  });
});
