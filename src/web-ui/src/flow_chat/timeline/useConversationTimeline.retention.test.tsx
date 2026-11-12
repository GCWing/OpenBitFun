// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VirtualItem } from '../types/flow-chat-projection';
import { retainedTimelineProjections, useConversationTimeline } from './useConversationTimeline';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const volatile = vi.hoisted(() => ({}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./useHostQueueTimeline', () => ({ useHostQueueTimeline: (items: VirtualItem[]) => items }));
vi.mock('../components/modern/FlowChatContext', () => ({ useFlowChatVolatileContext: () => volatile }));

function transcript(id: string): VirtualItem[] {
  return Array.from({ length: 6 }, (_, index) => ({
    type: 'model-round', turnId: `${id}-${index}`, isLastRound: true, isTurnComplete: true,
    data: { id: `${id}-round-${index}`, index: 0, isStreaming: false, items: [
      { id: `${id}-text-${index}`, type: 'text', content: `${id} answer ${index}`, isMarkdown: true, isStreaming: false, timestamp: index },
    ] },
  }) as unknown as VirtualItem);
}

let root: Root, host: HTMLDivElement;
const projected = new Map<string, VirtualItem[]>();
function Transcript({ sessionId, sources }: { sessionId: string; sources: VirtualItem[] }) {
  projected.set(sessionId, useConversationTimeline(sources, sessionId, 'main').items);
  return null;
}
const sources = new Map<string, VirtualItem[]>();
// The list keys its subtree by session, so every switch is a remount.
const open = (id: string) => {
  if (!sources.has(id)) sources.set(id, transcript(id));
  act(() => root.render(<Transcript key={id} sessionId={id} sources={sources.get(id)!} />));
  return projected.get(id)!;
};

beforeEach(() => {
  retainedTimelineProjections.clear();
  sources.clear(); projected.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('reopens a recently left session with the rows its projection already built', () => {
  const first = open('a');
  open('b');
  expect(retainedTimelineProjections.size).toBe(1);
  const reopened = open('a');
  // Claimed while shown, so only the session just left is retained.
  expect(retainedTimelineProjections.size).toBe(1);
  expect(reopened).toHaveLength(first.length);
  reopened.forEach((item, index) => expect(item).toBe(first[index]));
});

it('builds a fresh projection for a session left too long ago', () => {
  const first = open('a');
  for (const id of ['b', 'c', 'd', 'e']) open(id);
  expect(retainedTimelineProjections.size).toBe(3);
  const reopened = open('a');
  expect(reopened).toHaveLength(first.length);
  expect(reopened[0]).not.toBe(first[0]);
  expect(reopened.map(item => item.turnId)).toEqual(first.map(item => item.turnId));
});
