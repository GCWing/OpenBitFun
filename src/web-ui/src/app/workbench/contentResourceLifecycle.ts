import { hasRetainedCanvasDocument } from '../components/panels/content-canvas/stores/canvasStore';
import { useContentResourceStore } from './contentResourceStore';
import { getActiveSurfaceScope, getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ContentResourceLifecycle');

type CloseGuard = () => Promise<boolean>;
const closeGuards = new Map<string, CloseGuard>();
const closing = new Map<string, Promise<boolean>>();

export function registerContentCloseGuard(id: string, guard: CloseGuard): () => void {
  closeGuards.set(id, guard);
  return () => { if (closeGuards.get(id) === guard) closeGuards.delete(id); };
}

/** Every close gesture shares this gate; repeated gestures share the same dialog. */
export function requestContentClose(id: string): Promise<boolean> {
  const pending = closing.get(id);
  if (pending) return pending;
  const guard = closeGuards.get(id);
  const request = (guard ? guard() : Promise.resolve(!useContentResourceStore.getState().resources[id]?.isDirty))
    .then(async approved => {
      if (!approved) return false;
      const resource = useContentResourceStore.getState().resources[id];
      if (resource?.target.kind === 'terminal' && resource.content.metadata?.terminalCloseBehavior !== 'detach') {
        if (resource.scope.surfaceId !== getActiveSurfaceId()) return false;
        const scope = getActiveSurfaceScope();
        const { destroyTerminalSession } = await import('@/shared/services/destroyTerminalSession');
        scope.assertCurrent('close terminal resource');
        await destroyTerminalSession(resource.target.sessionId);
      }
      return true;
    })
    .catch(error => { log.error('Failed to close content resource', { id, error }); return false; })
    .finally(() => { if (closing.get(id) === request) closing.delete(id); });
  closing.set(id, request);
  return request;
}

// Removal owns disposal, including resources whose view is suspended on another device.
const stopDocumentCleanup = useContentResourceStore.subscribe((state, previous) => {
  const removed = Object.values(previous.resources).filter(resource => !state.resources[resource.id]);
  if (removed.length) void import('@/tools/editor/services/EditorDocument').then(({ releaseEditorDocument }) => {
    for (const resource of removed) {
      if (!hasRetainedCanvasDocument(resource.documentId) && !Object.values(useContentResourceStore.getState().resources).some(current => current.documentId === resource.documentId)) releaseEditorDocument(resource.documentId);
    }
  });
});
if (import.meta.hot) import.meta.hot.dispose(stopDocumentCleanup);
