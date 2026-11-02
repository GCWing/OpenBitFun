/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HostDialogQueue, type QueueItem, type QueueSnapshot } from '../../../../shared/dialog-queue/HostDialogQueue';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { hostQueuePresentation } from '../services/hostQueuePresentation';
import { HostPendingQueuePanel } from '../components/HostPendingQueuePanel';
import type { VirtualItem } from '../types/flow-chat-projection';
import { useHostQueueTimeline } from './useHostQueueTimeline';

const selected = vi.hoisted(() => ({ queue: undefined as HostDialogQueue | undefined }));
vi.mock('../services/hostDialogQueue', () => ({ hostQueueSupported: () => !!selected.queue, hostDialogQueue: () => selected.queue }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../services/flow-chat-manager/PendingQueueModule', () => ({ pendingQueueManager: { enqueue: vi.fn() } }));

const source: VirtualItem[] = [{ type: 'user-message', turnId: 'active', data: { id: 'u', content: 'initial', timestamp: 1 } }];
const item: QueueItem = { turnId: 'next', displayContent: 'steering', previewTruncated: false, attachmentCount: 0,
  agentType: 'Standard', createdAtMs: 2, status: 'steering_pending', reason: null, targetTurnId: 'active', steeringId: 's',
  steeringDisplay: { targetTurnId: 'active', content: 'steering' } };
const emptyStorage = { list: async () => [], put: async () => {}, remove: async () => {} };

it('hides only transcript-owned items, restores blocked controls and drops leases on surface change', async () => {
  let snapshot: QueueSnapshot = { sessionId: 'session', queueEpoch: 'host', revision: 1, activeTurnId: 'active',
    items: [item], used: 1, capacity: 20, receipt: null };
  const queue = new HostDialogQueue('scope', 'session', async () => snapshot, emptyStorage);
  selected.queue = queue;
  const scope = getActiveSurfaceScope();
  let rendered: VirtualItem[] = [];
  function Transcript({ items }: { items: VirtualItem[] }) {
    rendered = useHostQueueTimeline(items, 'session');
    return <div data-testid="transcript">{rendered.map(row => row.turnId).join(',')}</div>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (items: VirtualItem[]) => root.render(<><Transcript items={items} /><HostPendingQueuePanel queue={queue} onRestore={() => true} /></>);
  try {
    await act(async () => { render([]); await queue.refresh(); });
    expect(container.querySelectorAll('li')).toHaveLength(1);
    await act(async () => render(source));
    expect(rendered).toHaveLength(2);
    expect(container.querySelectorAll('li')).toHaveLength(0);
    expect(hostQueuePresentation(queue).getSnapshot().has('next')).toBe(true);
    snapshot = { ...snapshot, revision: 2, items: [{ ...item, status: 'blocked' }] };
    await act(async () => { await queue.refresh(); });
    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(rendered[1]).toMatchObject({ hostQueueStatus: 'failed' });
    snapshot = { ...snapshot, revision: 3, items: [item] };
    await act(async () => { await queue.refresh(); });
    expect(hostQueuePresentation(queue).getSnapshot().has('next')).toBe(true);
    await act(async () => { activateSurface('other-device'); });
    expect(scope.isCurrent()).toBe(false);
    expect(hostQueuePresentation(queue).getSnapshot().size).toBe(0);
    selected.queue = undefined;
    await act(async () => render(source));
    expect(rendered).toBe(source);
  } finally {
    await act(async () => root.unmount());
    selected.queue = undefined;
    activateSurface('local');
  }
});

it('queries a disappeared pending receipt and waits for canonical history instead of assuming consumption', async () => {
  let snapshot: QueueSnapshot = { sessionId: 'session', queueEpoch: 'host', revision: 1, activeTurnId: 'active',
    items: [item], used: 1, capacity: 20, receipt: null };
  const invoke = vi.fn(async request => request.action === 'get' ? { ...snapshot, receipt: { ...item, status: 'started' as const } } : snapshot);
  const queue = new HostDialogQueue('scope', 'session', invoke, emptyStorage);
  selected.queue = queue;
  const container = document.createElement('div');
  const root = createRoot(container);
  let rendered: VirtualItem[] = [];
  function Transcript({ items }: { items: VirtualItem[] }) {
    rendered = useHostQueueTimeline(items, 'session'); return null;
  }
  try {
    await act(async () => { root.render(<Transcript items={source} />); await queue.refresh(); });
    snapshot = { ...snapshot, revision: 2, items: [] };
    await act(async () => { await queue.refresh(); });
    await act(async () => { await Promise.resolve(); });
    expect(invoke.mock.calls.some(([request]) => request.action === 'get' && request.turnId === 'next')).toBe(true);
    expect(rendered[1]).toMatchObject({ hostQueueStatus: 'pending' });
    const formal: VirtualItem = { type: 'user-message', turnId: 'next', data: { id: 'real', content: 'steering', timestamp: 3 } };
    await act(async () => root.render(<Transcript items={[...source, formal]} />));
    expect(rendered).toHaveLength(2);
    expect(rendered[1]).not.toHaveProperty('hostQueueStatus');
  } finally { await act(async () => root.unmount()); selected.queue = undefined; }
});
