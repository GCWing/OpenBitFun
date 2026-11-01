import { useEffect, useSyncExternalStore } from 'react';
import { getWorkspaceIconState, loadWorkspaceIcon, subscribeWorkspaceIcons } from './workspaceIcons';

export function useWorkspaceIcon(workspaceId: string) {
  const state = useSyncExternalStore(subscribeWorkspaceIcons, () => getWorkspaceIconState(workspaceId));
  useEffect(() => { void loadWorkspaceIcon(workspaceId); }, [workspaceId, state]);
  return state;
}
