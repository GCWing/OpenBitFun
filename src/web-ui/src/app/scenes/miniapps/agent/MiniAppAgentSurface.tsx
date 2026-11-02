/**
 * Headless host for the Agent-controlled MiniApp surface. Mount exactly once in
 * the main window, next to `MiniAppPresence`.
 */
import { useMiniAppAgentSurface } from './useMiniAppAgentSurface';

export function MiniAppAgentSurface() {
  useMiniAppAgentSurface();
  return null;
}
