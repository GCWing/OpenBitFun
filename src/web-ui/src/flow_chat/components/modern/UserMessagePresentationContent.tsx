import React from 'react';

import type { ComposerPresentation } from '../../utils/composerPresentation';
import { getMcpPromptReferenceMatches } from '../../utils/mcpPromptReference';
import { MessageReferenceCapsule } from './MessageReferenceCapsule';
import { messageInlineTokenIcon } from './messageReferenceIcons';
import { ConversationExcerptPreview } from '../../selection/ConversationExcerptAttachments';
import { Icon } from '@openbitfun/ui';

/** Render the persisted prompt format without requiring newer message metadata. */
export const UserMessageTextContent: React.FC<{ text: string }> = ({ text }) => {
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
