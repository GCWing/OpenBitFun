import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import {
  createTextSessionTitleDescriptor,
  normalizeWorkspaceSessionNumber,
  type SessionTitleDescriptor,
} from '../utils/sessionTitle';

const log = createLogger('SessionTitleMetadata');

/** Native and ACP creation share the same host-owned number and UI title state. */
export async function initializeSessionTitleMetadata(
  sessionId: string,
  descriptor: SessionTitleDescriptor,
  workspaceId: string,
  scope: ReturnType<typeof getActiveSurfaceScope>,
): Promise<SessionTitleDescriptor> {
  let title = createTextSessionTitleDescriptor(descriptor.text);
  try {
    scope.assertCurrent('initialize created session title');
    const metadata = await sessionAPI.loadSessionMetadata(sessionId, workspaceId);
    scope.assertCurrent('read created session title identity');
    if (metadata) {
      await sessionAPI.saveSessionMetadata({
        ...metadata,
        customMetadata: {
          ...metadata.customMetadata,
          titleSource: descriptor.source,
          titleKey: descriptor.key,
          titleParams: descriptor.params,
        },
      }, workspaceId, ['titleMetadata']);
      scope.assertCurrent('persist created session title identity');
      // The host claims a reusable slot when the default descriptor is saved.
      // Read back that allocation instead of predicting it from the UI catalog.
      const saved = await sessionAPI.loadSessionMetadata(sessionId, workspaceId);
      scope.assertCurrent('read created session title allocation');
      const number = normalizeWorkspaceSessionNumber(saved?.customMetadata?.workspaceSessionNumber);
      if (number !== undefined) title = { ...descriptor, workspaceSessionNumber: number };
    }
  } catch (error) {
    if (isSurfaceChangedError(error)) throw error;
    // Creation has already succeeded. Preserve that session if optional title
    // metadata could not be synchronized; never create a replacement session.
    log.warn('Failed to initialize created session title metadata', { sessionId, error });
  }
  scope.assertCurrent('finish created session title initialization');
  return title;
}
