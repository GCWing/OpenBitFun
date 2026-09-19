import { ActionItem, Button, Card, CardBody, CardFooter, CardHeader, Icon, IconButton, OverlayLayer, OverflowText, useHasModalOverlay } from '@openbitfun/ui';
import { useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { getVersionInfo } from '@/shared/utils/version';
import { canCheckForAppUpdates } from './tauriEnv';
import { useUpdateInstallStore, type UpdateNotice } from './updateInstallStore';
import { formatUpdateInstallError, isUpdateVersionChangedError } from './updateErrorMessage';
import { getUpdateIntroduction } from './updateReleaseNotes';
import { prepareUpdateDownloadHandoff } from './updateDownloadMotion';
import './UpdateInstallProgressModal.scss';
import './UpdateNotificationCard.scss';

function UpdateNoticeCard({ notice }: { notice: UpdateNotice }) {
  const { t } = useI18n('common');
  const state = useUpdateInstallStore();
  const { noticeRevision, markNoticePresented } = state;
  const modalOpen = useHasModalOverlay();
  const version = notice === 'available' ? state.availableUpdate?.latestVersion
    : state.downloadVersion ?? state.availableUpdate?.latestVersion ?? state.version;
  const release = version && version === state.availableUpdate?.latestVersion ? state.availableUpdate : null;
  const releaseNotes = release?.releaseNotes;
  const introduction = useMemo(() => getUpdateIntroduction(releaseNotes), [releaseNotes]);
  const cardRef = useRef<HTMLDivElement>(null);
  const cancelHandoff = useRef<(() => void) | undefined>();
  useEffect(() => () => cancelHandoff.current?.(), []);

  const startDownload = (event: MouseEvent<HTMLButtonElement>, replacePending: boolean, target: string | undefined) => {
    cancelHandoff.current?.();
    const cancel = cardRef.current && target
      ? prepareUpdateDownloadHandoff(event.currentTarget, cardRef.current, target, event.detail === 0) : undefined;
    cancelHandoff.current = cancel;
    void state.startInstall(replacePending, target).finally(() => cancel?.());
  };

  useEffect(() => {
    const markPresented = () => {
      if (!modalOpen && document.visibilityState !== 'hidden' && document.hasFocus()) markNoticePresented();
    };
    markPresented();
    window.addEventListener('focus', markPresented);
    document.addEventListener('visibilitychange', markPresented);
    return () => {
      window.removeEventListener('focus', markPresented);
      document.removeEventListener('visibilitychange', markPresented);
    };
  }, [modalOpen, notice, version, noticeRevision, markNoticePresented]);

  const percent = state.progress.total && state.progress.total > 0
    ? Math.min(100, Math.round(state.progress.downloaded / state.progress.total * 100)) : null;
  const title = version ? t('update.releaseTitle', { name: getVersionInfo().name, version })
    : t('update.availableTitle');
  const message = notice === 'error' ? formatUpdateInstallError(state.error ?? '', t) : null;

  return (
    <div
      ref={cardRef}
      className="openbitfun-update-notice"
      data-testid="app-update-notice"
      data-openbitfun-component="update"
      data-openbitfun-part="notice"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          state.dismissNotice();
        }
      }}
    >
      <Card appearance="raised" padding="md" gap="md" radius="md"
        className="openbitfun-update-notice__surface" data-openbitfun-native-webview-occlusion>
        <div data-openbitfun-component="update" data-openbitfun-part="availableRoot" data-openbitfun-variant="daily">
          <div data-openbitfun-component="update" data-openbitfun-part="lead">
            <CardHeader
              align="center"
              actions={(
                <IconButton icon={<Icon name="xmark" size="sm" />} size="xs" variant="quiet"
                  aria-label={t('actions.close')} onClick={state.dismissNotice} />
              )}
            >
              <span className="openbitfun-update-notice__heading"
                data-openbitfun-component="update" data-openbitfun-part="noticeTitle">
                <ActionItem className="openbitfun-update-notice__title"
                  aria-label={t('update.openReleaseNotes', { title })}
                  aria-haspopup="dialog" data-testid="app-update-release-notes"
                  metadata={<Icon name="chevron-right" size="xs" />}
                  onClick={state.openReleaseNotes}>
                  <OverflowText className="openbitfun-update-notice__title-text">{title}</OverflowText>
                </ActionItem>
              </span>
            </CardHeader>
          </div>
        </div>
        <CardBody className="openbitfun-update-notice__body">
          {introduction ? (
            <OverflowText as="p" lines={notice === 'error' ? 1 : 3} className="openbitfun-update-notice__introduction"
              data-testid="app-update-introduction"
              data-openbitfun-component="update" data-openbitfun-part="subtitle">
              {introduction}
            </OverflowText>
          ) : (
            <div className="openbitfun-update-notice__empty-introduction" aria-hidden="true"
              data-testid="app-update-release-artwork"
              data-openbitfun-component="update" data-openbitfun-part="releaseArtwork">
              <span className="openbitfun-update-notice__brand-mark" />
            </div>
          )}
          {notice === 'error' && <div className="openbitfun-update-notice__feedback">
            <p className="openbitfun-update-notice__message" role="status" aria-live="polite"
              data-openbitfun-component="update" data-openbitfun-part="subtitle">
              <span className="openbitfun-update-notice__status-icon" aria-hidden="true"
                data-openbitfun-component="update" data-openbitfun-part="leadIcon">
                <Icon name="info" size="sm" tone="danger" />
              </span>
              <OverflowText lines={2}>{message}</OverflowText>
            </p>
          </div>}
          {notice === 'downloading' && (
            <div className="openbitfun-update-progress__bar openbitfun-update-notice__progress"
              role="progressbar" aria-label={t('update.downloadingTitle')}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
              data-openbitfun-component="update" data-openbitfun-part="progressBar">
              <div
                className={'openbitfun-update-progress__fill' + (percent == null ? ' openbitfun-update-progress__fill--indeterminate' : '')}
                style={percent == null ? undefined : { transform: `scaleX(${percent / 100})` }}
                data-openbitfun-component="update" data-openbitfun-part="progressFill"
                data-openbitfun-state={percent == null ? 'indeterminate' : undefined} />
            </div>
          )}
        </CardBody>
        {notice !== 'downloading' && (
          <div className="openbitfun-update-notice__footer" data-openbitfun-component="update" data-openbitfun-part="actions">
            <CardFooter align={notice === 'available' ? 'between' : 'end'} className="openbitfun-update-notice__actions">
              {notice === 'available' && version && (
                <Button className="openbitfun-update-notice__action" size="sm" variant="outline" onClick={() => state.skipVersion(version)}>
                  {t('update.skipVersion')}
                </Button>
              )}
              {notice === 'available' && <Button className="openbitfun-update-notice__action" size="sm" variant="primary" onClick={event => startDownload(event, Boolean(state.version), version ?? undefined)}>
                {t('update.downloadUpdate')}
              </Button>}
              {notice === 'error' && <Button className="openbitfun-update-notice__action" size="sm" variant="primary" onClick={event => {
                if (isUpdateVersionChangedError(state.error)) {
                  state.openDetails();
                  void state.checkForUpdates();
                } else startDownload(event, true, state.downloadVersion ?? undefined);
              }}>
                {t(isUpdateVersionChangedError(state.error) ? 'update.checkForUpdates' : 'update.retryDownload')}
              </Button>}
            </CardFooter>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Persistent until an explicit action; update attention is independent of this notice. */
export function UpdateNotificationCard() {
  const notice = useUpdateInstallStore(state => state.notice);
  const detailsOpen = useUpdateInstallStore(state => state.detailsOpen);
  if (!canCheckForAppUpdates() || !notice || detailsOpen) return null;
  return <OverlayLayer passive><UpdateNoticeCard notice={notice} /></OverlayLayer>;
}
