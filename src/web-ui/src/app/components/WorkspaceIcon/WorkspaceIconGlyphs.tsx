import { Button, Dialog, DialogBody, DialogClose, DialogHeader, DialogHeading, DialogTitle, SegmentedControl } from '@openbitfun/ui';
import { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { workspaceIconGlyphs } from '@/infrastructure/workspace-icons/workspaceIcons';
import { WorkspaceIconArt } from './WorkspaceIcon';

const lifeGlyphs: readonly string[] = ['travel', 'food', 'fitness', 'music', 'reading', 'home', 'finance', 'photography', 'pets', 'nature', 'shopping', 'movies'];

export function WorkspaceIconGlyphs({ value, color, remote, disabled, supported, onChange, onClose }: {
  value: string; color: string; remote: boolean; disabled: boolean;
  supported?: readonly string[]; onChange: (glyph: string) => void; onClose: () => void;
}) {
  const { t } = useI18n('common');
  const [group, setGroup] = useState(lifeGlyphs.includes(value) ? 'life' : 'work');
  const choices = workspaceIconGlyphs.filter(glyph => lifeGlyphs.includes(glyph) === (group === 'life'));
  return <Dialog open size="sm" onOpenChange={open => { if (!open) onClose(); }}>
    <DialogHeader className="workspace-icon-editor__header">
      <DialogHeading className="workspace-icon-editor__heading"><DialogTitle>{t('nav.workspaces.icon.chooseIcon')}</DialogTitle></DialogHeading>
      <DialogClose className="workspace-icon-editor__close" />
    </DialogHeader>
    <DialogBody><div className="workspace-icon-editor__glyphs" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="glyphs">
      <SegmentedControl value={group} onValueChange={setGroup} tone="neutral" aria-label={t('nav.workspaces.icon.builtinIcons')}
        options={[{ value: 'work', label: t('nav.workspaces.icon.workIcons') }, { value: 'life', label: t('nav.workspaces.icon.lifeIcons') }]} />
      <div className="workspace-icon-editor__glyph-grid" role="group" aria-label={t('nav.workspaces.icon.builtinIcons')}>
        {choices.map(glyph => <Button key={glyph} className="workspace-icon-editor__glyph" variant="quiet" labelBehavior="static"
          aria-label={t(`nav.workspaces.icon.glyphs.${glyph}`)} title={t(`nav.workspaces.icon.glyphs.${glyph}`)}
          aria-pressed={value === glyph} disabled={disabled || !supported?.includes(glyph)} onClick={() => onChange(glyph)}>
          <span className="workspace-icon-editor__glyph-option"><WorkspaceIconArt glyph={glyph} color={color} remote={remote} size={28} />
            <span>{t(`nav.workspaces.icon.glyphs.${glyph}`)}</span></span>
        </Button>)}
      </div>
      {!choices.some(glyph => supported?.includes(glyph)) && <p className="workspace-icon-editor__glyph-hint" role="status">{t('nav.workspaces.icon.glyphsUnsupported')}</p>}
    </div></DialogBody>
  </Dialog>;
}
