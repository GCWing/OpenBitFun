import { useLayoutEffect, useRef, useState } from 'react';
import {
  Button, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading,
  DialogTitle, ScrollArea,
} from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system';
import type { ExcerptDialogTarget } from './conversationExcerptEditing';
import { ConversationExcerptEditor, ConversationExcerptQuote } from './ConversationExcerptEditor';
import { locateConversationExcerpt } from './locateConversationExcerpt';
import './ConversationExcerpt.scss';

/** Shared dialog anatomy with explicit viewing and pending-edit modes. */
export function ConversationExcerptDialog({ target, label, open, onOpenChange }: {
  target: ExcerptDialogTarget;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n('flow-chat');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [comment, setComment] = useState(target.excerpt.comment ?? '');
  useLayoutEffect(() => { if (open) setComment(target.excerpt.comment ?? ''); }, [open, target]);
  const dirty = target.mode === 'edit' && comment.trim() !== (target.excerpt.comment ?? '').trim();
  const available = target.isCurrent();
  const commit = () => {
    if (target.mode !== 'edit') return false;
    const result = target.save(comment);
    if (result === 'saved') return true;
    notificationService.warning(t(result === 'queue-unavailable' ? 'selection.queueEditUnavailable' : 'selection.editUnavailable'));
    return false;
  };
  const save = () => { if (commit()) onOpenChange(false); };
  const remove = () => {
    if (target.mode !== 'edit') return;
    const result = target.remove();
    if (result === 'removed') onOpenChange(false);
    else notificationService.warning(t(result === 'queue-unavailable' ? 'selection.queueEditUnavailable' : 'selection.editUnavailable'));
  };
  const locate = () => {
    if (!target.isCurrent()) {
      notificationService.warning(t(target.mode === 'edit' ? 'selection.editUnavailable' : 'selection.sourceUnavailable'));
      return;
    }
    // Navigation closes the editor; commit changed text explicitly so it is not lost.
    if (dirty && !commit()) return;
    onOpenChange(false);
    void locateConversationExcerpt(target.mode === 'edit' ? { ...target.excerpt, comment: comment.trim() } : target.excerpt,
      () => notificationService.warning(t('selection.sourceUnavailable')));
  };
  const locateLabel = dirty ? t('selection.saveAndLocate') : t('selection.locate');
  return <Dialog open={open} onOpenChange={onOpenChange} size="sm" className="conversation-excerpt__dialog"
    initialFocusRef={target.mode === 'edit' ? inputRef : undefined}
    data-flowchat-selection-ignore="true" data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="dialog"
    onKeyDown={event => event.stopPropagation()}>
    <DialogHeader>
      <DialogHeading><DialogTitle>{label}</DialogTitle></DialogHeading>
      <DialogClose />
    </DialogHeader>
    <DialogBody>
      <div className="conversation-excerpt__editor"
        data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="editor">
        {target.mode === 'edit' ? <ConversationExcerptEditor excerpt={target.excerpt} comment={comment} onCommentChange={setComment}
          inputRef={inputRef} onSubmit={save} /> : <>
          <ConversationExcerptQuote excerpt={target.excerpt} />
          {target.excerpt.comment?.trim() && <ScrollArea className="conversation-excerpt__comment" tabIndex={0} aria-label={label}
            data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="comment">
            {target.excerpt.comment}
          </ScrollArea>}
        </>}
      </div>
    </DialogBody>
    <DialogFooter>
      {target.mode === 'edit' && <Button variant="text" tone="danger" disabled={!available}
        onClick={remove}>{t('selection.remove')}</Button>}
      <Button variant="outline"
        data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="locate"
        disabled={!available} onClick={locate}>{locateLabel}</Button>
      {target.mode === 'edit' && <>
        <Button variant="fill" onClick={() => onOpenChange(false)}>{t('selection.cancel')}</Button>
        <Button variant="primary" disabled={!available} onClick={save}>{t('selection.save')}</Button>
      </>}
    </DialogFooter>
  </Dialog>;
}
