import { createFlowChatHighlightOwner } from './flowChatHighlights';

/** Each mounted transcript row owns only its ranges, including in sibling panes. */
export function createExcerptHighlights(document: Document) {
  return createFlowChatHighlightOwner(document, 'annotations');
}
