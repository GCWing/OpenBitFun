import { useStore } from 'zustand';
import { Select } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { sessionPaneLayoutStore, type SessionPaneDisplayMode } from '@/app/scenes/session/sessionPaneLayoutStore';

export default function SessionPanelSettingsSection() {
  const { t } = useI18n('settings/appearance');
  const displayMode = useStore(sessionPaneLayoutStore, state => state.displayMode);
  const setDisplayMode = useStore(sessionPaneLayoutStore, state => state.setDisplayMode);

  return (
    <ConfigPageSection title={t('sessionPanel.title')}>
      <ConfigPageRow label={t('sessionPanel.displayMode')} align="center">
        <Select size="sm" value={displayMode}
          onValueChange={value => setDisplayMode(value as SessionPaneDisplayMode)}
          options={[
            { value: 'split', label: t('sessionPanel.split') },
            { value: 'overlay', label: t('sessionPanel.overlay') },
          ]}
          aria-label={t('sessionPanel.displayMode')} />
      </ConfigPageRow>
    </ConfigPageSection>
  );
}
