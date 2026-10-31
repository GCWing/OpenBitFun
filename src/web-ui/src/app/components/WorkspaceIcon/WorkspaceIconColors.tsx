import { ColorPicker, Dialog, DialogBody, DialogClose, DialogHeader, DialogHeading, DialogTitle, Icon, IconButton } from '@openbitfun/ui';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useAppearance } from '@/infrastructure/appearance';
import { useI18n } from '@/infrastructure/i18n';
import { iconColors, iconColorStyle } from '@/infrastructure/workspace-icons/workspaceIcons';

/** Resolve the rendered theme color without replacing the persisted preset name. */
function readColorHex(element: HTMLElement): string | undefined {
  const color = element.ownerDocument.defaultView?.getComputedStyle(element).backgroundColor;
  if (!color || /var\(|currentcolor/i.test(color)) return undefined;
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color);
  let channels = rgb?.slice(1, 4).map(Number);
  if (!channels) {
    // Canvas projects supported wide-gamut theme colors into the picker's sRGB HEX format.
    const canvas = element.ownerDocument.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
  }
  return `#${channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function WorkspaceIconColors({ color, disabled, onChange }: {
  color: string; disabled: boolean; onChange: (color: string) => void;
}) {
  const { t } = useI18n('common');
  const { current: appearance } = useAppearance();
  const selectedSwatch = useRef<HTMLSpanElement>(null);
  const pickerId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [resolvedHex, setResolvedHex] = useState('');
  const isPreset = (iconColors as readonly string[]).includes(color);
  useLayoutEffect(() => {
    if (/^#[\da-f]{6}$/i.test(color)) setResolvedHex(color.toUpperCase());
    else if (isPreset && selectedSwatch.current) {
      const hex = readColorHex(selectedSwatch.current);
      if (hex) setResolvedHex(hex);
    }
  }, [color, isPreset, appearance]);

  const pickerValue = isPreset ? resolvedHex : color;
  const pickerLabels = { color: t('nav.workspaces.icon.colorValue'), palette: t('nav.workspaces.icon.customColor'),
    lightness: t('nav.workspaces.icon.lightness'), edit: t('actions.edit'), apply: t('actions.apply') };
  return <div className="workspace-icon-editor__colors" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="row">
    <div className="workspace-icon-editor__palette" role="group" aria-label={t('nav.workspaces.icon.colors')}
      data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="row">
      {iconColors.map(value => <IconButton key={value} className="workspace-icon-editor__swatch" shape="circle" size="sm"
        aria-label={t(`nav.workspaces.icon.palette.${value}`)} title={t(`nav.workspaces.icon.palette.${value}`)}
        aria-pressed={color === value} disabled={disabled} onClick={() => onChange(value)}
        icon={<span ref={color === value ? selectedSwatch : undefined} className="workspace-icon-editor__color"
          data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="color" style={{ backgroundColor: iconColorStyle(value) }} />} />)}
      <IconButton className="workspace-icon-editor__swatch" shape="circle" size="sm"
        aria-label={t('nav.workspaces.icon.customColor')} title={t('nav.workspaces.icon.customColor')} aria-pressed={!isPreset}
        aria-expanded={pickerOpen} aria-haspopup="dialog" aria-controls={pickerOpen ? pickerId : undefined}
        disabled={disabled} onClick={() => setPickerOpen(true)}
        icon={<span className="workspace-icon-editor__color workspace-icon-editor__color--custom"><Icon name="plus" size="sm" /></span>} />
    </div>
    <ColorPicker className="workspace-icon-editor__picker" value={pickerValue}
      disabled={disabled} open={false} onOpenChange={setPickerOpen} onValueChange={onChange} labels={pickerLabels} />
    {pickerOpen ? <Dialog id={pickerId} open size="sm" onOpenChange={setPickerOpen}>
      <DialogHeader className="workspace-icon-editor__header">
        <DialogHeading className="workspace-icon-editor__heading"><DialogTitle>{t('nav.workspaces.icon.customColor')}</DialogTitle></DialogHeading>
        <DialogClose className="workspace-icon-editor__close" />
      </DialogHeader>
      <DialogBody>
        <ColorPicker className="workspace-icon-editor__picker" value={pickerValue}
          disabled={disabled} open onOpenChange={setPickerOpen} onValueChange={onChange} labels={pickerLabels} />
      </DialogBody>
    </Dialog> : null}
  </div>;
}
