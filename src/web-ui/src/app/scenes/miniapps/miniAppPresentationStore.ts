import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { create } from 'zustand';
import { hasLocalMiniAppPresentation, miniAppPresentationAPI, type MiniAppInstanceSnapshot, type MiniAppViewTicket } from '@/infrastructure/api/service-api/MiniAppPresentationAPI';

interface PresentationState {
  snapshot: MiniAppInstanceSnapshot | null;
  tabs: Record<string, MiniAppViewTicket>;
  apply: (snapshot: MiniAppInstanceSnapshot) => void;
  bind: (ticket: MiniAppViewTicket) => void;
  release: (appId: string) => void;
}
export const useMiniAppPresentationStore = create<PresentationState>((set) => ({
  snapshot: null,
  tabs: {},
  apply: snapshot => set(state => {
    if (state.snapshot?.hostEpoch === snapshot.hostEpoch && state.snapshot.revision > snapshot.revision) return state;
    return { snapshot, ...(state.snapshot && state.snapshot.hostEpoch !== snapshot.hostEpoch ? { tabs: {} } : {}) };
  }),
  bind: ticket => set(state => ({ tabs: { ...state.tabs, [ticket.instance.appId]: ticket } })),
  release: appId => set(state => { const tabs = { ...state.tabs }; delete tabs[appId]; return { tabs }; }),
}));

const pendingTabs = new Map<string, Promise<MiniAppViewTicket>>();
export function ensureMiniAppTab(appId: string, workspacePath?: string | null): Promise<MiniAppViewTicket> {
  const existing = useMiniAppPresentationStore.getState().tabs[appId];
  if (existing) return Promise.resolve(existing);
  const pending = pendingTabs.get(appId);
  if (pending) return pending;
  const scope = getActiveSurfaceScope();
  const request = miniAppPresentationAPI.open(appId, 'tab', workspacePath).then(ticket => {
    scope.assertCurrent('open MiniApp tab');
    useMiniAppPresentationStore.getState().bind(ticket);
    return ticket;
  }).finally(() => pendingTabs.delete(appId));
  pendingTabs.set(appId, request);
  return request;
}

/** A close during initial loading must also detach the ticket still being acquired. */
export async function detachMiniAppTab(appId: string): Promise<boolean> {
  if (!hasLocalMiniAppPresentation()) return false;
  await pendingTabs.get(appId);
  const ticket = useMiniAppPresentationStore.getState().tabs[appId];
  if (!ticket || !hasLocalMiniAppPresentation()) return false;
  const snapshot = await miniAppPresentationAPI.detach(ticket);
  // New hosts return the committed revision. Fence late pre-close snapshots
  // before releasing the ticket, while tolerating the original void response.
  if (snapshot?.protocolVersion === 1) useMiniAppPresentationStore.getState().apply(snapshot);
  // Keep the ticket until scene removal commits, so a concurrent close cannot
  // fall through to the legacy worker shutdown path.
  return true;
}
