import React from 'react';
import type { SessionLineageLifecycle } from '../utils/sessionLineage';
import { getSubagentAvatarDefinition } from './catalog';
import { resolveSubagentAvatarPresentation } from './avatarResolver';
import './SubagentAvatar.scss';

export interface SubagentAvatarProps {
  sessionId?: string;
  name?: string;
  size?: number;
  status?: SessionLineageLifecycle;
  decorative?: boolean;
  className?: string;
}

export const SubagentAvatar: React.FC<SubagentAvatarProps> = ({
  sessionId,
  name,
  size = 28,
  status = 'idle',
  decorative = true,
  className = '',
}) => {
  if (!sessionId) {
    return null;
  }

  const presentation = resolveSubagentAvatarPresentation(sessionId);
  const avatar = getSubagentAvatarDefinition(presentation.avatarId);
  const classes = [
    'subagent-avatar',
    `subagent-avatar--${status}`,
    className,
  ].filter(Boolean).join(' ');
  const accessibleName = name?.trim() ? `${name.trim()} avatar` : 'Subagent avatar';

  return (
    <span
      className={classes}
      data-openbitfun-component="subagent-avatar"
      data-openbitfun-part="root"
      data-openbitfun-avatar-id={presentation.avatarId}
      data-openbitfun-state={status}
      style={{
        '--subagent-avatar-size': `${size}px`,
      } as React.CSSProperties}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? 'true' : undefined}
      aria-label={decorative ? undefined : accessibleName}
    >
      <span className="subagent-avatar__art" aria-hidden="true">
        <img src={avatar.src} alt="" draggable={false} />
      </span>
      <span className="subagent-avatar__status" aria-hidden="true" />
    </span>
  );
};

SubagentAvatar.displayName = 'SubagentAvatar';
