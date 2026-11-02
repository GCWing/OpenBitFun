import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Button, LoadingState, OverflowText, ScrollArea } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { externalSessionImportAPI, type ExternalSessionEcosystem, type RemovedExternalSession } from '@/infrastructure/api/service-api/ExternalSessionImportAPI';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';

interface Props {
  ecosystemId: ExternalSessionEcosystem;
  refreshVersion: number;
  onBusyChange: (busy: boolean) => void;
}

/** Lists only local removal records; history is read when a restored source opens. */
export function RemovedExternalSessions({ ecosystemId, refreshVersion, onBusyChange }: Props) {
  const { t } = useI18n('scenes/ecosystem-compatibility');
  const titleId = useId();
  const surface = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [entries, setEntries] = useState<RemovedExternalSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const pending = useRef(false);
  const unsupported = surface.surfaceId !== 'local';

  useEffect(() => {
    const version = ++request.current;
    const current = () => version === request.current && surface.isCurrent();
    setEntries([]);
    setError(undefined);
    setRestoring(undefined);
    setLoading(!unsupported);
    if (unsupported) return;
    void externalSessionImportAPI.listRemoved(ecosystemId).then(result => {
      if (current()) setEntries(result);
    }).catch(error => {
      if (current()) setError(error?.code === 'incompatible_version'
        ? 'sessions.removed.unsupportedHost' : 'sessions.removed.loadFailed');
    }).finally(() => { if (current()) setLoading(false); });
    return () => { request.current += 1; };
  }, [ecosystemId, refreshVersion, retry, surface, unsupported]);

  useEffect(() => { onBusyChange(loading || !!restoring); }, [loading, restoring, onBusyChange]);
  useEffect(() => () => { onBusyChange(false); }, [onBusyChange]);

  async function restore(entry: RemovedExternalSession) {
    if (pending.current || unsupported) return;
    const version = request.current;
    const current = () => version === request.current && surface.isCurrent();
    pending.current = true;
    setRestoring(entry.sessionId);
    setError(undefined);
    try {
      await externalSessionImportAPI.restoreRemoved(entry.sessionId, entry.workspaceId, ecosystemId);
      if (!current()) return;
      setEntries(previous => previous.filter(item => item.sessionId !== entry.sessionId || item.workspaceId !== entry.workspaceId));
      try {
        const { flowChatManager } = await import('@/flow_chat/services/FlowChatManager');
        if (!current()) return;
        await flowChatManager.refreshWorkspaceSessions({ id: entry.workspaceId });
      } catch {
        if (current()) setError('sessions.removed.refreshFailed');
      }
    } catch {
      if (current()) setError('sessions.removed.restoreFailed');
    } finally {
      pending.current = false;
      if (current()) setRestoring(undefined);
    }
  }

  return <section className="ecosystem-compatibility__section" aria-labelledby={titleId}>
    <div className="ecosystem-compatibility__section-heading">
      <h2 id={titleId}>{t('sessions.removed.title')}</h2>
      <p>{t('sessions.removed.description')}</p>
    </div>
    {unsupported ? <Alert message={t('sessions.removed.unsupportedSurface')} /> : <>
      {error && <Alert role="alert" message={t(error)} />}
      {loading ? <LoadingState /> : entries.length === 0 && !error
        ? <p>{t('sessions.removed.empty')}</p>
        : <ScrollArea className="ecosystem-compatibility__removed-sessions" aria-label={t('sessions.removed.title')}>
          {entries.map(entry => <div className="ecosystem-compatibility__removed-session" key={`${entry.workspaceId}:${entry.sessionId}`}>
            <div className="ecosystem-compatibility__removed-session-info">
              <OverflowText>{entry.sessionName}</OverflowText>
              <OverflowText>{entry.workspaceName}</OverflowText>
            </div>
            <Button size="sm" variant="outline" disabled={!!restoring} loading={restoring === entry.sessionId}
              aria-label={t('sessions.removed.restoreNamed', { name: entry.sessionName })}
              onClick={() => void restore(entry)}>{t('sessions.removed.restore')}</Button>
          </div>)}
        </ScrollArea>}
      {!loading && error && <Button size="sm" variant="text" disabled={!!restoring}
        onClick={() => setRetry(value => value + 1)}>{t('sessions.removed.retry')}</Button>}
    </>}
  </section>;
}
