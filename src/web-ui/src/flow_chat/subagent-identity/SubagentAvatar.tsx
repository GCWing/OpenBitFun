import React, { useRef } from 'react';
import { useSubagentAvatarMotion } from '@openbitfun/ui/brand';
import type { SessionLineageLifecycle } from '../utils/sessionLineage';
import { getSubagentAvatarDefinition } from './catalog';
import { resolveSubagentAvatarPresentation } from './avatarResolver';
import './SubagentAvatar.scss';

// Only canonical, build-time artwork can enter the motion rig.
const motionSources = import.meta.glob<string>('../assets/subagent-avatars/robot-*.svg', {
  eager: true, query: '?raw', import: 'default',
});
const motionArtworks = new Map(Object.entries(motionSources).map(([path, source]) => [
  path,
  source.replace(/<title\b[^>]*>[\s\S]*?<\/title>/, '').replace(/\s(?:aria-labelledby|role)="[^"]*"/g, ''),
]));

export interface SubagentAvatarProps {
  sessionId?: string;
  name?: string;
  size?: number;
  status?: SessionLineageLifecycle;
  decorative?: boolean;
  motion?: boolean;
  showStatus?: boolean;
  className?: string;
}

export const SubagentAvatar: React.FC<SubagentAvatarProps> = ({
  sessionId,
  name,
  size = 28,
  status = 'idle',
  decorative = true,
  motion = false,
  showStatus = true,
  className = '',
}) => {
  const rootRef = useRef<HTMLSpanElement>(null);
  useSubagentAvatarMotion(rootRef, status, motion && Boolean(sessionId), sessionId);
  if (!sessionId) {
    return null;
  }

  const presentation = resolveSubagentAvatarPresentation(sessionId);
  const avatar = getSubagentAvatarDefinition(presentation.avatarId);
  const artwork = motionArtworks.get(`../assets/subagent-avatars/${presentation.avatarId}.svg`);
  const classes = [
    'subagent-avatar',
    `subagent-avatar--${status}`,
    motion && 'subagent-avatar--motion',
    className,
  ].filter(Boolean).join(' ');
  const accessibleName = name?.trim() ? `${name.trim()} avatar` : 'Subagent avatar';

  return (
    <span
      ref={rootRef}
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
      {motion && artwork ? <span key={presentation.avatarId} className="subagent-avatar__art" aria-hidden="true"
        data-subagent-motion-art="true" dangerouslySetInnerHTML={{ __html: artwork }} /> : <span className="subagent-avatar__art" aria-hidden="true">
        <img src={avatar.src} alt="" draggable={false} />
      </span>}
      {showStatus && <span className="subagent-avatar__status" aria-hidden="true" />}
    </span>
  );
};

SubagentAvatar.displayName = 'SubagentAvatar';
