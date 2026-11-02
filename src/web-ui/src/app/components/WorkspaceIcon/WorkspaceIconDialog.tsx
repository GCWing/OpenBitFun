import { Button, Checkbox, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, Icon, IconButton, SegmentedControl } from '@openbitfun/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, isSurfaceChangedError, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { iconColors, invalidateWorkspaceIcons, saveWorkspaceIcon, type WorkspaceIconInput, type WorkspaceIconSnapshot } from '@/infrastructure/workspace-icons/workspaceIcons';
import { useWorkspaceIcon } from '@/infrastructure/workspace-icons/useWorkspaceIcon';
import type { WorkspaceInfo } from '@/shared/types';
import { WorkspaceIconArt } from './WorkspaceIcon';
import { WorkspaceIconColors } from './WorkspaceIconColors';
import { WorkspaceIconGlyphs } from './WorkspaceIconGlyphs';
import { useWorkspaceIconImageDraft } from './useWorkspaceIconImageDraft';

export default function WorkspaceIconDialog({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
  const { t } = useI18n('common');
  const scope = useMemo(() => getActiveSurfaceScope(), []);
  const live = useWorkspaceIcon(workspace.id);
  const [initial, setInitial] = useState<WorkspaceIconSnapshot>();
  const [mode, setMode] = useState<'default' | 'image'>('default');
  const [color, setColor] = useState('default');
  const [glyph, setGlyph] = useState('default');
  const [glyphPickerOpen, setGlyphPickerOpen] = useState(false);
  const [imageTarget, setImageTarget] = useState<'default' | 'light' | 'dark'>('default');
  const fileTarget = useRef<'default' | 'light' | 'dark'>('default');
  const light = useWorkspaceIconImageDraft(scope, initial?.imageData);
  const dark = useWorkspaceIconImageDraft(scope, initial?.darkImageData);
  const activeImage = imageTarget === 'dark' ? dark : light;
  const themedImages = initial?.supportsThemedImages === true;
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseImage = (target: 'default' | 'light' | 'dark') => {
    if (target === 'dark' && !themedImages) return;
    setImageTarget(target); fileTarget.current = target; fileInput.current?.click();
  };
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const retry = useRef<{ payload: string; id: string }>();
  useEffect(() => onSurfaceActivated(onClose), [onClose]);
  useEffect(() => {
    if (!initial && live.snapshot) {
      setInitial(live.snapshot); setMode(live.snapshot.icon.mode); setColor(live.snapshot.icon.color);
      setGlyph(live.snapshot.icon.glyph ?? 'default');
    }
  }, [initial, live.snapshot]);
  const imageError = mode === 'image' && (light.error || dark.error);
  const disabled = saving || !initial || (mode === 'image' && (light.pending || dark.pending || imageError
    || (!light.image && !dark.image && !initial.icon.assetId)))
    || (!(iconColors as readonly string[]).includes(color) && !/^#[\da-f]{6}$/i.test(color));
  const submit = async () => {
    if (!initial || disabled) return;
    const input: WorkspaceIconInput = mode === 'default'
      ? { kind: 'default', color, ...(glyph !== (initial.icon.glyph ?? 'default') ? { glyph } : {}) }
      : { kind: 'image', color, ...(light.dataBase64 ? { dataBase64: light.dataBase64 } : {}),
        ...(dark.dataBase64 ? { darkDataBase64: dark.dataBase64 } : {}) };
    const payload = JSON.stringify(input);
    if (retry.current?.payload !== payload) retry.current = { payload, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try {
      await saveWorkspaceIcon(scope, workspace.id, initial.icon.revision, retry.current.id, input);
      onClose();
    } catch (cause) {
      if (!isSurfaceChangedError(cause) && scope.isCurrent()) setError(t('nav.workspaces.icon.saveFailed', { reason: String(cause) }));
    } finally { if (scope.isCurrent()) setSaving(false); }
  };
  return <Dialog className="workspace-icon-editor__dialog" open onOpenChange={open => { if (!open && !saving) onClose(); }} size="md">
    <DialogHeader className="workspace-icon-editor__header">
      <DialogHeading className="workspace-icon-editor__heading"><DialogTitle>{t('nav.workspaces.icon.title')}</DialogTitle></DialogHeading>
      <DialogClose className="workspace-icon-editor__close" disabled={saving} />
    </DialogHeader>
    <DialogBody className="workspace-icon-editor__body"><div className="workspace-icon-editor" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="root">
      {live.unsupported ? <p role="status">{t('nav.workspaces.icon.unsupported')}</p> : null}
      {live.error ? <div role="alert"><p>{t('nav.workspaces.icon.loadFailed')}</p><Button onClick={invalidateWorkspaceIcons}>{t('nav.workspaces.icon.retry')}</Button></div> : null}
      {!initial && !live.error && !live.unsupported ? <p role="status">{t('nav.workspaces.icon.loading')}</p> : null}
      {initial ? <div className="workspace-icon-editor__layout" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="row">
        <SegmentedControl className="workspace-icon-editor__mode-switch" value={mode} disabled={saving} tone="neutral" aria-label={t('nav.workspaces.icon.title')}
          options={[{ value: 'default', label: t('nav.workspaces.icon.default') }, { value: 'image', label: t('nav.workspaces.icon.image') }]}
          onValueChange={value => { if (value === 'default' || value === 'image') setMode(value); }} />
        <div className="workspace-icon-editor__content">
          <div className="workspace-icon-editor__preview-panel" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="previewPanel"
            role="group" aria-label={t('nav.workspaces.icon.preview')}>
            {(['light', 'dark'] as const).map(scheme => <div key={scheme} className="workspace-icon-editor__preview"
              data-openbitfun-design-system-root data-color-scheme={scheme} data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="preview"
              role="group" aria-label={t(`nav.workspaces.icon.${scheme}`)} data-selected={mode === 'image' && imageTarget === scheme}>
              <IconButton className="workspace-icon-editor__hero" aria-label={t(mode === 'default' ? 'nav.workspaces.icon.chooseIcon' : scheme === 'light' ? 'nav.workspaces.icon.chooseLightImage' : 'nav.workspaces.icon.chooseDarkImage')}
                aria-haspopup={mode === 'default' ? 'dialog' : undefined} aria-expanded={mode === 'default' ? glyphPickerOpen : undefined}
                aria-pressed={mode === 'image' ? imageTarget === scheme : undefined}
                disabled={saving || (mode === 'image' && scheme === 'dark' && !themedImages)}
                onClick={() => mode === 'default' ? setGlyphPickerOpen(true) : chooseImage(scheme)}
                icon={<><WorkspaceIconArt size={80} color={color} glyph={mode === 'default' ? glyph : initial.icon.glyph}
                  image={mode === 'image' ? (scheme === 'dark' ? dark.image ?? light.image : light.image ?? dark.image) : undefined} remote={workspace.workspaceKind === 'remote'} />
                  <span className="workspace-icon-editor__edit-indicator"><Icon name="edit" size="sm" /></span></>} />
              <span className="workspace-icon-editor__preview-label" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="label">{t(`nav.workspaces.icon.${scheme}`)}</span>
            </div>)}
          </div>
          <div className="workspace-icon-editor__controls" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="controls">
            {mode === 'default' ? <WorkspaceIconColors color={color} disabled={saving} onChange={setColor} /> :
              <div className="workspace-icon-editor__image-controls" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="row">
                <div className="workspace-icon-editor__row" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="row">
                  <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp" disabled={saving} onChange={event => {
                    const selected = event.target.files?.[0];
                    if (selected) { (fileTarget.current === 'dark' ? dark : light).choose(selected); setError(''); }
                    event.target.value = '';
                  }} />
                  <Button variant="primary" disabled={saving} onClick={() => chooseImage('default')}>{t('nav.workspaces.icon.chooseImage')}</Button>
                </div>
                {activeImage.file ? <div className="workspace-icon-editor__adjustments" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="row">
                  <Checkbox className="workspace-icon-editor__crop" size="sm" checked={activeImage.crop} disabled={saving}
                    onCheckedChange={activeImage.setCrop} label={t('nav.workspaces.icon.crop')} />
                  <label className="workspace-icon-editor__label workspace-icon-editor__zoom" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="label">
                    {t('nav.workspaces.icon.zoom')}
                    <input className="form-range workspace-icon-editor__range" type="range" min="1" max="3" step="0.05"
                      value={activeImage.zoom} disabled={saving} onChange={event => activeImage.setZoom(Number(event.target.value))} />
                  </label>
                </div> : null}
                {((imageTarget === 'dark' ? initial.darkImageUnavailable : initial.imageUnavailable) && !activeImage.file) ? <p role="status">{t('nav.workspaces.icon.loadFailed')}</p> : null}
                {!themedImages ? <p className="workspace-icon-editor__glyph-hint" role="status">{t('nav.workspaces.icon.themedImagesUnsupported')}</p> : null}
              </div>}
          </div>
        </div>
        {glyphPickerOpen ? <WorkspaceIconGlyphs value={glyph} color={color} remote={workspace.workspaceKind === 'remote'}
          disabled={saving} supported={initial.supportedGlyphs} onClose={() => setGlyphPickerOpen(false)}
          onChange={value => { setGlyph(value); setGlyphPickerOpen(false); }} /> : null}
      </div> : null}
      {error || imageError ? <p className="workspace-icon-editor__error" data-openbitfun-component="workspace-icon-editor" data-openbitfun-part="error" role="alert">{error || t('nav.workspaces.icon.invalidImage')}</p> : null}
    </div></DialogBody>
    <DialogFooter className="workspace-icon-editor__footer">
      <Button disabled={saving} onClick={onClose}>{t('actions.cancel')}</Button>
      <Button variant="primary" disabled={disabled} onClick={() => { void submit(); }}>{t('actions.save')}</Button>
    </DialogFooter>
  </Dialog>;
}
