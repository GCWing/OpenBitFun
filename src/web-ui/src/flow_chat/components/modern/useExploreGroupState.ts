import { useFlowGroupState } from './useFlowGroupState';

/** Compatibility names retain saved Btw disclosure maps and older host adapters. */
export function useExploreGroupState(...args: Parameters<typeof useFlowGroupState>) {
  const state = useFlowGroupState(...args);
  return { ...state, exploreGroupStates: state.groupStates, onExploreGroupToggle: state.onGroupToggle };
}
