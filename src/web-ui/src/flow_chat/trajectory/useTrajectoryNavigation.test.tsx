// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
const mocks = vi.hoisted(() => ({
  scope: 'local', current: true, load: vi.fn(), older: vi.fn(), activate: vi.fn(), panel: vi.fn(), present: vi.fn(),
  session: { sessionId: 'session', dialogTurns: [] } as any, items: [] as any[],
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({ getActiveSurfaceScope: () => ({ surfaceId: mocks.scope, isCurrent: () => mocks.current }) }));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => ({ sessions: new Map([['session', mocks.session]]) }),
  loadSessionTurnWindow: mocks.load, loadOlderRelaySessionHistory: mocks.older, activateSessionHistoryWindow: mocks.activate,
} }));
vi.mock('./trajectoryPanel', () => ({ openTrajectoryPanel: mocks.panel }));
vi.mock('../components/modern/flowChatFocusTarget', () => ({ resolveFlowChatFocusTarget: () => ({}), findFlowChatFocusElement: () => null }));
import { useTrajectoryNavigation } from './useTrajectoryNavigation';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let navigate: ReturnType<typeof useTrajectoryNavigation>;
const focusElement = document.createElement('div');
const list = { focusItem: vi.fn().mockReturnValue(focusElement), prepareItemNavigation: vi.fn(), scrollToIndex: vi.fn(), clearSearchMatch: vi.fn(), notifyUserSelectionIntent: vi.fn() };
const rootRef = { current: document.createElement('div') };
const listRef = { current: list as any };
const selected = { node: { id: 'tool', turnId: 'wanted', turnOrdinal: 3, roundId: 'round', kind: 'tool', focusItemId: 'tool',
  label: 'Read', preview: '', timestamp: 1, status: 'completed', matched: false }, query: '' } as const;
function Harness({ selectionClearRequest = 0 }: { selectionClearRequest?: number }) {
  navigate = useTrajectoryNavigation({ session: mocks.session as Session, items: mocks.items, listRef, rootRef,
    present: mocks.present, expand: vi.fn(), viewId: 'view', selectionClearRequest }); return null;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  mocks.scope = 'local'; mocks.current = true; mocks.session = { sessionId: 'session', dialogTurns: [] };
  mocks.items = [{ turnId: 'wanted', type: 'model-round', data: { id: 'round' } }]; mocks.load.mockReset(); mocks.older.mockReset(); mocks.panel.mockReset(); mocks.present.mockReset();
  list.focusItem.mockReset().mockReturnValue(focusElement); list.scrollToIndex.mockClear(); root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('focuses a mounted tool through the virtual list without an earlier whole-turn placement', async () => {
  await act(async () => root.render(<Harness />));
  let pending!: Promise<boolean>;
  await act(async () => { pending = navigate(selected); await vi.advanceTimersByTimeAsync(20); });
  expect(await pending).toBe(true); expect(mocks.load).not.toHaveBeenCalled();
  expect(list.focusItem).toHaveBeenCalledWith({ flowItemId: 'tool', virtualItemIndex: 0, roundId: 'round', turnId: 'wanted' }); expect(list.scrollToIndex).not.toHaveBeenCalled();
});
it('rejects an old device completion before committing a history presentation or opening its panel', async () => {
  mocks.items = []; let finish!: (value: unknown) => void;
  mocks.load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Harness />));
  const pending = navigate(selected); mocks.current = false;
  await act(async () => finish({ status: 'ready', isCurrent: true, targetTurnId: 'wanted' }));
  expect(await pending).toBe(false); expect(mocks.activate).not.toHaveBeenCalled(); expect(mocks.panel).not.toHaveBeenCalled();
});
it('reads peer canonical pages only until the stable target appears, without a persisted-body RPC', async () => {
  mocks.scope = 'peer'; mocks.items = []; mocks.session = { sessionId: 'session', isPartial: true, dialogTurns: [{ id: 'latest' }] };
  mocks.older.mockImplementation(async () => { mocks.session = { ...mocks.session, dialogTurns: [{ id: 'wanted' }, { id: 'latest' }] }; return true; });
  mocks.present.mockImplementation(() => { mocks.items = [{ turnId: 'wanted', type: 'model-round', data: { id: 'round' } }]; root.render(<Harness />); });
  await act(async () => root.render(<Harness />));
  let pending!: Promise<boolean>;
  await act(async () => { pending = navigate(selected); });
  // Commit the presented history window before the next navigation animation frame.
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(await pending).toBe(true); expect(mocks.older).toHaveBeenCalledTimes(1); expect(mocks.load).not.toHaveBeenCalled();
});

it('locates a superseded round through the visible retry owner', async () => {
  mocks.items = [{ turnId: 'wanted', type: 'user-message', data: { id: 'u' } },
    { turnId: 'wanted', type: 'model-round', data: { id: 'current', historyRounds: [{ id: 'old-round' }] } }];
  await act(async () => root.render(<Harness />));
  let pending!: Promise<boolean>;
  await act(async () => { pending = navigate({ ...selected, node: { ...selected.node, roundId: 'old-round' } }); await vi.advanceTimersByTimeAsync(20); });
  expect(await pending).toBe(true);
  expect(list.focusItem).toHaveBeenCalledWith({ flowItemId: 'tool', virtualItemIndex: 1, roundId: 'old-round', turnId: 'wanted' });
});
it('locates a steering message by its projected row identity without aiming at a nonexistent tool element', async () => {
  mocks.items = [{ turnId: 'wanted', type: 'user-message', data: { id: 'u' } },
    { turnId: 'wanted', type: 'user-steering-message', data: { id: 'user_steering_followup' } }];
  await act(async () => root.render(<Harness />));
  let pending!: Promise<boolean>;
  await act(async () => { pending = navigate({ ...selected, node: { ...selected.node, kind: 'user', focusItemId: 'user_steering_followup' } }); await vi.advanceTimersByTimeAsync(20); });
  expect(await pending).toBe(true); expect(list.focusItem).toHaveBeenCalledWith({ flowItemId: undefined, virtualItemIndex: 1, roundId: 'round', turnId: 'wanted' });
  expect(list.scrollToIndex).not.toHaveBeenCalled();
});

it('waits for a mounted, permitted target before committing details and discards a superseded aim', async () => {
  list.focusItem.mockReturnValue(null);
  await act(async () => root.render(<Harness />));
  let first!: Promise<boolean>;
  await act(async () => { first = navigate(selected); await vi.advanceTimersByTimeAsync(20); });
  expect(mocks.panel).not.toHaveBeenCalled();
  let second!: Promise<boolean>;
  await act(async () => { second = navigate({ ...selected, node: { ...selected.node, id: 'next', focusItemId: 'next' } }); });
  expect(await first).toBe(false);
  list.focusItem.mockReturnValue(focusElement);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(await second).toBe(true);
  expect(mocks.panel).toHaveBeenCalledTimes(1);
  expect(mocks.panel.mock.calls[0][1].id).toBe('next');
});
it('does not commit a panel when a user gesture cancels an unresolved target', async () => {
  list.focusItem.mockReturnValue(null);
  await act(async () => root.render(<Harness />));
  let pending!: Promise<boolean>;
  await act(async () => { pending = navigate(selected); await vi.advanceTimersByTimeAsync(20); });
  rootRef.current.dispatchEvent(new WheelEvent('wheel', { deltaY: 20 }));
  expect(await pending).toBe(false);
  list.focusItem.mockReturnValue(focusElement);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(mocks.panel).not.toHaveBeenCalled();
});

it('cancels pending positioning when a blank click clears the owning trajectory selection', async () => {
  list.focusItem.mockReturnValue(null);
  await act(async () => root.render(<Harness />));
  let pending!: Promise<boolean>;
  await act(async () => { pending = navigate(selected); await vi.advanceTimersByTimeAsync(20); });
  await act(async () => root.render(<Harness selectionClearRequest={1} />));
  expect(await pending).toBe(false);
  list.focusItem.mockReturnValue(focusElement);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(mocks.panel).not.toHaveBeenCalled();
});
