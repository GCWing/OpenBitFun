import {
  Input,
  NumberInput,
  Select,
  type SelectOption,
} from '@openbitfun/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { useFontPreference } from '../hooks/useFontPreference';
import { FontSizeLevel, PRESET_UI_BASE_PX, UI_FONT_SIZE_PRESETS } from '../types';
import './FontPreferencePanel.scss';

const UI_LEVELS: Array<Exclude<FontSizeLevel, 'custom'>> = ['compact', 'small', 'default', 'medium', 'large'];

export function FontPreferencePanel() {
  const { t } = useTranslation('settings/application');
  const { preference, setUiSize } = useFontPreference();

  const { level, customPx } = preference.uiSize;
  const [customInput, setCustomInput] = useState<string>(String(customPx ?? 14));
  const [previewText, setPreviewText] = useState('');

  useEffect(() => {
    setCustomInput(String(customPx ?? PRESET_UI_BASE_PX.default));
  }, [customPx]);

  /** Baseline px currently applied in the UI (preset level or custom). */
  const getEffectiveUiBasePx = useCallback((): number => {
    if (level === 'custom') {
      const n = parseInt(customInput, 10);
      if (!isNaN(n) && n >= 12 && n <= 20) return n;
      return customPx ?? 14;
    }
    return PRESET_UI_BASE_PX[level];
  }, [level, customInput, customPx]);

  const handleLevelClick = useCallback(async (l: FontSizeLevel) => {
    if (l === 'custom') {
      const px = getEffectiveUiBasePx();
      setCustomInput(String(px));
      await setUiSize('custom', px);
    } else {
      await setUiSize(l);
    }
  }, [getEffectiveUiBasePx, setUiSize]);

  const handleCustomValueChange = (px: number) => {
    setCustomInput(String(px));
    void setUiSize('custom', px);
  };

  const previewBasePx = level === 'custom'
    ? (parseInt(customInput, 10) || 14)
    : parseInt(UI_FONT_SIZE_PRESETS[level].base, 10);

  const levelOptions = useMemo<SelectOption[]>(
    () => [
      ...UI_LEVELS.map((l) => ({
        value: l,
        label: t(`appearance.fontSize.levels.${l}`),
      })),
      {
        value: 'custom',
        label: t('appearance.fontSize.levels.custom'),
      },
    ],
    [t]
  );

  return (
    <div
      data-testid="appearance-font-section"
      data-openbitfun-component="font-preference"
      data-openbitfun-part="root"
    >
      <ConfigPageSection
        className="font-pref-panel__section"
        title={t('appearance.fontSize.title')}
        description={t('appearance.fontSize.hint')}
      >
        <ConfigPageRow
          label={t('appearance.fontSize.uiSizeLabel')}
          align="center"
        >
          <Select
            aria-label={t('appearance.fontSize.uiSizeLabel')}
            data-testid="appearance-ui-font-level-group"
            options={levelOptions}
            size="sm"
            value={level}
            onValueChange={(value) => void handleLevelClick(value as FontSizeLevel)}
          />
        </ConfigPageRow>
        {level === 'custom' && (
          <ConfigPageRow label={t('appearance.fontSize.customPxLabel')} align="center">
            <div
              className="font-pref-panel__custom-controls"
              data-testid="appearance-ui-font-custom-controls"
              data-openbitfun-component="font-preference"
              data-openbitfun-part="customControls"
            >
              <NumberInput
                value={parseInt(customInput, 10) || 14}
                min={12}
                max={20}
                step={1}
                unit="px"
                variant="stepper"
                size="sm"
                decrementLabel={`${t('appearance.fontSize.customPxLabel')} −1`}
                incrementLabel={`${t('appearance.fontSize.customPxLabel')} +1`}
                onValueChange={handleCustomValueChange}
                aria-label={t('appearance.fontSize.customPxLabel')}
              />
            </div>
          </ConfigPageRow>
        )}
        <ConfigPageRow label={t('appearance.fontSize.previewLabel')} multiline>
          <div
            className="font-pref-panel__preview"
            data-openbitfun-component="font-preference"
            data-openbitfun-part="preview"
          >
            <Input
              className="font-pref-panel__preview-input"
              aria-label={t('appearance.fontSize.previewLabel')}
              autoComplete="off"
              data-testid="appearance-ui-font-preview-input"
              onValueChange={setPreviewText}
              placeholder={t('appearance.fontSize.previewPlaceholder')}
              size="sm"
              spellCheck={false}
              style={{ fontSize: `${previewBasePx}px` }}
              value={previewText}
            />
          </div>
        </ConfigPageRow>
      </ConfigPageSection>
    </div>
  );
}
