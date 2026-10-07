/** Compatibility exports; the session pane layout store owns all view modes. */
export { startSessionPaneLayoutSync as startSessionAuxPaneMemory } from './sessionPaneLayoutSync';
import { sessionPaneLayoutStore } from './sessionPaneLayoutStore';

export function clearSessionAuxPaneMemory(): void {
  sessionPaneLayoutStore.getState().clearSessionMemory();
}
