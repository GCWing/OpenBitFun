import { Button } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import type { FileWatchStatus } from '@/infrastructure/api/service-api/tauri-commands';

export interface FileWatchStatusNoticeProps {
  status: FileWatchStatus;
  retrying: boolean;
  onRetry: () => void;
}

/**
 * Explains a stopped file watcher instead of letting the view silently go stale.
 *
 * The remediation command comes from the host, because only the host knows which
 * platform mechanism failed; this component never assumes one.
 */
export function FileWatchStatusNotice({ status, retrying, onRetry }: FileWatchStatusNoticeProps) {
  const { t } = useTranslation('panels/files');
  const failure = status.failure;
  const reasonKey = failure?.code === 'watch_limit_exceeded'
    ? 'watch.reason.watchLimitExceeded'
    : 'watch.reason.backendUnavailable';

  return (
    <div
      className="openbitfun-file-watch-notice"
      data-openbitfun-component="files-panel"
      data-openbitfun-part="watchNotice"
      data-watch-failure-code={failure?.code ?? 'unknown'}
      role="status"
    >
      <div className="openbitfun-file-watch-notice__body">
        <span className="openbitfun-file-watch-notice__title">{t('watch.title')}</span>
        <span className="openbitfun-file-watch-notice__reason">{t(reasonKey)}</span>
        {failure?.hint ? (
          <>
            <span className="openbitfun-file-watch-notice__hint-label">{t('watch.hintLabel')}</span>
            <code className="openbitfun-file-watch-notice__hint">{failure.hint}</code>
          </>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={retrying}
      >
        {retrying ? t('watch.retrying') : t('watch.retry')}
      </Button>
    </div>
  );
}
