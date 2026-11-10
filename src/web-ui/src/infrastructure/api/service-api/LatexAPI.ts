import { isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';
import { peerConnectionManager, type PeerHostCapabilities } from '@/infrastructure/peer-device/PeerConnectionManager';
import { isTauriRuntime } from '@/infrastructure/runtime';
import type { ContentResourceScope } from '@/shared/types/contentResource';
import { invokePrepared } from './invokePrepared';

export type LatexEngine = 'pdflatex' | 'xelatex';

export function supportsLatexPreview(surfaceId: string, capabilities?: PeerHostCapabilities | null): boolean {
  return isLocalSurface(surfaceId) ? isTauriRuntime() : capabilities?.workspaceLatexPreviewV1 === true;
}

export async function compileWorkspaceLatex(origin: ContentResourceScope, filePath: string, engine: LatexEngine) {
  const { workspaceId, surfaceId } = origin;
  return invokePrepared<{ pdfBase64: string }>('compile_workspace_latex', async scope => {
    if (scope.surfaceId !== surfaceId || !workspaceId) {
      throw new Error('The LaTeX source workspace is unavailable on this device.');
    }
    const capabilities = peerConnectionManager.get(surfaceId)?.getState().capabilities;
    if (!supportsLatexPreview(surfaceId, capabilities)) {
      throw new Error('This host does not support LaTeX preview.');
    }
    return { request: { workspaceId, filePath, engine } };
  });
}
