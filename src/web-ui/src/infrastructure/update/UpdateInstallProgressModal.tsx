/**
 * Download progress and installation confirmation for in-app updates.
 */

import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Icon,
} from '@openbitfun/ui';
import React, { useMemo } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import type { UpdateDownloadProgressPayload } from './installUpdateWithProgress';
import { formatUpdateInstallError } from './updateErrorMessage';
import './UpdateInstallProgressModal.scss';

export interface UpdateInstallProgressModalProps {
  isOpen: boolean;
  error: string | null;
  installed?: boolean;
  installing?: boolean;
  version?: string | null;
  progress: UpdateDownloadProgressPayload;
  onCloseError?: () => void;
  onCloseInstalled?: () => void;
  onRestart?: () => void;
  onDownloadAgain?: () => void;
}

export const UpdateInstallProgressModal: React.FC<UpdateInstallProgressModalProps> = ({
  isOpen,
  error,
  installed,
  installing,
  version,
  progress,
  onCloseError,
  onCloseInstalled,
  onRestart,
  onDownloadAgain
}) => {
  const { t } = useI18n('common');
  const { downloaded, total } = progress;
  const pct =
    total != null && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  const errorMessage = useMemo(
    () => (error ? formatUpdateInstallError(error, t) : null),
    [error, t]
  );
  let title = t('update.downloadingTitle');
  if (error && !installed) {
    title = t('update.downloadFailedTitle');
  } else if (installed) {
    title = t('update.installedTitle');
  }

  let onClose = () => {};
  if (installing) {
    onClose = () => {};
  } else if (installed) {
    onClose = onCloseInstalled ?? (() => {});
  } else if (error) {
    onClose = onCloseError ?? (() => {});
  }

  let body: React.ReactNode = null;
  if (errorMessage && !installed) {
    body = (
      <div data-openbitfun-component="update" data-openbitfun-part="alert">
        <Alert
          tone="error"
          message={errorMessage}
          showIcon
          className="openbitfun-update-progress__alert"
        />
      </div>
    );
  } else if (installed) {
    body = (
      <>
        <div
          className="openbitfun-update-progress__ready"
          data-openbitfun-component="update"
          data-openbitfun-part="alert"
          role="status"
        >
          <span className="openbitfun-update-progress__status-icon" aria-hidden="true">
            <Icon name="check-circle" size="md" tone="success" />
          </span>
          <div className="openbitfun-update-progress__summary">
            <p className="openbitfun-update-progress__version">
              {t('update.readyVersion', { version: version ?? '' })}
            </p>
            <div data-openbitfun-component="update" data-openbitfun-part="restartHint">
              <DialogDescription>{t('update.installWarning')}</DialogDescription>
            </div>
          </div>
        </div>
        {errorMessage ? (
          <div data-openbitfun-component="update" data-openbitfun-part="alert">
            <Alert tone="error" message={errorMessage} showIcon />
          </div>
        ) : null}
      </>
    );
  } else {
    body = (
      <>
        <div
          className="openbitfun-update-progress__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-label={t('update.downloadingTitle')}
          data-openbitfun-component="update"
          data-openbitfun-part="progressBar"
        >
          <div
            className={
              pct != null
                ? 'openbitfun-update-progress__fill'
                : 'openbitfun-update-progress__fill openbitfun-update-progress__fill--indeterminate'
            }
            style={pct != null ? { transform: `scaleX(${pct / 100})` } : undefined}
            data-openbitfun-component="update"
            data-openbitfun-part="progressFill"
            data-openbitfun-state={pct == null ? 'indeterminate' : undefined}
          />
        </div>
        <p className="openbitfun-update-progress__hint" data-openbitfun-component="update" data-openbitfun-part="progressHint">
          {pct != null
            ? t('update.progressPercent', { percent: String(pct) })
            : t('update.progressUnknown')}
        </p>
        <p className="openbitfun-update-progress__restart" data-openbitfun-component="update" data-openbitfun-part="restartHint">{t('update.restartHint')}</p>
      </>
    );
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      closeOnPointerOutside={false}
      closeOnEscape={!installing}
      size="sm"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeading>
        {!installing && (!!error || !!installed) && <DialogClose />}
      </DialogHeader>
      <DialogBody>
        <div
          className="openbitfun-update-progress"
          data-openbitfun-component="update"
          data-openbitfun-part="progressRoot"
          data-openbitfun-status={error ? 'error' : installed ? 'installed' : 'downloading'}
        >
          {body}
        </div>
      </DialogBody>
      {installed ? (
        <DialogFooter>
          <div
            className="openbitfun-update-progress__actions"
            data-openbitfun-component="update"
            data-openbitfun-part="actions"
          >
            {errorMessage && onDownloadAgain ? (
              <Button variant="outline" size="md" disabled={installing} onClick={onDownloadAgain}>
                {t('update.downloadAgain')}
              </Button>
            ) : null}
            <Button variant="fill" size="md" disabled={installing} onClick={onCloseInstalled}>
              {t('update.restartLater')}
            </Button>
            <Button variant="primary" size="md" disabled={installing} loading={installing} onClick={onRestart}>
              {t(installing ? 'update.installing' : 'update.installAndRestart')}
            </Button>
          </div>
        </DialogFooter>
      ) : null}
    </Dialog>
  );
};
