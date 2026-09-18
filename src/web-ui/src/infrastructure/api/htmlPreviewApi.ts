import { api } from './service-api/ApiClient';

export interface HtmlPreviewCreateRequest {
  filePath: string;
  workspaceId: string;
  peerDeviceMode: boolean;
}

export interface HtmlPreviewCreateResponse {
  url: string;
  sessionId: string;
}

export const htmlPreviewApi = {
  create(request: HtmlPreviewCreateRequest): Promise<HtmlPreviewCreateResponse> {
    if (!request.workspaceId) return Promise.reject(new Error('HTML preview workspace ID is required'));
    return api.invoke('html_preview_create', { request });
  },
  release(sessionId: string): Promise<void> {
    return api.invoke('html_preview_release', { request: { sessionId } });
  },
};
