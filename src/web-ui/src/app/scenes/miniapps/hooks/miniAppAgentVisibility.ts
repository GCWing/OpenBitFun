import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import type { MiniAppComposerClaim } from '../miniAppStore';

/**
 * Marketplace Agent sessions must stay visible to the user. A runner-owned
 * recoverable composer satisfies that requirement even while its dock tab is
 * hidden. Only unbound runs need the main session fallback.
 */
export function shouldOpenMiniAppAgentRunInMainScene(
  strictRuntime: boolean,
  claim: MiniAppComposerClaim | undefined,
  composerToken: string,
  sessionId: string,
): boolean {
  if (!strictRuntime) return false;
  return !claim || claim.surfaceId !== getActiveSurfaceId() || claim.token !== composerToken || claim.sessionId !== sessionId;
}
