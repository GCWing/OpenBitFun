// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearanceCompiler } from '@/infrastructure/appearance/compiler/AppearanceCompiler';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { APPEARANCE_SCHEMA_VERSION, type AppearancePackage } from '@/infrastructure/appearance/types';
import type { DialogTurn, FlowThinkingItem, ModelRound } from '../../types/flow-chat';
import { ExportContent, ExportImageButton } from './ExportImageButton';
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
  i18nService: { t: (key: string) => key, formatDate: () => 'Export date' },
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
vi.mock('../../tool-cards/ModelThinkingDisplay', () => ({
  ModelThinkingDisplay: ({ thinkingItem, forceExpanded }: { thinkingItem: FlowThinkingItem; forceExpanded: boolean }) => (
    <span data-testid="exported-thinking" data-expanded={String(forceExpanded)}>{thinkingItem.content}</span>
  ),
}));
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

  it.each([false, true])('exports complete user text and includes thinking only when requested (%s)', expandThinking => {
    const userText = 'First line\nSecond line\nThird line\nFourth line\nFinal line';
    const turn: DialogTurn = {
      id: 'turn-1', sessionId: 'session-1', status: 'completed', startTime: 1,
      userMessage: { id: 'user-1', content: userText, timestamp: 1 },
      modelRounds: [{
        ...round,
        items: [...round.items, {
          id: 'thinking-1', type: 'thinking', timestamp: 0, status: 'completed',
          content: 'Private thinking', isStreaming: false,
        }],
      }],
    };
    act(() => root.render(<ExportContent dialogTurn={turn} expandThinking={expandThinking} />));
    expect(container.querySelector('.export-content__user-bubble')?.textContent).toBe(userText);
    expect(container.querySelector('[data-openbitfun-product-part="text"]')?.textContent).toBe('Answer');
    expect(container.querySelector('.export-content__subtitle')).toBeNull();
    expect(container.textContent).not.toContain('exportImage.aiAssistant');
    expect(container.textContent).not.toContain('exportImage.subtitle');
    expect(container.querySelector('.export-content__timestamp')?.textContent).toBe('Export date');
    const thinking = container.querySelector('[data-openbitfun-product-part="thinking"]');
    if (expandThinking) {
      expect(thinking?.textContent).toBe('Private thinking');
      expect(thinking?.querySelector('[data-expanded="true"]')).not.toBeNull();
      expect(thinking?.compareDocumentPosition(container.querySelector('[data-openbitfun-product-part="text"]')!))
        .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    } else {
      expect(thinking).toBeNull();
      expect(container.querySelector('[data-testid="exported-thinking"]')).toBeNull();
      expect(container.textContent).not.toContain('Private thinking');
    }
  });

  it('uses the live user-message renderer for persisted reference capsules', () => {
    const turn: DialogTurn = {
      id: 'turn-1', sessionId: 'session-1', status: 'completed', startTime: 1,
      userMessage: {
        id: 'user-1', content: 'Read [$pdf]', timestamp: 1,
        metadata: { composerPresentation: {
          version: 1,
          segments: [
            { kind: 'text', text: 'Read ' },
            { kind: 'inline-token', token: '[$pdf]', tokenType: 'skill', label: 'pdf' },
          ],
        } },
      },
      modelRounds: [round],
    };
    act(() => root.render(<ExportContent dialogTurn={turn} expandThinking={false} />));
    const user = container.querySelector('.export-content__user-bubble')!;
    expect(user.querySelector('.message-reference-capsule--skill')?.textContent).toBe('pdf');
    expect(user.textContent).toBe('Read pdf');
    expect(user.textContent).not.toContain('[$pdf]');
  });

  it('opens export parameters without starting capture and dismisses with Escape or an outside press', () => {
    act(() => root.render(<ExportImageButton turnId="turn-1" />));
    const trigger = container.querySelector<HTMLButtonElement>('.model-round-item__export-btn')!;
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-testid="export-image-dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="export-image-compact"]'));
    expect(mocks.store).not.toHaveBeenCalled();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    act(() => vi.advanceTimersByTime(180));
    expect(document.querySelector('[data-testid="export-image-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    const overlay = document.querySelector('[data-testid="export-image-dialog"]')!.parentElement!;
    act(() => overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    act(() => vi.advanceTimersByTime(180));
    expect(document.querySelector('[data-testid="export-image-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it.each(['compact', 'thinking'])(
    'retains pending feedback and recovers after a missing Turn with %s output', async variant => {
      const style = compileLegacyPackage();
      act(() => root.render(<ExportImageButton turnId="missing-turn" />));
      const trigger = container.querySelector<HTMLButtonElement>('.model-round-item__export-btn')!;
      act(() => trigger.click());
      act(() => document.querySelector<HTMLInputElement>(`[data-testid="export-image-${variant}"]`)!.click());
      expect(mocks.store).not.toHaveBeenCalled();
      act(() => document.querySelector<HTMLButtonElement>('[data-testid="export-image-confirm"]')!.click());
      expect(trigger.disabled).toBe(true);
      expect(trigger.getAttribute('aria-busy')).toBe('true');
      expect(trigger.getAttribute('data-loading')).toBe('true');
      expectCompiledRuleMatches(style, trigger, '0.7');
      act(() => trigger.click());
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(mocks.store).toHaveBeenCalledTimes(1);
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith('flow-chat:exportImage.dialogNotFound');
      expect(trigger.disabled).toBe(false);
      expect(trigger.getAttribute('aria-busy')).toBeNull();
    },
  );

  it('selects illustrated checkbox cards through their preview and arrow keys without starting export', () => {
    act(() => root.render(<ExportImageButton turnId="turn-1" />));
    act(() => container.querySelector<HTMLButtonElement>('.model-round-item__export-btn')!.click());
    const dialog = document.querySelector<HTMLElement>('[data-testid="export-image-dialog"]')!;
    const compact = dialog.querySelector<HTMLInputElement>('[data-testid="export-image-compact"]')!;
    const thinking = dialog.querySelector<HTMLInputElement>('[data-testid="export-image-thinking"]')!;
    expect(dialog.querySelectorAll('[data-openbitfun-component="card"]')).toHaveLength(2);
    const compactCard = compact.closest('[data-openbitfun-component="card"]')!;
    const thinkingCard = thinking.closest('[data-openbitfun-component="card"]')!;
    expect(compact.type).toBe('checkbox');
    expect(thinking.type).toBe('checkbox');
    expect(compactCard.querySelector('[data-preview-thinking]')?.getAttribute('data-preview-thinking')).toBe('collapsed');
    expect(thinkingCard.querySelector('[data-preview-thinking]')?.getAttribute('data-preview-thinking')).toBe('expanded');
    act(() => thinkingCard.querySelector('[data-preview-thinking]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(thinking.checked).toBe(true);
    expect(compact.checked).toBe(false);
    act(() => thinking.click());
    expect(thinking.checked).toBe(true);
    expect(compact.checked).toBe(false);
    const press = (key: string) => act(() => (document.activeElement ?? thinking)
      .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    act(() => thinking.focus());
    press('ArrowLeft');
    expect(document.activeElement).toBe(compact);
    expect(compact.checked).toBe(true);
    expect(compact.tabIndex).toBe(0);
    expect(thinking.tabIndex).toBe(0);
    press('ArrowRight');
    expect(document.activeElement).toBe(thinking);
    press('Home');
    expect(document.activeElement).toBe(compact);
    press('End');
    expect(document.activeElement).toBe(thinking);
    expect(thinking.checked).toBe(true);
    expect(mocks.store).not.toHaveBeenCalled();
  });

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

  it.each(['compact', 'thinking'] as const)('confirms %s image parameters after opening the dialog from the copy menu', async variant => {
    act(() => root.render(<ModelRoundItem round={round} turnId="missing-turn" isLastRound isTurnComplete />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="model-round-copy-btn"]')!;
    expect(container.querySelector('.model-round-item__export-btn')).toBeNull();
    act(() => trigger.click());
    const menu = document.querySelector<HTMLElement>('[data-testid="model-round-copy-menu"]')!;
    expect(menu.textContent).toContain('exportImage.exportToImage');
    expect(menu.querySelectorAll('button')).toHaveLength(3);
    expect(menu.querySelector('[data-openbitfun-component="menu-section"]')).toBeNull();
    act(() => menu.querySelector<HTMLButtonElement>('[data-testid="model-round-export-image"]')!.click());
    expect(document.querySelector('[data-testid="model-round-copy-menu"]')).toBeNull();
    const dialog = document.querySelector<HTMLElement>('[data-testid="export-image-dialog"]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.querySelector<HTMLInputElement>('[data-testid="export-image-compact"]')!.checked).toBe(true);
    act(() => dialog.querySelector<HTMLInputElement>(`[data-testid="export-image-${variant}"]`)!.click());
    expect(dialog.querySelector<HTMLInputElement>(`[data-testid="export-image-${variant}"]`)!.checked).toBe(true);
    expect(mocks.store).not.toHaveBeenCalled();
    act(() => dialog.querySelector<HTMLButtonElement>('[data-testid="export-image-confirm"]')!.click());
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    expect(trigger.getAttribute('aria-label')).toBe('exportImage.exporting');
    act(() => trigger.click());
    expect(document.querySelector('[data-testid="model-round-copy-menu"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(mocks.store).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith('flow-chat:exportImage.dialogNotFound');
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-busy')).toBeNull();
    expect(trigger.getAttribute('aria-label')).toBe('modelRound.copyDialog');
    expect(mocks.clipboard).not.toHaveBeenCalled();
    act(() => trigger.click());
    expect(document.querySelector('[data-testid="model-round-copy-menu"]')).not.toBeNull();
  });

  it.each(['cancel', 'escape', 'outside'] as const)('dismisses export parameters through %s without exporting and returns focus to the copy button', async reason => {
    act(() => root.render(<ModelRoundItem round={round} turnId="turn-1" isLastRound isTurnComplete />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="model-round-copy-btn"]')!;
    act(() => trigger.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="model-round-export-image"]')!.click());
    const dialog = document.querySelector<HTMLElement>('[data-testid="export-image-dialog"]')!;
    act(() => dialog.querySelector<HTMLInputElement>('[data-testid="export-image-thinking"]')!.click());
    act(() => {
      if (reason === 'cancel') dialog.querySelector<HTMLButtonElement>('[data-testid="export-image-cancel"]')!.click();
      else if (reason === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else dialog.parentElement!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(document.querySelector('[data-testid="export-image-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="model-round-copy-menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.clipboard).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
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
