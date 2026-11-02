import React from 'react';
import { Icon } from '@openbitfun/ui';
import { AtSign, File } from 'lucide-react';
import type { ContextType } from '@/shared/types/context';

export function messageContextIcon(type: ContextType | string): React.ReactNode {
  switch (type) {
    case 'session-reference': return <Icon name="session" size="sm" aria-hidden />;
    case 'file':
    case 'image': return <Icon glyph={File} size="sm" aria-hidden />;
    case 'directory': return <Icon name="folder" size="sm" aria-hidden />;
    case 'code-snippet':
    case 'mermaid-node':
    case 'mermaid-diagram': return <Icon name="code" size="sm" aria-hidden />;
    case 'pull-request':
    case 'git-ref': return <Icon name="git" size="sm" aria-hidden />;
    case 'terminal-command': return <Icon name="terminal" size="sm" aria-hidden />;
    case 'url': return <Icon name="link" size="sm" aria-hidden />;
    default: return <Icon glyph={AtSign} size="sm" aria-hidden />;
  }
}

/**
 * Returns the icon used for composer inline tokens. Keeping this projection
 * shared means persisted Turn Rail previews render the same visual language as
 * the already-sent user message.
 */
export function messageInlineTokenIcon(tokenType: string): React.ReactNode {
  switch (tokenType) {
    case 'skill':
      return <Icon name="book-open" size="sm" aria-hidden />;
    case 'widget':
    default:
      return <Icon glyph={AtSign} size="sm" aria-hidden />;
  }
}
