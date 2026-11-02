// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TimelineContentBlock } from './TimelineContentBlock';
import { FlowChatReaderProvider, FlowChatReaderState, useFlowChatReaderValue } from './readerState';
import type { VirtualItem } from '../types/flow-chat-projection';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatNumber: String }) }));
vi.mock('../components/modern/FlowChatContext', () => ({ useFlowChatContext: () => ({}) }));
vi.mock('../components/modern/FlowGroupRenderer', () => ({ FlowGroupItemRenderer: ({ item }: { item: { id: string } }) => {
  const [draft, setDraft] = useFlowChatReaderValue(`draft:${item.id}`, '');
  return <input aria-label={item.id} value={draft} onChange={event => setDraft(event.target.value)} />;
} }));

it('retains an active card node and native selection when the same source enters or leaves a group', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), reader = new FlowChatReaderState();
  const item = { type: 'model-round', turnId: 't', isLastRound: true, isTurnComplete: false,
    data: { id: 'r', index: 0, items: [{ id: 'a', type: 'tool', toolName: 'Read', status: 'running', toolCall: { id: 'a', input: {} } }], isStreaming: true },
    timeline: { key: 't:a', kind: 'content', memberIds: ['a'], sourceIndex: 0 } } as Extract<VirtualItem, { type: 'model-round' }>;
  const render = (next: typeof item) => act(() => root.render(<FlowChatReaderProvider store={reader}><TimelineContentBlock item={next} /></FlowChatReaderProvider>));
  try {
    reader.set('draft:a', 'keep this draft'); render(item);
    const input = host.querySelector('input')!; input.focus(); input.setSelectionRange(2, 7);
    render({ ...item, timeline: { ...item.timeline!, kind: 'group-members', first: true, last: true,
      group: { groupId: 'g', category: 'explore', allItems: [], rounds: [], isGroupStreaming: true, isLastGroupInTurn: true, stats: { readCount: 1, searchCount: 0, commandCount: 0 } } } });
    expect(host.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
    render(item); expect(host.querySelector('input')).toBe(input);
    act(() => root.render(null)); render(item);
    expect(host.querySelector('input')?.value).toBe('keep this draft');
  } finally { act(() => root.unmount()); host.remove(); }
});

it('releases only the final reveal/interaction lease before automatic collection', () => {
  const reader = new FlowChatReaderState();
  const releaseA = reader.holdGroup('g', 'selection'), releaseB = reader.holdGroup('g', 'reveal');
  releaseA(); expect(reader.isGroupHeld('g')).toBe(true);
  releaseB(); expect(reader.isGroupHeld('g')).toBe(false);
  const finishA = reader.reportReveal('turn', 'a'), finishB = reader.reportReveal('turn', 'b');
  finishA(); expect(reader.get('reveal:turn', false)).toBe(true);
  finishB(); expect(reader.get('reveal:turn', true)).toBe(false);
});
