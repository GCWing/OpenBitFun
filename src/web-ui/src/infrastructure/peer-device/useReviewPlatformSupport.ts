import { usePeerDeviceModeOptional } from './peerDeviceContextState';
import { canViewPullRequestsOnSurface } from './peerCapabilityResolution';

export function useReviewPlatformSupport(): boolean {
  const peer = usePeerDeviceModeOptional();
  return canViewPullRequestsOnSurface(
    peer?.peerMode.active ?? false,
    peer?.currentPeerCapabilities ?? null,
  );
}
