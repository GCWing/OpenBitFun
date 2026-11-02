import React from 'react';
import { Icon, IconButton } from '@openbitfun/ui';

import { useI18n } from '@/infrastructure/i18n';
import { MiniAppActionTooltip } from '../components/MiniAppActionTooltip';

interface MiniAppCustomizeEntryProps {
  disabled?: boolean;
  onOpen: () => void;
  size?: 'xs' | 'sm';
}

export const MiniAppCustomizeEntry: React.FC<MiniAppCustomizeEntryProps> = ({
  disabled,
  onOpen,
  size = 'sm',
}) => {
  const { t } = useI18n('scenes/miniapp');
  const label = t('customize.trigger');

  return (
    <MiniAppActionTooltip content={label} disabled={disabled}>
      <IconButton
        size={size}
        shape="square"
        onClick={onOpen}
        disabled={disabled}
        aria-label={label}
        icon={<Icon name="creative" size="md" />}
      />
    </MiniAppActionTooltip>
  );
};

export default MiniAppCustomizeEntry;
