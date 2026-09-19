import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTimeoutIndicator } from './ToolTimeoutIndicator';

const setSubagentTimeoutMock = vi.hoisted(() => vi.fn());
const timeoutIndicatorStyles = readFileSync(
  new URL('./ToolTimeoutIndicator.scss', import.meta.url),
  'utf8',
);
const taskToolStyles = readFileSync(
  new URL('./TaskToolDisplay.scss', import.meta.url),
  'utf8',
);

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    setSubagentTimeout: setSubagentTimeoutMock,
  },
}));

let i18n: I18nInstance;
let JSDOMCtor: (new (
  html?: string,
  options?: { pretendToBeVisual?: boolean; url?: string }
) => { window: Window & typeof globalThis }) | null = null;

beforeAll(async () => {
  i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    resources: {
      'en-US': {
        'flow-chat': {
          toolCards: {
            timeout: {
              completedDurationTooltip: 'Completed in {{duration}}',
              failedDurationTooltip: 'Failed after {{duration}}',
              failedDurationTooltipWithReason: 'Failed after {{duration}}: {{reason}}',
              cancelledDurationTooltip: 'Cancelled after {{duration}}',
              durationTooltip: 'Duration {{duration}}',
              disableTooltip: 'Disable timeout',
              disableLabel: 'Ignore timeout',
            },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  const jsdom = await import('jsdom');
  JSDOMCtor = jsdom.JSDOM as typeof JSDOMCtor;
});

function withI18n(element: React.ReactElement): React.ReactElement {
  return (
    <I18nextProvider i18n={i18n}>
      {element}
    </I18nextProvider>
  );
}

function renderIndicator(element: React.ReactElement): string {
  return renderToStaticMarkup(withI18n(element));
}

describe('ToolTimeoutIndicator', () => {
  let dom: { window: Window & typeof globalThis } | null = null;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    dom = new JSDOMCtor!('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost',
    }) as unknown as { window: Window & typeof globalThis };

    const { window } = dom;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('navigator', window.navigator);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('HTMLDivElement', window.HTMLDivElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    setSubagentTimeoutMock.mockResolvedValue(undefined);
  });

  it('inherits regular card typography and uses proportional figures for durations', () => {
    const rootRule = timeoutIndicatorStyles.match(/\.tool-timeout-indicator\s*\{([^}]*)\}/s)?.[1];
    const durationRule = timeoutIndicatorStyles.match(/\.duration-text\s*\{([^}]*)\}/s)?.[1];

    expect(rootRule).toContain('font: inherit;');
    expect(rootRule).toContain('font-variant-numeric: proportional-nums;');
    expect(durationRule).toContain('font: inherit;');
    expect(durationRule).toContain('font-variant-numeric: proportional-nums;');
    expect(timeoutIndicatorStyles).not.toContain('tabular-nums');
    expect(timeoutIndicatorStyles).toMatch(
      /\.duration-text--completed-success\s*\{\s*color:\s*var\(--openbitfun-color-code-change-added\);/,
    );
    expect(taskToolStyles).not.toMatch(/\.duration-text(?:--[\w-]+)?\s*\{/);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
    }
    document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
    container?.remove();
    dom?.window.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    root = null;
    container = null;
    dom = null;
  });

  it('uses a success affordance for completed subagent durations', () => {
    const html = renderIndicator(
      <ToolTimeoutIndicator
        isRunning={false}
        completedDurationMs={1250}
        completedStatus="success"
      />,
    );

    expect(html).toContain('duration-text--completed-success');
    expect(html).toContain('Completed in 1.3s');
    expect(html).toContain('1.3s');
    expect(html).not.toContain('<svg');
  });

  it('hides completed duration when the card is collapsed', () => {
    const html = renderIndicator(
      <ToolTimeoutIndicator
        isRunning={false}
        completedDurationMs={1250}
        completedStatus="success"
        showCompletedDuration={false}
      />,
    );

    expect(html).toBe('');
  });

  it('uses an error affordance with the failure reason in the hover text', () => {
    const html = renderIndicator(
      <ToolTimeoutIndicator
        isRunning={false}
        completedDurationMs={2400}
        completedStatus="error"
        completedFailureReason="provider timed out"
      />,
    );

    expect(html).toContain('duration-text--completed-error');
    expect(html).toContain('Failed after 2.4s: provider timed out');
    expect(html).toContain('2.4s');
    expect(html).not.toContain('<svg');
  });

  it('does not render an ignore-timeout control before the subagent session is known', () => {
    const html = renderIndicator(
      <ToolTimeoutIndicator
        startTime={Date.now() - 10_000}
        isRunning
        timeoutMs={60_000}
        showControls
      />,
    );

    expect(html).not.toContain('timeout-ignore-btn');
    expect(html).not.toContain('Ignore timeout');
  });

  it('disables the running subagent timeout when the ignore control is clicked', async () => {
    await act(async () => {
      root!.render(withI18n(
        <ToolTimeoutIndicator
          startTime={Date.now() - 10_000}
          isRunning
          timeoutMs={60_000}
          showControls
          subagentSessionId="subagent-session"
        />,
      ));
    });

    const button = container!.querySelector<HTMLButtonElement>('.timeout-ignore-btn');
    expect(button).toBeTruthy();

    await act(async () => {
      button!.dispatchEvent(new dom!.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(setSubagentTimeoutMock).toHaveBeenCalledWith('subagent-session', { type: 'disable' });
  });

  it('portals the restore options outside clipped tool cards', async () => {
    await act(async () => {
      root!.render(withI18n(
        <ToolTimeoutIndicator
          startTime={Date.now() - 10_000}
          isRunning
          timeoutMs={60_000}
          showControls
          subagentSessionId="subagent-session"
          defaultTimeoutDisabled
        />,
      ));
    });

    const button = container!.querySelector<HTMLButtonElement>('.timeout-ignore-btn');
    await act(async () => {
      button!.dispatchEvent(new dom!.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const popover = document.querySelector<HTMLElement>('.timeout-extend-popover');
    expect(popover?.closest('[data-openbitfun-overlay-host]')?.getAttribute('data-openbitfun-overlay-host')).toBe('true');
    expect(popover?.style.visibility).toBe('visible');
  });
});
