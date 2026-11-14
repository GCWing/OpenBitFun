import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import {
  createTextSessionTitleDescriptor,
  type SessionTitleDescriptor,
} from '../utils/sessionTitle';

const log = createLogger('SessionTitleMetadata');

/** Persist the default title descriptor so it can be localized after reload. */
export async function initializeSessionTitleMetadata(
  sessionId: string,
  descriptor: SessionTitleDescriptor,
  workspaceId: string,
  scope: ReturnType<typeof getActiveSurfaceScope>,
): Promise<SessionTitleDescriptor> {
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
      return descriptor;
    }
  } catch (error) {
    if (isSurfaceChangedError(error)) throw error;
    // Creation has already succeeded. Preserve that session if optional title
    // metadata could not be synchronized; never create a replacement session.
    log.warn('Failed to initialize created session title metadata', { sessionId, error });
  }
  scope.assertCurrent('finish created session title initialization');
  return createTextSessionTitleDescriptor(descriptor.text);
}
