// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearanceCompiler } from '@/infrastructure/appearance/compiler/AppearanceCompiler';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { APPEARANCE_SCHEMA_VERSION, type AppearancePackage } from '@/infrastructure/appearance/types';
import type { ModelRound } from '../../types/flow-chat';
import { ExportImageButton } from './ExportImageButton';
import { ModelRoundItem } from './ModelRoundItem';
import { exportImageAppearanceDescriptor } from './ExportImageButton.appearance';
import { modelRoundItemAppearanceDescriptor } from './ModelRoundItem.appearance';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  store: vi.fn(() => ({ sessions: new Map() })),
  copyText: vi.fn(() => 'Full transcript'),
  clipboard: vi.fn(async (_text: string) => undefined),
  error: vi.fn(),
  revealing: false,
  anchor: null as HTMLButtonElement | null,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/infrastructure/i18n', () => ({
  i18nService: { t: (key: string) => key },
  useI18n: () => ({ t: (key: string) => key, formatDate: () => '12:00' }),
}));
vi.mock('../../store/FlowChatStore', () => ({
  FlowChatStore: { getInstance: () => ({ getState: mocks.store }) },
}));
vi.mock('@/shared/notification-system', () => ({
  notificationService: { error: mocks.error, warning: vi.fn(), success: vi.fn() },
}));
vi.mock('@/shared/utils/useAnchoredPopoverPosition', () => ({
  useAnchoredPopoverPosition: ({ open, anchorRef }: {
    open: boolean; anchorRef: React.RefObject<HTMLButtonElement | null>;
  }) => {
    if (!open) return null;
    mocks.anchor = anchorRef.current;
    return { top: 80, left: 100, placement: 'top' };
  },
}));
vi.mock('@/infrastructure/appearance/runtime/AppearanceOverlayHost', () => ({
  getAppearanceOverlayHost: () => document.body,
}));
vi.mock('@/infrastructure/api', () => ({ workspaceAPI: {} }));
vi.mock('../FlowTextBlock', () => ({ FlowTextBlock: () => <span>Answer</span> }));
vi.mock('../FlowToolCard', () => ({ FlowToolCard: () => null }));
vi.mock('../../tool-cards/ModelThinkingDisplay', () => ({ ModelThinkingDisplay: () => null }));
vi.mock('../subagent/SubagentProjectionView', () => ({ SubagentProjectionView: () => null }));
vi.mock('./ForkSessionButton', () => ({ ForkSessionButton: () => null }));
vi.mock('./FlowChatContext', () => ({
  useFlowChatContext: () => ({ sessionId: 'session-1', allowTranscriptExport: true }),
}));
vi.mock('../../hooks/TypewriterRevealGate', () => ({
  TypewriterRevealGateProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../hooks/typewriterRevealGateContext', () => ({
  useCreateTypewriterRevealGate: () => ({ isAnyRevealing: mocks.revealing }),
}));
vi.mock('../../utils/dialogTurnCopy', () => ({ buildDialogTurnCopyText: mocks.copyText }));

const round: ModelRound = {
  id: 'round-1', index: 0, startTime: 1, status: 'completed',
  isStreaming: false, isComplete: true,
  items: [{ id: 'text-1', type: 'text', timestamp: 1, status: 'completed', content: 'Answer', isStreaming: false }],
};

// This package uses the pre-migration component/part/state names on disk.
const legacyPackage: AppearancePackage = {
  schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION,
  id: 'test.message-actions', name: 'Message actions', version: '1.0.0', mode: 'dark',
  components: {
    'model-round-item': { parts: {
      root: { base: { opacity: { kind: 'number', value: 0.9 } } },
      retryToggle: { base: { opacity: { kind: 'number', value: 0.6 } } },
      action: { states: { copied: { opacity: { kind: 'number', value: 0.8 } } } },
    } },
    'export-image': { parts: {
      trigger: { states: { exporting: { opacity: { kind: 'number', value: 0.7 } } } },
    } },
  },
};

function compileLegacyPackage() {
  const serialized = JSON.stringify(legacyPackage);
  const restored = JSON.parse(serialized) as AppearancePackage;
  const registry = new AppearanceRegistry()
    .registerComponent(modelRoundItemAppearanceDescriptor)
    .registerComponent(exportImageAppearanceDescriptor);
  const snapshot = new AppearanceCompiler(registry).compile(restored, 1);
  expect(JSON.stringify(restored)).toBe(serialized);
  document.documentElement.setAttribute('data-openbitfun-appearance', snapshot.id);
  document.documentElement.setAttribute('data-openbitfun-appearance-revision', String(snapshot.revision));
  const style = document.createElement('style');
  style.textContent = snapshot.cssText;
  document.head.appendChild(style);
  return style;
}

function expectCompiledRuleMatches(style: HTMLStyleElement, element: Element, opacity: string) {
  const rule = Array.from(style.sheet!.cssRules).find(candidate =>
    candidate instanceof CSSStyleRule && candidate.style.opacity === opacity,
  ) as CSSStyleRule | undefined;
  expect(rule).toBeDefined();
  expect(document.querySelector(rule!.selectorText)).toBe(element);
}

describe('message copy and image export controls', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.revealing = false;
    mocks.anchor = null;
    mocks.copyText.mockReturnValue('Full transcript');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.clipboard } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.head.querySelectorAll('style').forEach(style => style.remove());
    document.documentElement.removeAttribute('data-openbitfun-appearance');
    document.documentElement.removeAttribute('data-openbitfun-appearance-revision');
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('anchors the export menu to the button and retains inside/outside and Escape handling', () => {
    act(() => root.render(<ExportImageButton turnId="turn-1" />));
    const trigger = container.querySelector<HTMLButtonElement>('.model-round-item__export-btn')!;
    act(() => trigger.click());
    expect(mocks.anchor).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.export-image-menu')).not.toBeNull();
    act(() => trigger.querySelector('[data-openbitfun-part="icon"]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('.export-image-menu')).toBeNull();
    act(() => trigger.click());
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(document.querySelector('.export-image-menu')).toBeNull();
  });

  it.each(['exportImage.collapsedThinking', 'exportImage.expandedThinking'])(
    'retains pending feedback and recovers after a missing Turn through %s', async label => {
      const style = compileLegacyPackage();
      act(() => root.render(<ExportImageButton turnId="missing-turn" />));
      const trigger = container.querySelector<HTMLButtonElement>('.model-round-item__export-btn')!;
      act(() => trigger.click());
      const action = Array.from(document.querySelectorAll<HTMLButtonElement>('.export-image-menu button'))
        .find(button => button.textContent === label)!;
      act(() => action.click());
      expect(trigger.disabled).toBe(true);
      expect(trigger.querySelector('.spinning')).not.toBeNull();
      expect(trigger.getAttribute('data-loading')).toBe('false');
      expectCompiledRuleMatches(style, trigger, '0.7');
      act(() => trigger.click());
      expect(document.querySelector('.export-image-menu')).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(mocks.store).toHaveBeenCalledTimes(1);
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith('flow-chat:exportImage.dialogNotFound');
      expect(trigger.disabled).toBe(false);
      expect(trigger.querySelector('.spinning')).toBeNull();
    },
  );

  it.each(['full', 'result'] as const)('copies %s once and keeps legacy appearance on the copied button', async scope => {
    const style = compileLegacyPackage();
    act(() => root.render(<ModelRoundItem round={round} turnId="turn-1" isLastRound isTurnComplete />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="model-round-copy-btn"]')!;
    expectCompiledRuleMatches(style, container.querySelector('[data-testid="chat-assistant-message"]')!, '0.9');
    act(() => trigger.click());
    expect(mocks.anchor).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await act(async () => document.querySelector<HTMLButtonElement>(`[data-testid="model-round-copy-${scope}"]`)!.click());
    expect(mocks.copyText).toHaveBeenCalledExactlyOnceWith('turn-1', scope, expect.any(Object));
    expect(mocks.clipboard).toHaveBeenCalledExactlyOnceWith('Full transcript');
    expect(document.querySelector('[data-testid="model-round-copy-menu"]')).toBeNull();
    expectCompiledRuleMatches(style, trigger, '0.8');
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(trigger.classList.contains('copied')).toBe(false);
  });

  it('keeps copy disabled and outside the tab order while typewriter output is catching up', () => {
    mocks.revealing = true;
    act(() => root.render(<ModelRoundItem round={round} turnId="turn-1" isLastRound isTurnComplete />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="model-round-copy-btn"]')!;
    expect(trigger.disabled).toBe(true);
    expect(trigger.tabIndex).toBe(-1);
    act(() => trigger.click());
    expect(document.querySelector('[data-testid="model-round-copy-menu"]')).toBeNull();
  });

  it('expands a failed attempt and copies its diagnostic without changing the history state', async () => {
    const withHistory: ModelRound = {
      ...round,
      attempts: [
        {
          id: 'attempt-1', index: 0, status: 'failed', items: [],
          diagnostic: {
            attemptId: 'attempt-1', attemptIndex: 0,
            category: 'transient_request_error', rawError: 'Request timed out',
          },
        },
        { id: 'attempt-2', index: 1, status: 'completed', items: round.items },
      ],
    };
    act(() => root.render(<ModelRoundItem round={withHistory} turnId="turn-1" isLastRound isTurnComplete />));
    const historyCard = container.querySelector<HTMLElement>('.model-round-item__retry-toggle')!;
    expect(historyCard.getAttribute('data-openbitfun-component')).toBe('flow-chat-tool-card');
    expect(historyCard.getAttribute('data-openbitfun-attention')).toBe('ambient');
    expectCompiledRuleMatches(compileLegacyPackage(), historyCard, '0.6');
    const historyToggle = historyCard.querySelector<HTMLButtonElement>('[data-openbitfun-part="iconAffordanceButton"]')!;
    expect(historyToggle.getAttribute('aria-expanded')).toBe('false');
    act(() => historyToggle.click());
    expect(historyToggle.getAttribute('aria-expanded')).toBe('true');
    const toggle = container.querySelector<HTMLButtonElement>('.model-round-item__attempt-diagnostic-toggle')!;
    expect(toggle.tagName).toBe('BUTTON');
    const attemptLabel = toggle.querySelector<HTMLElement>('[data-openbitfun-product-part="attemptLabel"]')!;
    act(() => attemptLabel.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.textContent).toContain('Request timed out');
    const copy = container.querySelector<HTMLButtonElement>('.model-round-item__attempt-diagnostic-copy')!;
    await act(async () => copy.click());
    expect(mocks.clipboard).toHaveBeenCalledExactlyOnceWith('Request timed out');
    expect(copy.getAttribute('data-openbitfun-state')).toBe('copied');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => toggle.click());
    expect(container.querySelector('.model-round-item__attempt-diagnostic-details')).toBeNull();
    expect(container.querySelector('.model-round-item__retry-attempt')).not.toBeNull();
    act(() => historyToggle.click());
    expect(historyToggle.getAttribute('aria-expanded')).toBe('false');
    act(() => vi.runOnlyPendingTimers());
    expect(container.querySelector('.model-round-item__retry-attempt')).toBeNull();
  });
});
