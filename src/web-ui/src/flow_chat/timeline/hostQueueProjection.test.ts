import { describe, expect, it } from 'vitest';
import type { QueueItem, QueueSnapshot } from '../../../../shared/dialog-queue/HostDialogQueue';
import type { VirtualItem } from '../types/flow-chat-projection';
import { getVirtualItemStableKey } from '../components/modern/virtualItemIdentity';
import { HostQueueProjection } from './hostQueueProjection';

const active: VirtualItem[] = [{ type: 'user-message', turnId: 'active', data: { id: 'user', content: 'initial', timestamp: 1 } },
  { type: 'model-round', turnId: 'active', isLastRound: true, isTurnComplete: false,
    data: { id: 'round', index: 0, startTime: 1, status: 'streaming', isStreaming: true, isComplete: false, items: [] } }];
const accepted = (patch: Partial<QueueItem> = {}): QueueItem => ({ turnId: 'next', displayContent: 'short', previewTruncated: true,
  attachmentCount: 2, agentType: 'Standard', createdAtMs: 2, status: 'steering_pending', reason: null,
  targetTurnId: 'active', steeringId: 'steer',
  steeringDisplay: { targetTurnId: 'active', content: 'long message '.repeat(1000), composerPresentation: { version: 1 } }, ...patch });
const snapshot = (items: QueueItem[], patch: Partial<QueueSnapshot> = {}): QueueSnapshot => ({ sessionId: 'session',
  queueEpoch: 'epoch', revision: 1, activeTurnId: 'active', capacity: 20, used: items.length, receipt: null, items, ...patch });
const formal: VirtualItem = { type: 'user-message', turnId: 'next', data: { id: 'canonical-id', content: 'long message', timestamp: 3 } };

describe('host-accepted steering display', () => {
  it('projects full text and attachment count after acknowledgement without mutating rounds or queue data', () => {
    const input = snapshot([accepted()]);
    const before = JSON.stringify({ active, input });
    const projection = new HostQueueProjection();
    const result = projection.project(active, input);
    expect(result.items.slice(0, 2)).toEqual(active);
    expect(result.hidden).toEqual(['next']);
    expect(result.items[2]).toMatchObject({ type: 'user-message', turnId: 'next', hostQueueStatus: 'pending',
      hostQueueAttachmentCount: 2, data: { content: accepted().steeringDisplay!.content, metadata: { composerPresentation: { version: 1 } } } });
    expect(JSON.stringify({ active, input })).toBe(before);
    expect(projection.project(active, snapshot([accepted()])).items[2]).toBe(result.items[2]);
  });

  it('keeps one stable row through queued handoff, missing receipts and canonical adoption', () => {
    const projection = new HostQueueProjection();
    const first = projection.project(active, snapshot([accepted()]));
    const key = getVirtualItemStableKey(first.items[2]);
    const handingOff = accepted({ status: 'queued', targetTurnId: null, steeringId: null });
    expect(projection.project(active, snapshot([handingOff])).hidden).toEqual(['next']);
    const missing = projection.project(active, snapshot([]));
    expect(missing.missing).toEqual(['next']);
    expect(getVirtualItemStableKey(missing.items[2])).toBe(key);
    const started = snapshot([], { receipt: accepted({ status: 'started' }) });
    expect(projection.project(active, started).missing).toEqual([]);
    const adopted = projection.project([...active, formal], started);
    expect(adopted.items).toHaveLength(3);
    expect(adopted.items[2]).toMatchObject({ data: formal.data });
    expect(adopted.items[2]).not.toHaveProperty('hostQueueStatus');
    expect(getVirtualItemStableKey(adopted.items[2])).toBe(key);
    expect(projection.project([...active, formal], snapshot([])).items[2]).toBe(adopted.items[2]);
  });

  it('handles canonical events before ACK and replaces a forming shell without duplicate user rows', () => {
    const projection = new HostQueueProjection();
    expect(projection.project([...active, formal], snapshot([accepted()])).items).toHaveLength(3);
    const other = new HostQueueProjection();
    const forming: VirtualItem = { ...formal, submissionPhase: 'forming' };
    const result = other.project([...active, forming], snapshot([accepted()]));
    expect(result.items.filter(item => item.turnId === 'next')).toHaveLength(1);
    expect(result.items[2]).toMatchObject({ hostQueueStatus: 'pending' });
  });

  it('restores blocked entries to composer controls, removes cancelled previews and resets on host restart', () => {
    const projection = new HostQueueProjection();
    projection.project(active, snapshot([accepted()]));
    const blocked = projection.project(active, snapshot([accepted({ status: 'blocked', reason: 'not consumed' })]));
    expect(blocked.hidden).toEqual([]);
    expect(blocked.items[2]).toMatchObject({ hostQueueStatus: 'failed' });
    expect(projection.project(active, snapshot([], { receipt: accepted({ status: 'cancelled' }) })).items).toEqual(active);
    projection.project(active, snapshot([accepted()]));
    expect(projection.project(active, snapshot([], { queueEpoch: 'restart' })).items).toBe(active);
  });

  it('leaves old hosts and offscreen history queues visible and supports a fresh observer from the host snapshot', () => {
    const old = accepted({ steeringDisplay: undefined });
    expect(new HostQueueProjection().project(active, snapshot([old]))).toMatchObject({ items: active, hidden: [] });
    const disconnected = new HostQueueProjection();
    expect(disconnected.project([], snapshot([accepted()])).hidden).toEqual([]);
    expect(disconnected.project(active, snapshot([accepted()])).hidden).toEqual(['next']);
    expect(new HostQueueProjection().project(active, snapshot([accepted()])).items[2]).toMatchObject({ hostQueueStatus: 'pending' });
  });

  it('preserves host acceptance order for several messages and hands each off independently', () => {
    const projection = new HostQueueProjection();
    const second = accepted({ turnId: 'second', steeringId: 'steer-2', createdAtMs: 3 });
    const first = projection.project(active, snapshot([accepted(), second]));
    expect(first.items.slice(2).map(row => row.turnId)).toEqual(['next', 'second']);
    const next = projection.project([...active, formal], snapshot([second]));
    expect(next.items.filter(row => row.type === 'user-message').map(row => row.turnId)).toEqual(['active', 'next', 'second']);
    expect(next.hidden).toEqual(['second']);
    expect(getVirtualItemStableKey(next.items[2])).toBe(getVirtualItemStableKey(first.items[2]));
  });
});
