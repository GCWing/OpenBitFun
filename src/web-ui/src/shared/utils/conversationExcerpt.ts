import type { ContextItem, ConversationExcerptContext } from '../types/context';

export function isConversationExcerpt(context: ContextItem): context is ConversationExcerptContext {
  return context.type === 'conversation-excerpt';
}

export function excerptText(context: ConversationExcerptContext): string {
  return context.fragments.map(fragment => fragment.text).join('\n\n');
}

export function excerptNumber(context: ConversationExcerptContext): number | undefined {
  return Number.isSafeInteger(context.annotationNumber) && context.annotationNumber! > 0
    ? context.annotationNumber : undefined;
}

export function numberConversationExcerpt(context: ConversationExcerptContext, known: readonly ConversationExcerptContext[]): ConversationExcerptContext {
  const previous = known.find(item => item.id === context.id);
  const number = excerptNumber(previous ?? context) ?? known.reduce((max, item) => Math.max(max, excerptNumber(item) ?? 0), 0) + 1;
  return context.annotationNumber === number ? context : { ...context, annotationNumber: number };
}

/** Validate persisted/remote data before rendering or sending it. Unknown fields remain tolerated. */
export function isValidConversationExcerpt(value: unknown): value is ConversationExcerptContext {
  if (!value || typeof value !== 'object') return false;
  const item = value as ConversationExcerptContext;
  return item.type === 'conversation-excerpt'
    && typeof item.id === 'string' && item.id.length > 0
    && Number.isFinite(item.timestamp)
    && !!item.source && typeof item.source.surfaceId === 'string' && item.source.surfaceId.length > 0
    && typeof item.source.sessionId === 'string' && item.source.sessionId.length > 0
    && typeof item.source.sessionName === 'string'
    && (item.comment === undefined || typeof item.comment === 'string')
    && Array.isArray(item.fragments) && item.fragments.length > 0
    && item.fragments.every(fragment => !!fragment
      && typeof fragment.turnId === 'string' && fragment.turnId.length > 0
      && (fragment.flowItemId === undefined || typeof fragment.flowItemId === 'string')
      && typeof fragment.text === 'string' && fragment.text.trim().length > 0
      && Number.isInteger(fragment.start) && fragment.start >= 0
      && Number.isInteger(fragment.end) && fragment.end > fragment.start
      && fragment.end - fragment.start === fragment.text.length
      && typeof fragment.prefix === 'string' && typeof fragment.suffix === 'string');
}

export function excerptIdentity(context: ConversationExcerptContext): string {
  return JSON.stringify([context.source.surfaceId, context.source.sessionId,
    context.fragments.map(({ turnId, flowItemId, start, end, text, markdownStart }) =>
      markdownStart === undefined ? [turnId, flowItemId, start, end, text]
        : [turnId, flowItemId, start, end, text, markdownStart])]);
}

/** Duplicate selections update the existing note without replacing unrelated attachments. */
export function appendConversationExcerpt(contexts: ContextItem[], excerpt: ConversationExcerptContext): ContextItem[] {
  const existing = contexts.find(context => isConversationExcerpt(context)
    && excerptIdentity(context) === excerptIdentity(excerpt));
  if (!existing) return [...contexts, excerpt];
  return contexts.map(context => context.id === existing.id
    ? { ...excerpt, id: existing.id, annotationNumber: excerptNumber(existing as ConversationExcerptContext) ?? excerptNumber(excerpt),
      comment: excerpt.comment ?? (existing as ConversationExcerptContext).comment }
    : context);
}

export function formatConversationExcerpt(context: ConversationExcerptContext): string {
  // JSON escaping keeps quoted delimiters/instructions inside the source-material field.
  // The complete text is also the compatibility fallback for older hosts/readers.
  return [
    '[Conversation excerpt — quoted source material]',
    JSON.stringify({ session: context.source.sessionName, sessionId: context.source.sessionId,
      annotationNumber: excerptNumber(context),
      fragments: context.fragments.map(({ turnId, flowItemId, text }) => ({ turnId, flowItemId, text })) }),
    context.comment?.trim() ? 'User annotation: ' + context.comment.trim() : '',
    '[/Conversation excerpt]',
  ].filter(Boolean).join('\n');
}

/** Older readers reject unknown presentation contexts, so display text remains complete. */
export function withConversationExcerptFallback(text: string, contexts: ContextItem[]): string {
  return [text, ...contexts.filter(isConversationExcerpt).map(formatConversationExcerpt)].filter(Boolean).join('\n\n');
}
