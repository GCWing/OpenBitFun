import { api } from './service-api/ApiClient';
import { getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('HtmlPreviewAPI');

export interface HtmlPreviewCreateRequest {
  filePath: string;
  workspaceId: string;
}

export interface HtmlPreviewCreateResponse {
  url: string;
  sessionId: string;
}

export const htmlPreviewApi = {
  async create(request: HtmlPreviewCreateRequest): Promise<HtmlPreviewCreateResponse> {
    if (!request.workspaceId) throw new Error('HTML preview workspace ID is required');
    const scope = getActiveSurfaceScope();
    const peerDeviceMode = !isLocalSurface(scope.surfaceId);
    const result = await api.invoke<HtmlPreviewCreateResponse>('html_preview_create', {
      request: {
        ...request,
        peerDeviceMode,
        ...(peerDeviceMode ? { peerDeviceId: scope.surfaceId } : {}),
      },
    });
    // The gateway is controller-local, so ApiClient intentionally does not fence it.
    // A late creation must still close its local listener after a surface switch.
    if (!scope.isCurrent()) {
      await htmlPreviewApi.release(result.sessionId).catch(error => log.warn('Failed to release stale HTML preview', error));
      scope.assertCurrent('HTML preview');
    }
    return result;
  },
  release(sessionId: string): Promise<void> {
    return api.invoke('html_preview_release', { request: { sessionId } });
  },
};
