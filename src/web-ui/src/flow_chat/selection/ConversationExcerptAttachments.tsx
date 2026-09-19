import { useEffect, useId, useRef, useState } from 'react';
import { createOverlayPortal, Button, Card, Icon, IconButton, useDismissibleLayer } from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { ContextItem, ConversationExcerptContext } from '@/shared/types/context';
import { excerptNumber, excerptText, isConversationExcerpt } from '@/shared/utils/conversationExcerpt';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { ConversationExcerptDialog } from './ConversationExcerptDialog';
import { conversationExcerptDialogTarget, type ExcerptDialogTarget } from './conversationExcerptEditing';
import './ConversationExcerpt.scss';

interface ExcerptDialogState {
  target: ExcerptDialogTarget;
  open: boolean;
}

function useExcerptLabel(excerpt: ConversationExcerptContext) {
  const { t, formatNumber } = useI18n('flow-chat');
  const number = excerptNumber(excerpt);
  return {
    label: number ? t('selection.numbered', { number: formatNumber(number) }) : t('selection.annotation'),
    numberLabel: number ? formatNumber(number) : undefined,
  };
}

export function ConversationExcerptAttachments({ contexts, onUpdate, onRemove, inline = false }: {
  contexts: ContextItem[];
  onUpdate: (id: string, comment: string) => void;
  onRemove: (id: string) => void;
  inline?: boolean;
}) {
  const { t, formatNumber } = useI18n('flow-chat');
  const excerpts = contexts.filter(isConversationExcerpt);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<(ExcerptDialogState & { label: string }) | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const id = useId();
  const cancelHide = () => { clearTimeout(hideTimer.current); };
  const close = () => { cancelHide(); setOpen(false); };
  const show = () => { cancelHide(); if (!dialog?.open) setOpen(true); };
  const contains = (node: Node | null) => !!node && Boolean(anchorRef.current?.contains(node) || popoverRef.current?.contains(node));
  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => {
      if (!contains(document.activeElement)) setOpen(false);
    }, 200);
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useEffect(() => { if (!excerpts.length) { setOpen(false); setDialog(null); } }, [excerpts.length]);
  const layout = useAnchoredPopoverPosition({ open, anchorRef, popoverRef, preferredPlacement: 'top', layoutRevision: contexts });
  useDismissibleLayer({ enabled: open, layerRef: popoverRef, branchRefs: [anchorRef], onDismiss: reason => {
    if (reason === 'escape-key') triggerRef.current?.focus();
    close();
  } });
  const edit = (excerpt: ConversationExcerptContext, label: string) => {
    close();
    const scope = getActiveSurfaceScope();
    setDialog({ open: true, label, target: {
      mode: 'edit', excerpt,
      isCurrent: () => scope.isCurrent() && scope.surfaceId === excerpt.source.surfaceId,
      save: comment => {
        if (!scope.isCurrent() || scope.surfaceId !== excerpt.source.surfaceId) return 'unavailable';
        onUpdate(excerpt.id, comment.trim());
        return 'saved';
      },
      remove: () => {
        if (!scope.isCurrent() || scope.surfaceId !== excerpt.source.surfaceId) return 'unavailable';
        onRemove(excerpt.id);
        return 'removed';
      },
    } });
  };
  if (!excerpts.length) return null;
  const countLabel = t('selection.count', { count: formatNumber(excerpts.length) });
  return <div data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="attachments"
    className={`conversation-excerpt__attachments${inline ? ' conversation-excerpt__attachments--inline' : ''}`}
    data-flowchat-selection-ignore="true">
    <div ref={anchorRef} className="conversation-excerpt__chip"
      data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="chip"
      onMouseEnter={show} onMouseLeave={scheduleHide}
      onBlur={event => { if (!contains(event.relatedTarget)) close(); }}>
      <Button ref={triggerRef} variant="text" size="sm" className="conversation-excerpt__attachment"
        data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="attachment"
        leadingIcon={<Icon name="session" />} aria-label={countLabel} aria-haspopup="dialog"
        aria-expanded={open} aria-controls={open ? id : undefined} onFocus={show} onClick={show}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' && open) {
            event.preventDefault(); event.stopPropagation(); popoverRef.current?.querySelector('button')?.focus();
          }
        }}>{countLabel}</Button>
      <IconButton size="xs" shape="circle" aria-label={t('selection.remove')} icon={<Icon name="xmark" />}
        onClick={() => { close(); excerpts.forEach(excerpt => onRemove(excerpt.id)); }} />
    </div>
    {open && createOverlayPortal(<Card ref={popoverRef} id={id} role="dialog" aria-label={countLabel}
      className="conversation-excerpt__details" appearance="raised" radius="lg"
      data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="details"
      data-flowchat-selection-ignore="true" data-openbitfun-native-webview-occlusion
      style={{ left: layout?.left ?? 0, top: layout?.top ?? 0, visibility: layout ? 'visible' : 'hidden' }}
      onMouseEnter={cancelHide} onMouseLeave={scheduleHide}
      onBlur={event => { if (!contains(event.relatedTarget)) close(); }}>
      {excerpts.map(excerpt => {
        const number = excerptNumber(excerpt);
        const label = number ? t('selection.numbered', { number: formatNumber(number) }) : t('selection.annotation');
        return <div key={excerpt.id} className="conversation-excerpt__detail"
          data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="detail">
          <span className="conversation-excerpt__detail-number"
            data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="detailNumber">{number ? `${formatNumber(number)}.` : ''}</span>
          <div className="conversation-excerpt__detail-text"
            data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="detailText">
            <span className="conversation-excerpt__detail-label"
              data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="detailLabel">{t('context.selection')}</span>
            <div>{excerptText(excerpt)}</div>
            {excerpt.comment?.trim() && <><span className="conversation-excerpt__detail-label"
              data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="detailLabel">{t('selection.annotation')}</span>
              <div>{excerpt.comment}</div></>}
          </div>
          <IconButton size="sm" aria-label={label} title={t('selection.editAnnotation')} icon={<Icon name="edit" />}
            onClick={() => edit(excerpt, label)} />
          <IconButton size="sm" aria-label={t('selection.removeNumbered', { annotation: label })} icon={<Icon name="delete" />}
            onClick={() => { triggerRef.current?.focus(); onRemove(excerpt.id); }} />
        </div>;
      })}
    </Card>, getAppearanceOverlayHost())}
    {dialog && <ConversationExcerptDialog target={dialog.target} label={dialog.label} open={dialog.open}
      onOpenChange={value => setDialog(current => current && { ...current, open: value })} />}
  </div>;
}

export function ConversationExcerptPreview({ excerpt, superscript = false, origin = 'sent' }: {
  excerpt: ConversationExcerptContext;
  superscript?: boolean;
  origin?: 'source' | 'sent';
}) {
  const { label, numberLabel } = useExcerptLabel(excerpt);
  const [dialog, setDialog] = useState<ExcerptDialogState | null>(null);
  const openDialog = () => setDialog({ open: true, target: conversationExcerptDialogTarget(excerpt, origin) });
  return <span data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="preview"
    className="conversation-excerpt__preview" data-flowchat-selection-ignore="true" onClick={event => event.stopPropagation()}>
    {superscript ? <Button size="xs" variant="primary" labelBehavior="static" className="conversation-excerpt__superscript"
      data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="superscript"
      aria-label={label} title={excerpt.comment || label} onClick={openDialog} aria-haspopup="dialog">{numberLabel ?? label}</Button>
      : <Button size="xs" variant="text" aria-label={label} title={excerpt.comment || label}
        onClick={openDialog} aria-haspopup="dialog">{label}</Button>}
    {dialog && <ConversationExcerptDialog target={dialog.target} label={label} open={dialog.open}
      onOpenChange={open => setDialog(current => current && { ...current, open })} />}
  </span>;
}
