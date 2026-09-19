import { systemAPI } from '@/infrastructure/api';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('installUpdateWithProgress');

export const UPDATE_PROGRESS_EVENT = 'openbitfun-update-progress';

export interface UpdateDownloadProgressPayload {
  downloaded: number;
  total: number | null;
}

/**
 * Downloads and verifies only. Installation requires a separate confirmation.
 */
export async function installUpdateWithProgress(
  onProgress: (p: UpdateDownloadProgressPayload) => void,
  expectedVersion?: string,
): Promise<import('../api/service-api/SystemAPI').PendingUpdateResponse> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<UpdateDownloadProgressPayload>(
    UPDATE_PROGRESS_EVENT,
    event => {
      const payload = event.payload;
      onProgress({
        downloaded: payload.downloaded,
        total: payload.total ?? null
      });
    }
  );
  try {
    return await systemAPI.downloadUpdate(expectedVersion);
  } catch (error) {
    log.error('Update download failed', error);
    throw error;
  } finally {
    unlisten();
  }
}
