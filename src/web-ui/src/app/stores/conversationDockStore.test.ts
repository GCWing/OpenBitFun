import { beforeEach, describe, expect, it } from 'vitest';
import { dockConversationKey, useConversationDockStore, type DockConversation } from './conversationDockStore';

const control: DockConversation = { surfaceId: 'local', workspaceKey: 'control', sessionId: 'control', kind: 'control' };
const task: DockConversation = { surfaceId: 'local', workspaceKey: 'project', sessionId: 'task', kind: 'session' };
describe('conversation dock references', () => {
  beforeEach(() => useConversationDockStore.setState({ entries: [], activeBySurface: {}, drafts: {}, open: false }));
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
});
