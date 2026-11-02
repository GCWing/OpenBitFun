import { useState } from 'react';
import { ColorPicker } from '@openbitfun/ui';
import { useI18n } from '../i18n';

export function ColorPickerPreview({ state = 'collapsed' }: { state?: string }) {
  const { t } = useI18n();
  const [value, setValue] = useState<string | undefined>(state === 'invalid' ? '#12' : undefined);
  return <ColorPicker value={value} onValueChange={setValue} defaultOpen={state === 'expanded'} disabled={state === 'disabled'}
    labels={{ color: t('colorPicker.color'), palette: t('colorPicker.palette'), edit: t('colorPicker.edit'), apply: t('colorPicker.apply'), lightness: t('colorPicker.lightness') }} />;
}
