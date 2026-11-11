import { ActionCard, Select } from '@openbitfun/ui';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  SYSTEM_APPEARANCE_ID,
  useAppearance,
  type AppearanceCatalogEntry,
} from '@/infrastructure/appearance';
import { ConfigPageSection, formatStandaloneUiText } from './common';

const DEFAULT_APPEARANCE_PREVIEW_SRC = '/assets/appearance/openbitfun-default-preview@4x.png';

function builtinAppearanceDisplayName(
  appearance: AppearanceCatalogEntry,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const presetId = appearance.id.replace(/^builtin\./, '');
  return t(`appearance.presets.${presetId}.name`, { defaultValue: appearance.name });
}

/** The built-in appearance selector is the bridge to the new design system. */
export function AppearancePackageConfigSection() {
  const { t } = useTranslation('settings/appearance');
  const { t: tApplication } = useTranslation('settings/application');
  const {
    appearances: appearanceCatalog,
    selectedAppearanceId,
    select,
    initialized,
    status,
  } = useAppearance();
  const builtinAppearances = useMemo(
    () => appearanceCatalog.filter(appearance => appearance.source === 'builtin'),
    [appearanceCatalog],
  );
  const builtinThemeOptions = useMemo(() => [
    {
      value: SYSTEM_APPEARANCE_ID,
      label: tApplication('appearance.systemAppearance'),
      group: t('theme.builtinTheme'),
      testId: 'appearance-builtin-theme-option',
      testAttributes: { 'data-appearance-id': SYSTEM_APPEARANCE_ID },
    },
    ...builtinAppearances.map(appearance => ({
      value: appearance.id,
      label: builtinAppearanceDisplayName(appearance, tApplication),
      group: t('theme.builtinTheme'),
      testId: 'appearance-builtin-theme-option',
      testAttributes: { 'data-appearance-id': appearance.id },
    })),
  ], [builtinAppearances, t, tApplication]);
  const selectedBuiltinThemeId = builtinThemeOptions.some(option => option.value === selectedAppearanceId)
    ? selectedAppearanceId
    : SYSTEM_APPEARANCE_ID;
  const busy = !initialized || status === 'applying';
  const selectedBuiltin = builtinAppearances.some(
    appearance => appearance.id === selectedAppearanceId,
  );
  const selected = selectedAppearanceId === SYSTEM_APPEARANCE_ID || selectedBuiltin;

  return (
    <ConfigPageSection
      className="appearance-package-config"
      title={t('theme.title')}
      bodySurface={false}
      fieldSurface="ambient"
      data-openbitfun-component="appearance-settings"
      data-openbitfun-part="packageSection"
      data-openbitfun-package-type="native"
      data-openbitfun-state={busy ? 'disabled' : undefined}
    >
      <div className="appearance-package-config__gallery">
        <article
          className="appearance-package-config__card"
          aria-label={t('theme.nativeName')}
          data-testid="appearance-package-card"
          data-appearance-id={SYSTEM_APPEARANCE_ID}
          data-openbitfun-component="appearance-settings"
          data-openbitfun-part="packagePreview"
          data-openbitfun-package-type="native"
          data-openbitfun-state={busy ? 'disabled' : undefined}
        >
          <ActionCard
            className="appearance-package-config__card-action"
            triggerClassName="appearance-package-config__card-select"
            selected={selected}
            aria-label={t('theme.nativeName')}
            aria-pressed={selected}
            disabled={busy}
            body={(
              <>
                <span className="appearance-package-config__card-preview appearance-package-config__card-preview--builtin">
                  <img src={DEFAULT_APPEARANCE_PREVIEW_SRC} alt="" />
                </span>
                <span className="appearance-package-config__card-body appearance-package-config__card-body--inline">
                  <span className="appearance-package-config__card-copy">
                    <strong>{t('theme.nativeName')}</strong>
                    <span className="appearance-package-config__card-description">
                      {formatStandaloneUiText(t('theme.nativeDescription'))}
                    </span>
                  </span>
                  <span
                    className="appearance-package-config__builtin-theme-select"
                    data-openbitfun-component="appearance-settings"
                    data-openbitfun-part="packageBuiltinTheme"
                  >
                    <Select
                      size="sm"
                      value={selectedBuiltinThemeId}
                      placeholder={t('theme.builtinTheme')}
                      options={builtinThemeOptions}
                      onValueChange={value => void select(String(value))}
                      disabled={busy}
                      aria-label={t('theme.builtinTheme')}
                      data-testid="appearance-builtin-theme-select"
                    />
                  </span>
                </span>
              </>
            )}
          />
        </article>
      </div>
    </ConfigPageSection>
  );
}
