import { Button, Icon } from '@openbitfun/ui';
import React from 'react';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SessionHistoryState } from '../../types/flow-chat';

interface HistorySessionPlaceholderProps {
  state: Extract<SessionHistoryState, 'metadata-only' | 'hydrating' | 'failed'>;
  onRetry?: () => void;
}

export const HistorySessionPlaceholder: React.FC<HistorySessionPlaceholderProps> = ({
  state,
  onRetry,
}) => {
  const { t } = useTranslation('flow-chat');
  const failed = state === 'failed';

  return (
    <div className="history-session-placeholder" role={failed ? 'alert' : 'status'}>
      <div
        className={`history-session-placeholder__icon${failed ? ' history-session-placeholder__icon--failed' : ''}`}
        aria-hidden="true"
      >
        {failed ? <Icon glyph={AlertCircle} size="lg" /> : <Icon name="progress-25" size="lg" />}
      </div>
      <div className="history-session-placeholder__text">
        <h2 className="history-session-placeholder__title">
          {failed ? t('historyState.failedTitle') : t('historyState.loadingTitle')}
        </h2>
        <p className="history-session-placeholder__description">
          {failed ? t('historyState.failedDescription') : t('historyState.loadingDescription')}
        </p>
      </div>
      {failed && (
        <Button
          variant="outline"
          size="md"
          leadingIcon={<Icon name="refresh" size="sm" aria-hidden="true" />}
          onClick={onRetry}
        >
          {t('historyState.retry')}
        </Button>
      )}
    </div>
  );
};

HistorySessionPlaceholder.displayName = 'HistorySessionPlaceholder';
