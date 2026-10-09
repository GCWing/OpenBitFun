import React from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import { OverflowText, Tooltip } from '@openbitfun/ui';
import './SessionRuntimeStatusEntry.scss';

interface SessionRuntimeStatusEntryProps {
  onOpen?: () => void;
}

export const SessionRuntimeStatusEntry: React.FC<SessionRuntimeStatusEntryProps> = ({
  onOpen,
}) => {
  if (!onOpen) {
    return null;
  }

  return <SessionRuntimeButton onOpen={onOpen} />;
};

function SessionRuntimeButton({
  onOpen,
}: {
  onOpen: () => void;
}) {
  const { t } = useTranslation('flow-chat');
  return (
    <Tooltip content={t('usage.runtime.tooltip')}>
      <button data-openbitfun-icon-slot="true" data-overflow-trigger data-openbitfun-component="session-runtime-status-entry" data-openbitfun-part="root"
        className="session-runtime-status-entry"
        type="button"
        onClick={onOpen}
        aria-label={t('usage.runtime.open')}
      >
        <Activity size="var(--openbitfun-control-icon-size-sm)" data-openbitfun-component="session-runtime-status-entry" data-openbitfun-part="icon" aria-hidden />
        <OverflowText data-openbitfun-component="session-runtime-status-entry" data-openbitfun-part="label">{t('usage.runtime.button')}</OverflowText>
      </button>
    </Tooltip>
  );
}

SessionRuntimeStatusEntry.displayName = 'SessionRuntimeStatusEntry';
