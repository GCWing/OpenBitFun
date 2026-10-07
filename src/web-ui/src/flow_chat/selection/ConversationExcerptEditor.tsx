import type { ReactNode, RefObject } from 'react';
import { Textarea } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import type { ConversationExcerptContext } from '@/shared/types/context';
import { excerptText } from '@/shared/utils/conversationExcerpt';

export function ConversationExcerptQuote({ excerpt, action }: { excerpt: ConversationExcerptContext; action?: ReactNode }) {
  const quote = excerptText(excerpt).replace(/\s+/g, ' ').trim();
  return <div className="conversation-excerpt__source">
    <div className="conversation-excerpt__quote"
      data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="quote">
      <span className="conversation-excerpt__quote-text"
        data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="quoteText">{quote}</span>
    </div>
    {action}
  </div>;
}

/** Shared compact content for creating and editing an annotation. */
export function ConversationExcerptEditor({ excerpt, comment, onCommentChange, inputRef, onSubmit, quoteAction }: {
  excerpt: ConversationExcerptContext;
  comment: string;
  onCommentChange: (comment: string) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  onSubmit: () => void;
  quoteAction?: ReactNode;
}) {
  const { t } = useI18n('flow-chat');
  return <>
    <ConversationExcerptQuote excerpt={excerpt} action={quoteAction} />
    <Textarea ref={inputRef} className="conversation-excerpt__input" rows={3} resize="none" variant="filled" autoResize
      aria-label={t('selection.annotation')} placeholder={t('selection.annotationPlaceholder')}
      value={comment} onValueChange={onCommentChange} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault(); onSubmit();
        }
      }} />
  </>;
}
