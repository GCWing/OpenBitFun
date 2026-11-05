import React from 'react';

import type { ComposerPresentation } from '../../utils/composerPresentation';
import { getMcpPromptReferenceMatches } from '../../utils/mcpPromptReference';
import { MessageReferenceCapsule } from './MessageReferenceCapsule';
import { messageInlineTokenIcon } from './messageReferenceIcons';
import { ConversationExcerptPreview } from '../../selection/ConversationExcerptAttachments';
import { Icon, OverflowText } from '@openbitfun/ui';
import { splitLargePasteText } from '../../utils/largePasteMetadata';
import { UserMessageLargePasteContext } from './userMessageLargePasteContext';

const UserMessageLargePasteCapsule: React.FC<{
  placeholder: string;
  onOpen: (placeholder: string) => void;
}> = ({ placeholder, onOpen }) => (
  <button
    type="button"
    className="message-reference-capsule message-reference-capsule--large-paste user-message-item__reference user-message-item__reference--large-paste"
    data-openbitfun-product-component="user-message-item"
    data-openbitfun-product-part="content"
    title={placeholder}
    onClick={(event) => {
      event.stopPropagation();
      onOpen(placeholder);
    }}
  >
    <Icon name="file-text" size="sm" aria-hidden />
    <OverflowText className="message-reference-capsule__label user-message-item__reference-label">{placeholder}</OverflowText>
  </button>
);

const UserMessageMcpTextContent: React.FC<{ text: string }> = ({ text }) => {
  const matches = getMcpPromptReferenceMatches(text);
  if (matches.length === 0) return <>{text}</>;

  const content: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    content.push(text.slice(cursor, match.start));
    content.push(
      <MessageReferenceCapsule
        key={`mcp-${match.start}`}
        type="mcp"
        label={match.payload.serverName}
        title={`MCP: ${match.payload.serverName}`}
      ><Icon name="plug" size="sm" aria-hidden /></MessageReferenceCapsule>,
    );
    cursor = match.end;
  }
  content.push(text.slice(cursor));
  return <>{content}</>;
};

/** Render the persisted prompt format without requiring newer message metadata. */
export const UserMessageTextContent: React.FC<{ text: string }> = ({ text }) => {
  const largePaste = React.useContext(UserMessageLargePasteContext);
  if (largePaste?.largePastes) {
    const parts = splitLargePasteText(text, largePaste.largePastes);
    if (parts.some(part => part.kind === 'paste')) {
      return (
        <>
          {parts.map((part, index) => (part.kind === 'paste'
            ? (
              <UserMessageLargePasteCapsule
                key={`paste-${index}`}
                placeholder={part.placeholder}
                onOpen={largePaste.openLargePaste}
              />
            )
            : <UserMessageMcpTextContent key={`text-${index}`} text={part.text} />))}
        </>
      );
    }
  }
  return <UserMessageMcpTextContent text={text} />;
};

export const UserMessagePresentationContent: React.FC<{
  presentation: ComposerPresentation;
}> = ({ presentation }) => (
  <>
    {presentation.segments.map((segment, index) => {
      if (segment.kind === 'text') {
        return <UserMessageTextContent key={`text-${index}`} text={segment.text} />;
      }

      if (segment.kind === 'inline-token') {
        return (
          <MessageReferenceCapsule
            key={`token-${index}`}
            type={segment.tokenType}
            title={segment.label}
            label={segment.label}
          >{messageInlineTokenIcon(segment.tokenType)}</MessageReferenceCapsule>
        );
      }

      if (segment.context.type === 'conversation-excerpt') {
        return <ConversationExcerptPreview key={segment.context.id} excerpt={segment.context} origin="sent" />;
      }
      return (
        <MessageReferenceCapsule
          key={`context-${index}`}
          type={segment.context.type}
          title={segment.title}
          label={segment.label}
        />
      );
    })}
  </>
);
