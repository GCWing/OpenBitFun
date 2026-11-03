import { api } from '@/infrastructure/api/service-api/ApiClient';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import type { GenUIAppDefinition, GenUIAppState } from './genUITypes';
const log = createLogger('GenUIDelivery');
interface Request { requestId: string; candidate: { revision: string; app: GenUIAppDefinition; state: GenUIAppState } }
/** Existing correlated product transport; no new controller-owned state. */
export function listenForGenUIChecks(): () => void {
  return api.listen<Request>('agentic://genui-check-request', request => {
    const scope = getActiveSurfaceScope();
    void (async () => {
      let response;
      try {
        if (isPeerDeviceModeActive()) throw new Error('The owning renderer is displaying a peer; GenUI delivery checks are unavailable');
        const { verifyGenUICandidate } = await import('./genUIDelivery');
        scope.assertCurrent('verify GenUI candidate');
        response = { requestId: request.requestId, success: true, result: await verifyGenUICandidate(request.candidate, undefined, true) };
      } catch (error) { response = { requestId: request.requestId, success: false, error: error instanceof Error ? error.message : String(error) }; }
      scope.assertCurrent('report GenUI candidate');
      await api.invoke('report_openbitfun_control_result', { request: response });
    })().catch(error => log.warn('Failed to report GenUI delivery evidence', { error }));
  });
}
