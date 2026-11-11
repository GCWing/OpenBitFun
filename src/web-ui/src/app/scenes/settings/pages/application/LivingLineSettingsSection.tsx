import { useEffect, useState } from 'react';
import { Button } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { RANGES } from '@/flow_chat/components/living-line/settings';
import {
  DEFAULT_SETTINGS,
  type LivingLineSettings,
} from '@/flow_chat/components/living-line/settings';
import {
  readLivingLineSettings,
  saveLivingLineSettings,
  subscribeLivingLineSettings,
} from '@/flow_chat/components/living-line/livingLineSettingsStore';

const log = createLogger('LivingLineSettingsSection');

const STEP_BY_FIELD: Partial<Record<keyof LivingLineSettings, number>> = {
  lineWidth: 0.1,
  flowLength: 1,
  flowWidth: 0.1,
  flowBlur: 0.5,
  flowIntensity: 0.05,
  lineGlowBlur: 0.5,
  idlePeriodSeconds: 0.5,
  workingPeriodSeconds: 0.1,
};

const COLOR_FIELDS: Array<keyof LivingLineSettings> = ['lineColor', 'questionColor', 'errorColor', 'flowColor'];
const NUMBER_FIELDS: Array<keyof LivingLineSettings> = [
  'lineWidth', 'flowLength', 'flowWidth', 'flowBlur', 'flowIntensity',
  'lineGlowBlur', 'idlePeriodSeconds', 'workingPeriodSeconds',
];

export default function LivingLineSettingsSection() {
  const { t } = useI18n('settings/runtime');
  const notification = useNotification();
  const [settings, setSettings] = useState<LivingLineSettings>(readLivingLineSettings);

  useEffect(() => subscribeLivingLineSettings(() => setSettings(readLivingLineSettings())), []);

  const update = (patch: Partial<LivingLineSettings>) => {
    try {
      setSettings(saveLivingLineSettings(patch));
    } catch (error) {
      log.error('Failed to save LivingLine settings', error);
      notification.error(t('messages.saveFailed'));
    }
  };

  return (
    <ConfigPageSection
      title={t('features.pet.livingLine.title')}
      extra={
        <Button size="sm" variant="quiet" onClick={() => update(DEFAULT_SETTINGS)}>
          {t('features.pet.livingLine.reset')}
        </Button>
      }
    >
      {COLOR_FIELDS.map(field => (
        <ConfigPageRow key={field} label={t(`features.pet.livingLine.${field}`)} align="center">
          <input
            type="color"
            value={settings[field] as string}
            aria-label={t(`features.pet.livingLine.${field}`)}
            onChange={event => update({ [field]: event.target.value } as Partial<LivingLineSettings>)}
          />
        </ConfigPageRow>
      ))}
      {NUMBER_FIELDS.map(field => {
        const [min, max] = RANGES[field as keyof typeof RANGES];
        return (
          <ConfigPageRow key={field} label={t(`features.pet.livingLine.${field}`)} align="center">
            <input
              type="range"
              min={min}
              max={max}
              step={STEP_BY_FIELD[field] ?? 1}
              value={settings[field] as number}
              aria-label={t(`features.pet.livingLine.${field}`)}
              onChange={event => update({ [field]: Number(event.target.value) } as Partial<LivingLineSettings>)}
            />
            <output aria-live="polite">{settings[field]}</output>
          </ConfigPageRow>
        );
      })}
    </ConfigPageSection>
  );
}