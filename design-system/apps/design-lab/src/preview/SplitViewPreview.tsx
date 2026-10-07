import { useEffect, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { Button, Icon, IconButton, Input, SplitView, Tooltip, type SplitViewMode } from '@openbitfun/ui';
import { useI18n } from '../i18n';
import './SplitViewPreview.css';

export function SplitViewPreview({ state }: { state: string }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<SplitViewMode>('split');
  const [side, setSide] = useState<'left' | 'right'>('right');
  const [rightSize, setRightSize] = useState(280);
  useEffect(() => { setMode(state === 'primary' || state === 'secondary' ? state : 'split'); }, [state]);

  return <div className="split-view-preview">
    <div className="split-view-preview__controls">
      <Button size="sm" onClick={() => setMode('split')}>{t('splitView.split')}</Button>
      <Button size="sm" onClick={() => setMode('primary')}>{t('splitView.hide')}</Button>
      <Button size="sm" onClick={() => setMode('secondary')}>{t('splitView.maximize')}</Button>
    </div>
    <div className="split-view-preview__viewport">
      <SplitView mode={mode} secondarySide={side} rightSize={rightSize} onRightSizeChange={setRightSize}
        minLeftSize={180} minRightSize={180} defaultRightSize={280} dividerLabel={t('splitView.resize')}
        dividerActions={<Tooltip content={t('splitView.swap')}><IconButton size="sm" aria-label={t('splitView.swap')}
          icon={<Icon glyph={ArrowLeftRight} size="sm" />} onClick={() => setSide(value => value === 'right' ? 'left' : 'right')} /></Tooltip>}
        primary={<div className="split-view-preview__pane"><strong>{t('splitView.primary')}</strong><Input aria-label={t('splitView.draft')} placeholder={t('splitView.draft')} /></div>}
        secondary={<div className="split-view-preview__pane"><strong>{t('splitView.secondary')}</strong><Input aria-label={t('splitView.edit')} placeholder={t('splitView.edit')} /></div>}
      />
    </div>
    <p className="split-view-preview__note">{t('splitView.help')}</p>
  </div>;
}
