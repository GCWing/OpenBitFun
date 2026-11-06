import { useStore } from 'zustand';
import { Select } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { browserLinkPreferenceStore } from '@/infrastructure/config/services/browserLinkPreference';

export default function BrowserLinkSettingsSection() {
  const { t } = useI18n('settings/runtime');
  const target = useStore(browserLinkPreferenceStore, state => state.target);
  const setTarget = useStore(browserLinkPreferenceStore, state => state.setTarget);

  return (
    <ConfigPageSection title={t('browserLinks.sectionTitle')}>
      <ConfigPageRow label={t('browserLinks.defaultTarget')} description={t('browserLinks.description')} align="center">
        <Select
          size="sm"
          aria-label={t('browserLinks.defaultTarget')}
          value={target}
          options={[
            { value: 'builtin', label: t('browserLinks.builtin') },
            { value: 'external', label: t('browserLinks.external') },
          ]}
          onValueChange={value => {
            if (value === 'builtin' || value === 'external') setTarget(value);
          }}
        />
      </ConfigPageRow>
    </ConfigPageSection>
  );
}
