import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { externalSessionImportAPI, type RemovedExternalSession } from '@/infrastructure/api/service-api/ExternalSessionImportAPI';
import { openMainSession } from '../services/sessionActivation';
import { flowChatStore } from '../store/FlowChatStore';
import type { Session } from '../types/flow-chat';
import './ExternalHistoryNotice.scss';

const log = createLogger('ExternalHistoryNotice');

/** Source IO belongs to session opening. Rendering this notice never refreshes it. */
export function ExternalHistoryNotice({ session, active }: { session?: Session; active: boolean }) {
  const { t } = useI18n('flow-chat');
  const surface = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const followed = session?.externalHistory?.mode === 'follow';
  const sourceId = followed ? session.sessionId : session?.externalBranchOf?.sessionId;
  const workspaceId = session?.workspaceId ?? session?.config.workspaceId;
  const sourceName = (followed ? session?.importedSource : session?.externalBranchOf?.ecosystemId) ?? '';
  const [feedback, setFeedback] = useState<{ key: string; message: string; removed?: RemovedExternalSession }>();
  const [busyKey, setBusyKey] = useState<string>();
  const pending = useRef(false);
  const activation = useRef(0);
  const current = useRef({ session, active, sourceId });
  current.current = { session, active, sourceId };
  useEffect(() => () => { current.current = { session: undefined, active: false, sourceId: undefined }; }, []);
  useEffect(() => {
    pending.current = false;
    setBusyKey(undefined);
    return () => { activation.current += 1; };
  }, [surface.epoch, session?.sessionId, sourceId, active]);

  if (!sourceId) return null;
  const unsupportedSurface = surface.surfaceId !== 'local';
  const key = JSON.stringify([surface.epoch, session?.sessionId, sourceId]);
  const notice = feedback?.key === key ? feedback : undefined;
  const missing = session?.externalHistory?.sourceStatus === 'unavailable';
  const source = sourceName === 'codex' ? 'Codex' : sourceName === 'zcode' ? 'Zcode' : sourceName;

  async function openSource() {
    if (!sourceId || !workspaceId || unsupportedSurface || !active || pending.current) return;
    const scope = getActiveSurfaceScope();
    const requestActivation = activation.current;
    const ownerId = session?.sessionId;
    const isCurrent = () => requestActivation === activation.current && scope.isCurrent() && current.current.active
      && current.current.session?.sessionId === ownerId && current.current.sourceId === sourceId;
    pending.current = true;
    setBusyKey(key);
    try {
      if (notice?.removed) {
        try {
          await externalSessionImportAPI.restoreRemoved(sourceId, workspaceId, notice.removed.ecosystemId);
        } catch (error) {
          if (isCurrent()) setFeedback({ key, message: 'externalHistory.restoreFailed', removed: notice.removed });
          log.debug('Removed source view could not be restored', { sourceId, error });
          return;
        }
        if (!isCurrent()) return;
      }
      const found = await flowChatStore.ensurePersistedSessionMetadata(sourceId, workspaceId, true);
      if (!isCurrent()) return;
      if (!found) {
        const removed = sourceName === 'codex' || sourceName === 'zcode'
          ? (await externalSessionImportAPI.listRemoved(sourceName)).find(entry =>
            entry.sessionId === sourceId && entry.workspaceId === workspaceId)
          : undefined;
        if (isCurrent()) setFeedback({ key, removed,
          message: removed ? 'externalHistory.removed' : 'externalHistory.sourceMissing' });
        return;
      }
      setFeedback(undefined);
      await openMainSession(sourceId, { workspaceId });
    } catch (error) {
      if (isCurrent()) setFeedback({ key, message: 'externalHistory.openFailed' });
      log.debug('External source view could not be opened', { sourceId, error });
    } finally {
      if (requestActivation === activation.current) pending.current = false;
      if (isCurrent()) setBusyKey(undefined);
    }
  }

  return <div className="external-history-notice" role="status" aria-live="polite"
    data-openbitfun-product-component="external-history-notice" data-openbitfun-product-part="root">
    <span>{t(followed ? 'externalHistory.followHint' : 'externalHistory.branchHint', { source })}</span>
    {unsupportedSurface && <span>{t('externalHistory.unsupportedSurface')}</span>}
    {missing && <span>{t(session?.externalHistory?.contentVersion
      ? 'externalHistory.unavailable' : 'externalHistory.unavailableWithoutCache')}</span>}
    {notice && <span>{t(notice.message)}</span>}
    {!missing && session?.externalHistory?.incomplete && <span>{t('externalHistory.incomplete')}</span>}
    {!followed && <Button variant="text" size="xs" disabled={unsupportedSurface || !workspaceId || busyKey === key}
      onClick={() => void openSource()}>{t(notice?.removed ? 'externalHistory.restoreSource' : 'externalHistory.openSource')}</Button>}
  </div>;
}
