import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { useLanguageSelector } from '@/infrastructure/i18n';
import type { LocaleId } from '@/infrastructure/i18n/types';
import { Select } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';

export function LanguageSettingsSection() {
  const { t } = useTranslation('settings/application');
  const { currentLanguage, supportedLocales, selectLanguage, isChanging } = useLanguageSelector();
  return (
    <ConfigPageSection
      title={t('appearance.interfaceTitle')}
      description={t('appearance.interfaceHint')}
    >
      <ConfigPageRow
        label={t('appearance.language')}
        align="center"
      >
        <Select
          size="sm"
          value={currentLanguage}
          onValueChange={(value) =>
            selectLanguage(String(value) as LocaleId)
          }
          options={supportedLocales.map((locale) => ({
            value: locale.id,
            label: locale.nativeName,
            testId: 'appearance-language-option',
            testAttributes: {
              'data-locale-id': locale.id,
            },
          }))}
          disabled={isChanging}
          placeholder={t('appearance.language')}
          data-testid="appearance-language-select"
        />
      </ConfigPageRow>
    </ConfigPageSection>
  );
}
