// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowItem, FlowTextItem, FlowThinkingItem, FlowToolItem, ModelRound } from '../../types/flow-chat';
import { ModelRoundItem } from './ModelRoundItem';
import { ExploreGroupRenderer } from './ExploreGroupRenderer';
import { SubagentProjectionView } from '../subagent/SubagentProjectionView';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import { projectAdjacentExploreGroups } from './exploreGroupProjection';
import { toolCapsuleStateKey } from '../../tool-cards/toolCapsuleModel';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/infrastructure/i18n', () => ({
  i18nService: { t: (key: string) => key },
  useI18n: () => ({ t: (key: string) => key, formatDate: () => '12:00', formatNumber: String }),
}));
vi.mock('@/infrastructure/markdown', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
  ThinkingMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('../../store/FlowChatStore', () => {
  const store = { getState: () => ({ sessions: new Map() }) };
  return { flowChatStore: store, FlowChatStore: { getInstance: () => store } };
});
vi.mock('@/shared/notification-system', () => ({
  notificationService: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));
vi.mock('@/infrastructure/api', () => ({ workspaceAPI: {} }));
vi.mock('../../services/btwSessionPane', () => ({ ensureBtwSessionAvailable: vi.fn() }));
vi.mock('../../utils/dialogTurnCopy', () => ({ buildDialogTurnCopyText: vi.fn() }));
vi.mock('./ExportImageButton', () => ({ ExportImageButton: () => null }));
vi.mock('./ForkSessionButton', () => ({ ForkSessionButton: () => null }));
const exploreState = vi.hoisted(() => ({
  exploreGroupStates: new Map<string, boolean>(),
  expandedToolCapsules: new Set<string>(),
  onExpandGroup: vi.fn(),
}));
vi.mock('./FlowChatContext', () => ({
  useFlowChatContext: () => ({ sessionId: 'visibility-session', onExpandGroup: exploreState.onExpandGroup }),
  useFlowChatVolatileContext: () => exploreState,
}));
// A probe tests composition's filtering before a card is invoked. Geometry and
// visual appearance are deliberately outside this DOM/lifecycle regression.
vi.mock('../FlowToolCard', () => ({
  FlowToolCard: ({ toolItem, isLastItem, parallel }: { toolItem: FlowToolItem; isLastItem?: boolean; parallel?: boolean }) => (
    <div data-test-tool-id={toolItem.id} data-test-last-item={String(isLastItem === true)} data-test-parallel={String(parallel === true)}>
      {toolItem.toolName}
    </div>
  ),
}));

const thinking: FlowThinkingItem = {
  id: 'thinking', type: 'thinking', timestamp: 1, status: 'completed',
  content: 'Reasoning', isStreaming: false, isCollapsed: true,
};
const blank: FlowTextItem = {
  id: 'blank', type: 'text', timestamp: 2, status: 'completed',
  content: ' \n\t', isStreaming: false,
};
const read: FlowToolItem = {
  id: 'read', type: 'tool', timestamp: 3, status: 'completed',
  toolName: 'Read', toolCall: { id: 'read', input: { file_path: 'demo.html' } },
};
const hidden = { ...read, status: 'error' as const };
const edit: FlowToolItem = {
  ...read, id: 'edit', toolName: 'Edit', toolCall: { id: 'edit', input: {} },
};
type Host = 'round' | 'explore' | 'subagent';

function renderHost(host: Host, items: FlowItem[], disableExploreGrouping = false) {
  if (host === 'round') {
    const round: ModelRound = {
      id: 'round', index: 0, startTime: 1, status: 'completed',
      isStreaming: false, isComplete: true, items,
      renderHints: { disableExploreGrouping },
    };
    return <ModelRoundItem round={round} turnId="turn" isLastRound isTurnComplete={false} />;
  }
  if (host === 'explore') {
    return <ExploreGroupRenderer turnId="turn" data={{
      groupId: 'explore', rounds: [], allItems: items,
      stats: { readCount: 1, searchCount: 0, commandCount: 0 },
      isGroupStreaming: false, isLastGroupInTurn: true, wasCutByCritical: false,
    }} />;
  }
  return <SubagentProjectionView parentTaskToolId="task" subagentSessionId="child" items={items} />;
}

describe('visible FlowChat item composition', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    exploreState.exploreGroupStates.clear();
    exploreState.exploreGroupStates.set('explore', true);
    exploreState.expandedToolCapsules.clear();
    exploreState.onExpandGroup.mockClear();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the first live thought compact despite the parent trailing-item hint', () => {
    const live = { ...thinking, status: 'streaming' as const, isStreaming: true };
    const round: ModelRound = { id: 'first-round', index: 0, startTime: 1,
      status: 'streaming', isStreaming: true, isComplete: false, items: [live],
      renderHints: { disableExploreGrouping: true } };
    act(() => root.render(<ModelRoundItem round={round} turnId="turn" isLastRound
      expandedThinkingItemIds={[live.id]} />));
    const panel = container.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
    const button = container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;
    expect(panel.dataset.streamingExpanded).toBe('false');
    act(() => button.click());
    expect(panel.dataset.streamingExpanded).toBe('true');
    act(() => button.click());
    expect(panel.dataset.streamingExpanded).toBe('false');
  });

  it.each<Host>(['round', 'explore', 'subagent'])('%s keeps a live one-line body mounted', host => {
    const live = { ...thinking, status: 'streaming' as const, isStreaming: true };
    act(() => root.render(renderHost(host, [live], true)));
    const panel = container.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
    expect(panel.dataset.streamingExpanded).toBe('false');
    expect(panel.querySelector('[data-testid="chat-thinking-content"]')?.textContent).toContain(live.content);
  });

  it('keeps the first live thought compact despite the parent trailing-item hint', () => {
    const live = { ...thinking, status: 'streaming' as const, isStreaming: true };
    const round: ModelRound = { id: 'first-round', index: 0, startTime: 1,
      status: 'streaming', isStreaming: true, isComplete: false, items: [live],
      renderHints: { disableExploreGrouping: true } };
    act(() => root.render(<ModelRoundItem round={round} turnId="turn" isLastRound
      expandedThinkingItemIds={[live.id]} />));
    const panel = container.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
    const button = container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;
    expect(panel.dataset.streamingExpanded).toBe('false');
    act(() => button.click());
    expect(panel.dataset.streamingExpanded).toBe('true');
    act(() => button.click());
    expect(panel.dataset.streamingExpanded).toBe('false');
  });

  it.each<Host>(['round', 'explore', 'subagent'])('%s keeps a live one-line body mounted', host => {
    const live = { ...thinking, status: 'streaming' as const, isStreaming: true };
    act(() => root.render(renderHost(host, [live], true)));
    const panel = container.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
    expect(panel.dataset.streamingExpanded).toBe('false');
    expect(panel.querySelector('[data-testid="chat-thinking-content"]')?.textContent).toContain(live.content);
  });

  it.each<Host>(['round', 'explore', 'subagent'])('%s docks thinking beside the next visible card without ghost rows', host => {
    act(() => root.render(renderHost(host, [thinking, blank, hidden, edit])));
    const panel = container.querySelector('[data-testid="chat-thinking-panel"]');
    expect(panel?.getAttribute('data-thinking-attachment')).toBe('side');
    expect(panel?.getAttribute('data-expanded')).toBe('false');
    expect(panel?.nextElementSibling?.getAttribute('data-flow-item-id')).toBe('edit');
    expect(panel?.nextElementSibling?.hasAttribute('data-thinking-continuation')).toBe(true);
    expect(container.querySelectorAll('.flowchat-flow-item')).toHaveLength(1);
    expect(container.querySelector('.flow-text-block')).toBeNull();
    expect(container.querySelector('[data-test-tool-id="read"]')).toBeNull();
    expect(container.querySelector('[data-test-tool-id="edit"]')?.getAttribute('data-test-last-item')).toBe('true');
  });

  it.each<Host>(['round', 'explore', 'subagent'])('%s retains neighboring nodes when a failed read disappears', host => {
    const text: FlowTextItem = { ...blank, id: 'answer', content: 'Answer' };
    act(() => root.render(renderHost(host, [thinking, { ...read, status: 'running' }, edit, text], true)));
    const panel = container.querySelector('[data-testid="chat-thinking-panel"]')!;
    const button = container.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;
    const editNode = container.querySelector('[data-flow-item-id="edit"]');
    const textNode = container.querySelector('.flow-text-block');
    expect(panel.getAttribute('data-expanded')).toBe('false');

    act(() => root.render(renderHost(host, [thinking, blank, hidden, edit, text], true)));
    expect(container.querySelector('[data-testid="chat-thinking-panel"]')).toBe(panel);
    expect(container.querySelector('[data-testid="chat-thinking-toggle"]')).toBe(button);
    expect(panel.getAttribute('data-expanded')).toBe('false');
    expect(panel.nextElementSibling).toBe(editNode);
    expect(container.querySelector('[data-flow-item-id="read"]')).toBeNull();
    expect(container.querySelector('[data-flow-item-id="edit"]')).toBe(editNode);
    expect(container.querySelector('.flow-text-block')).toBe(textNode);
    expect(container.querySelectorAll('.flowchat-flow-item')).toHaveLength(1);
  });

  it.each<Host>(['round', 'explore', 'subagent'])('%s uses the last visible item for reasoning disclosure', host => {
    act(() => root.render(renderHost(host, [thinking, blank, hidden])));
    const panel = container.querySelector('[data-testid="chat-thinking-panel"]');
    expect(panel?.getAttribute('data-expanded')).toBe('false');
    expect(panel?.hasAttribute('data-thinking-attachment')).toBe(false);
  });

  it.each<Host>(['explore', 'subagent'])('%s leaves no empty group shell', host => {
    act(() => root.render(renderHost(host, [blank, hidden])));
    expect(container.childElementCount).toBe(0);
  });

  it('collects visible exploration across hidden failures without losing text or counting failures', () => {
    const intro = { ...blank, id: 'intro', content: 'Inspect the workspace' };
    const conclusion = { ...blank, id: 'conclusion', content: 'The result is ready' };
    const grep = { ...read, id: 'grep', toolName: 'Grep' };
    const glob = { ...read, id: 'glob', toolName: 'Glob' };
    const failed = { ...hidden, id: 'failed' };
    const items = [intro, grep, glob, failed, read, conclusion];
    act(() => root.render(renderHost('round', items)));

    const groups = container.querySelectorAll('[data-testid="chat-explore-group"]');
    expect(groups).toHaveLength(1);
    expect(groups[0].getAttribute('data-search-count')).toBe('2');
    expect(groups[0].getAttribute('data-read-count')).toBe('1');
    for (const group of groups) expect(group.getAttribute('data-expanded')).toBe('false');
    expect(container.querySelector('[data-test-tool-id="failed"]')).toBeNull();
    for (const id of ['grep', 'glob', 'read']) {
      expect(container.querySelector(`[data-test-tool-id="${id}"]`)).toBeNull();
    }
    expect(container.textContent).toContain(intro.content);
    expect(container.textContent).toContain(conclusion.content);
    expect(items.map(item => item.id)).toEqual(['intro', 'grep', 'glob', 'failed', 'read', 'conclusion']);
  });

  it('collects a successful search without remounting surrounding narrative or a running call', () => {
    const text = { ...blank, id: 'intro', content: 'Searching the workspace' };
    const search = { ...read, id: 'search', toolName: 'Grep', status: 'running' as const };
    const pending = { ...read, id: 'pending', status: 'pending_confirmation' as const };
    act(() => root.render(renderHost('round', [text, search, pending])));
    const textNode = container.querySelector('.flow-text-block');
    const pendingNode = container.querySelector('[data-flow-item-id="pending"]');
    const groupNode = container.querySelector('[data-testid="chat-explore-group"]');
    expect(groupNode?.getAttribute('data-expanded')).toBe('true');

    act(() => root.render(renderHost('round', [text, { ...search, status: 'completed' }, pending])));
    act(() => vi.advanceTimersByTime(350));
    expect(container.querySelector('[data-testid="chat-explore-group"]')).toBe(groupNode);
    expect(container.querySelector('[data-testid="chat-explore-group"]')?.getAttribute('data-expanded')).toBe('false');
    expect(container.querySelector('[data-test-tool-id="search"]')).toBeNull();
    expect(container.querySelector('.flow-text-block')).toBe(textNode);
    expect(container.querySelector('[data-flow-item-id="pending"]')).toBe(pendingNode);
  });

  it('opens the collected card while keeping completed reasoning in its side disclosure', () => {
    const text = { ...blank, id: 'intro', content: 'Checking the implementation' };
    act(() => root.render(renderHost('round', [text, thinking, read])));
    expect(container.textContent).toContain(text.content);
    expect(container.querySelector('[data-testid="chat-thinking-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-explore-group"]')?.getAttribute('data-expanded')).toBe('false');
    expect(container.querySelector('[data-test-tool-id="read"]')).toBeNull();
    exploreState.exploreGroupStates.set('round:explore:read', true);
    act(() => root.render(renderHost('round', [text, thinking, read])));
    const panel = container.querySelector('[data-testid="chat-thinking-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.closest('[data-testid="chat-explore-group"]')).not.toBeNull();
    expect(panel?.getAttribute('data-expanded')).toBe('false');
    expect(panel?.getAttribute('data-thinking-attachment')).toBe('side');
    expect(panel?.getAttribute('data-scroll-owner')).toBe('self');
    expect(container.querySelector('[data-test-tool-id="read"]')).not.toBeNull();
  });

  it.each<Host>(['round', 'explore'])('%s keeps native tool rows separate even when execution overlaps', host => {
    const timed = (id: string, start: number, end: number) => ({
      ...read, id, startTime: start, endTime: end, executionMs: end - start,
    });
    act(() => root.render(renderHost(host, [
      timed('serial', 0, 100), timed('a', 100, 200), timed('b', 100, 200),
      timed('c', 200, 300), timed('d', 200, 300),
    ], true)));
    expect(container.querySelector('[data-test-tool-id="serial"]')?.getAttribute('data-test-parallel')).toBe('false');
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(container.querySelector(`[data-test-tool-id="${id}"]`)?.getAttribute('data-test-parallel')).toBe('false');
    }
    expect(container.querySelectorAll('.flowchat-capsule-row-break')).toHaveLength(0);
  });

  it('keeps AgentWait calls as independent native rows', () => {
    const timed = (id: string, start: number, end: number) => ({
      ...read, id, toolName: 'AgentWait', toolCall: { id, input: { agent_ids: [id] } },
      startTime: start, endTime: end, executionMs: end - start,
    });
    act(() => root.render(renderHost('round', [
      timed('serial', 0, 100), timed('a', 100, 200), timed('b', 100, 200),
      timed('c', 200, 300), timed('d', 200, 300),
    ], true)));
    expect(container.querySelector('[data-test-tool-id="serial"]')?.getAttribute('data-test-parallel')).toBe('false');
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(container.querySelector(`[data-test-tool-id="${id}"]`)?.getAttribute('data-test-parallel')).toBe('false');
    }
    expect(container.querySelectorAll('.flowchat-capsule-row-break')).toHaveLength(0);
  });

  it('ignores stale capsule expansion for native tools and still honors explicit group expansion', () => {
    const deferred = {
      ...read, toolName: 'CallDeferredTool',
      toolCall: { ...read.toolCall, input: { tool_name: 'Read', args: read.toolCall.input } },
    };
    exploreState.expandedToolCapsules.add(toolCapsuleStateKey('visibility-session', 'turn', read.id));
    for (const item of [read, deferred]) {
      exploreState.exploreGroupStates.set('explore', false);
      act(() => root.render(renderHost('explore', [item])));
      expect(container.querySelector('[data-testid="chat-explore-group"]')?.getAttribute('data-expanded')).toBe('false');
      expect(exploreState.onExpandGroup).not.toHaveBeenCalled();
    }
    exploreState.exploreGroupStates.set('explore', true);
    act(() => root.render(renderHost('explore', [read])));
    expect(container.querySelector('[data-testid="chat-explore-group"]')?.getAttribute('data-expanded')).toBe('true');
    expect(container.querySelector('[data-test-tool-id="read"]')).not.toBeNull();
  });

  it('appends adjacent rounds into the existing inline header without remounting it or the narrative', () => {
    const narrative = { ...blank, id: 'intro', content: 'Inspecting source' };
    const row: Extract<VirtualItem, { type: 'model-round' }> = {
      type: 'model-round', turnId: 'turn', isLastRound: false, isTurnComplete: false,
      data: { id: 'round', index: 0, startTime: 1, status: 'completed', isComplete: true, isStreaming: false, items: [narrative, read] },
    };
    const later: Extract<VirtualItem, { type: 'explore-group' }> = {
      type: 'explore-group', turnId: 'turn', data: {
        groupId: 'later', rounds: [], allItems: [{ ...read, id: 'grep', toolName: 'Grep' }],
        stats: { readCount: 0, searchCount: 1, commandCount: 0 }, isGroupStreaming: false,
        isLastGroupInTurn: true, wasCutByCritical: false,
      },
    };
    function renderRows(items: VirtualItem[]) {
      return projectAdjacentExploreGroups(items).map(item => item.type === 'model-round'
        ? <ModelRoundItem key={item.data.id} round={item.data} turnId={item.turnId} projectedGroups={item.projectedGroups} />
        : item.type === 'explore-group' ? <ExploreGroupRenderer key={item.data.groupId} data={item.data} turnId={item.turnId} /> : null);
    }
    act(() => root.render(renderRows([row])));
    const group = container.querySelector('[data-testid="chat-explore-group"]');
    const paragraph = container.querySelector('.flow-text-block');
    expect(group?.getAttribute('data-placement')).toBe('inline');
    act(() => root.render(renderRows([row, later])));
    expect(container.querySelectorAll('[data-testid="chat-explore-group"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="chat-explore-group"]')).toBe(group);
    expect(container.querySelector('.flow-text-block')).toBe(paragraph);
    expect(group?.getAttribute('data-read-count')).toBe('1');
    expect(group?.getAttribute('data-search-count')).toBe('1');
  });
});
