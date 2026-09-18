import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { useConversationDockStore } from '../stores/conversationDockStore';
import { beginConversationTransfer, dropConversationInDock, endConversationTransfer, returnConversationToWorkbench } from './conversationDockTransfer';
import { peekConversationViewTransfer, registerConversationReader, takeConversationViewTransfer } from '@/flow_chat/components/modern/flowChatViewHandoff';
import type { SessionViewportState } from '@/flow_chat/components/modern/ModernFlowChatContainer';

const fixture = vi.hoisted(() => ({ sessions: new Map(), tabs: [] as unknown[], close: vi.fn(), open: vi.fn() }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({ sessions: fixture.sessions }) } }));
vi.mock('../stores/sceneStore', () => ({ useSceneStore: { getState: () => ({ openTabs: fixture.tabs, closeScene: fixture.close, openSessionScene: fixture.open }) } }));

function dragData() {
  const data = new Map<string, string>();
  return { get types() { return [...data.keys()]; }, setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '' } as DataTransfer;
}
const ref = { surfaceId: 'local', sessionId: 'task', workspaceKey: 'project' };
describe('conversation host transfer', () => {
  beforeEach(() => {
    activateSurface('local'); endConversationTransfer(); vi.clearAllMocks();
    fixture.sessions.clear(); fixture.sessions.set('task', { sessionId: 'task' });
    fixture.tabs = [{ id: 'session', session: ref }];
    useConversationDockStore.setState({ entries: [], activeBySurface: {}, open: false });
  });
  it('commits the destination and semantic reading state before closing the source', async () => {
    const reading = { snapshot: { sessionId: 'task', anchorTurnId: 'turn-4', anchorItemKey: 'round-4', anchorOffsetPx: -20 }, historyPresentation: null, viewportIntent: null } as SessionViewportState;
    const stop = registerConversationReader(ref, 'main', () => reading);
    fixture.close.mockImplementationOnce(() => {
      expect(useConversationDockStore.getState().entries[0]).toMatchObject(ref);
      const pending = peekConversationViewTransfer(ref, 'dock');
      expect(peekConversationViewTransfer(ref, 'dock')).toBe(pending);
      expect(takeConversationViewTransfer(ref, 'dock', pending!.revision - 1)).toBeUndefined();
      expect(takeConversationViewTransfer(ref, 'dock')?.state).toBe(reading);
      expect(peekConversationViewTransfer(ref, 'dock')).toBeUndefined();
    });
    const data = dragData(); beginConversationTransfer(data, ref, 'session');
    await dropConversationInDock(data);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.sessions.size).toBe(1);
    stop();
  });
  it('rejects a stale device offer even when the new device has the same session id', async () => {
    const data = dragData(); beginConversationTransfer(data, ref, 'session');
    activateSurface('peer'); await dropConversationInDock(data);
    expect(useConversationDockStore.getState().entries).toHaveLength(0);
    expect(fixture.close).not.toHaveBeenCalled();
  });
  it('rejects a source tab whose session changed during the drag', async () => {
    const data = dragData(); beginConversationTransfer(data, ref, 'session');
    fixture.tabs = [{ id: 'session', session: { ...ref, sessionId: 'other' } }];
    await dropConversationInDock(data);
    expect(fixture.close).not.toHaveBeenCalled();
  });
  it('retains the dock until the destination activation succeeds', () => {
    const entry = { ...ref, kind: 'session' as const };
    useConversationDockStore.getState().add(entry);
    returnConversationToWorkbench(entry);
    expect(useConversationDockStore.getState().entries).toHaveLength(1);
    fixture.open.mock.calls[0][1].onActivated();
    expect(useConversationDockStore.getState().entries).toHaveLength(0);
  });
});
