import { beforeEach, describe, expect, it } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { dockConversationKey, useConversationDockStore, type DockConversation } from './conversationDockStore';

const control: DockConversation = { surfaceId: 'local', workspaceKey: 'control', sessionId: 'control', kind: 'control' };
const task: DockConversation = { surfaceId: 'local', workspaceKey: 'project', sessionId: 'task', kind: 'session' };
describe('conversation dock references', () => {
  beforeEach(() => {
    activateSurface('local');
    useConversationDockStore.setState(useConversationDockStore.getInitialState());
  });
  it('deduplicates sessions within a device and keeps the control reference pinned', () => {
    const dock = useConversationDockStore.getState();
    dock.add(control); dock.add(task); dock.add(task); dock.add({ ...task, surfaceId: 'peer' });
    expect(useConversationDockStore.getState().entries).toHaveLength(3);
    dock.remove(dockConversationKey(control));
    expect(useConversationDockStore.getState().entries).toContainEqual(control);
    dock.remove(dockConversationKey(task));
    expect(useConversationDockStore.getState().activeBySurface.local).toBe(dockConversationKey(control));
    expect(useConversationDockStore.getState().activeBySurface.peer).toBe(dockConversationKey({ ...task, surfaceId: 'peer' }));
  });
  it('registers app conversations without stealing active selection', () => {
    const dock = useConversationDockStore.getState();
    dock.add(control); dock.add(task);
    dock.add({ ...task, kind: 'miniapp', sessionId: 'app-session', appId: 'app', claimToken: 'runner-1' }, false);
    dock.setOpen(false);
    expect(useConversationDockStore.getState().activeBySurface.local).toBe(dockConversationKey(task));
    expect(useConversationDockStore.getState().entries).toHaveLength(3);
  });
  it('replaces the active control reference without duplicating tabs or changing another device', () => {
    const dock = useConversationDockStore.getState();
    const peer = { ...control, surfaceId: 'peer' };
    dock.add(control); dock.add(peer);
    const replacement = { ...control, sessionId: 'fresh-control' };
    dock.add(replacement, false);
    expect(useConversationDockStore.getState().entries).toEqual([replacement, peer]);
    expect(useConversationDockStore.getState().activeBySurface.local).toBe(dockConversationKey(replacement));
    expect(useConversationDockStore.getState().activeBySurface.peer).toBe(dockConversationKey(peer));
  });
  it('refreshes the control reference without selecting it over another open conversation', () => {
    const dock = useConversationDockStore.getState();
    dock.add(control); dock.add(task);
    dock.add({ ...control, sessionId: 'fresh-control' }, false);
    expect(useConversationDockStore.getState().entries).toHaveLength(2);
    expect(useConversationDockStore.getState().activeBySurface.local).toBe(dockConversationKey(task));
  });
  it('does not consume a newer prepared draft with an old acknowledgement', () => {
    const dock = useConversationDockStore.getState();
    const key = dockConversationKey(task);
    dock.setDraft(key, 'first'); dock.setDraft(key, 'second'); dock.consumeDraft(key, 1);
    expect(useConversationDockStore.getState().drafts[key].text).toBe('second');
    dock.consumeDraft(key, 2);
    expect(useConversationDockStore.getState().drafts[key]).toBeUndefined();
  });
  it('rebinds an app without duplicating a session already moved into the dock', () => {
    const dock = useConversationDockStore.getState();
    const app: DockConversation = { ...task, sessionId: 'old-topic', kind: 'miniapp', appId: 'slides', claimToken: 'slides#1' };
    dock.add(control); dock.add(app); dock.add(task);
    const rebound = { ...app, sessionId: task.sessionId };
    dock.add(rebound, false);
    expect(useConversationDockStore.getState().entries).toEqual([control, rebound]);
    expect(useConversationDockStore.getState().activeBySurface.local).toBe(dockConversationKey(rebound));
  });
  it.each([false, true])('collapses Hi after the final app closes (pinned control: %s)', pinned => {
    const dock = useConversationDockStore.getState();
    const app: DockConversation = { ...task, kind: 'miniapp', appId: 'slides' };
    if (pinned) dock.add(control);
    dock.add(app); dock.setOpen(true);
    dock.closeMiniApp('local', 'slides');
    expect(useConversationDockStore.getState().open).toBe(false);
    expect(useConversationDockStore.getState().entries).toEqual(pinned ? [control] : []);
  });
  it.each(['session', 'miniapp'] as const)('keeps Hi expanded when another %s tab remains', kind => {
    const dock = useConversationDockStore.getState();
    const remaining: DockConversation = { ...task, kind, appId: kind === 'miniapp' ? 'chart' : undefined };
    dock.add(control); dock.add(remaining);
    dock.add({ ...task, kind: 'miniapp', sessionId: 'slides-topic', appId: 'slides' });
    dock.setOpen(true); dock.closeMiniApp('local', 'slides');
    expect(useConversationDockStore.getState().open).toBe(true);
    expect(useConversationDockStore.getState().entries).toEqual([control, remaining]);
  });
  it('collapses after close even when composer cleanup removed the app reference first', () => {
    const dock = useConversationDockStore.getState();
    dock.add(control); dock.add({ ...task, kind: 'miniapp', appId: 'slides' });
    dock.setOpen(true); dock.remove(dockConversationKey(task));
    expect(useConversationDockStore.getState().open).toBe(true);
    dock.closeMiniApp('local', 'slides');
    expect(useConversationDockStore.getState().open).toBe(false);
  });
  it('does not count another device\'s tabs or collapse its visible Hi', () => {
    const dock = useConversationDockStore.getState();
    dock.add({ ...task, surfaceId: 'peer' });
    dock.add({ ...task, kind: 'miniapp', appId: 'slides' }); dock.setOpen(true);
    dock.closeMiniApp('local', 'slides');
    expect(useConversationDockStore.getState().open).toBe(false);
    activateSurface('peer'); dock.setOpen(true);
    dock.closeMiniApp('local', 'slides');
    expect(useConversationDockStore.getState().open).toBe(true);
    expect(useConversationDockStore.getState().entries).toEqual([{ ...task, surfaceId: 'peer' }]);
  });
});
