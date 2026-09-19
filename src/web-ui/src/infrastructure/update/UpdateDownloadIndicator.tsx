import { createOverlayPortal, Icon, IconButton, Tooltip } from '@openbitfun/ui';
import { useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { canCheckForAppUpdates } from './tauriEnv';
import { useUpdateInstallStore } from './updateInstallStore';
import { getUpdateDownloadFraction, selectUpdateDownloadStatus } from './updateDownloadProgress';
import { getUpdateDownloadOrigin, runUpdateDownloadHandoff } from './updateDownloadMotion';
import './UpdateDownloadIndicator.scss';

/** The controller's download remains discoverable after the notice has handed it off. */
export function UpdateDownloadIndicator() {
  const { t, formatNumber } = useI18n('common');
  const state = useUpdateInstallStore();
  const status = canCheckForAppUpdates() ? selectUpdateDownloadStatus(state) : null;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const vesselRef = useRef<HTMLSpanElement>(null);
  const [transferElement, setTransferElement] = useState<HTMLSpanElement | null>(null);
  const transferOwnerRef = useRef<HTMLElement | null>(null);
  const origin = getUpdateDownloadOrigin(state.downloadVersion);
  if (origin) transferOwnerRef.current = origin;

  useLayoutEffect(() => {
    if (status !== 'downloading' || !state.downloadVersion || !buttonRef.current || !vesselRef.current || !transferElement) return;
    const revision = state.noticeRevision;
    return runUpdateDownloadHandoff(state.downloadVersion, buttonRef.current, vesselRef.current, transferElement, () => {
      const current = useUpdateInstallStore.getState();
      if (current.noticeRevision === revision && current.notice === 'downloading' && current.status === 'downloading') {
        current.dismissNotice();
      }
    });
  }, [status, state.startedAt, state.downloadVersion, state.noticeRevision, transferElement]);

  if (!status) return null;
  const fraction = getUpdateDownloadFraction(state.progress);
  const percent = fraction == null ? null : Math.round(fraction * 100);
  const label = status === 'downloading'
    ? percent == null ? t('update.downloadingTitle') : t('update.downloadProgress', { percent: formatNumber(percent) })
    : status === 'installing' ? t('update.installing') : t('update.noticeReady');
  const installLabel = t('update.installAndRestart');

  return (
    <div className="openbitfun-update-download" data-testid="nav-update-download"
      data-openbitfun-component="update" data-openbitfun-part="downloadControl" data-download-status={status}>
      <Tooltip content={status === 'ready' ? installLabel : label} placement="top">
        <IconButton ref={buttonRef} size="sm" shape="circle" variant="quiet" className="openbitfun-update-download__button"
          aria-label={status === 'ready' ? installLabel : t('update.openDownloadDetails', { status: label })} aria-haspopup="dialog"
          disabled={status === 'installing'} onClick={status === 'ready' ? state.requestInstall : state.showNotice}
          data-testid="nav-update-download-button"
          icon={(
            <span ref={vesselRef} className="openbitfun-update-download__vessel" data-download-status={status}
              data-openbitfun-component="update" data-openbitfun-part="downloadVessel">
              {status === 'downloading' && <span className="openbitfun-update-download__fill"
                style={fraction == null ? undefined : { transform: `translateY(${(1 - fraction) * 100}%)` }}
                data-openbitfun-component="update" data-openbitfun-part="downloadFill"
                data-openbitfun-state={fraction == null ? 'indeterminate' : undefined} />}
              {(status === 'ready' || status === 'installing') && <Icon name="check-line" size="xs" className="openbitfun-update-download__complete" />}
            </span>
          )} />
      </Tooltip>
      {status === 'downloading' ? (
        <span className="sr-only" role="progressbar" aria-label={t('update.downloadingTitle')}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={label} />
      ) : <span className="sr-only" role="status">{label}</span>}
      {status === 'downloading' && createOverlayPortal(
        <span ref={setTransferElement} className="openbitfun-update-download__transfer" aria-hidden="true"
          data-openbitfun-component="update" data-openbitfun-part="downloadTransfer" />,
        getAppearanceOverlayHost(),
        state.startedAt,
        { passive: true, ownerRef: transferOwnerRef },
      )}
    </div>
  );
}
