import { SubagentHatch } from '@openbitfun/ui/brand';
import { SubagentAvatar, type SubagentAvatarProps } from './SubagentAvatar';

interface SubagentDelegationAvatarProps extends Pick<SubagentAvatarProps, 'sessionId' | 'name' | 'size' | 'status' | 'motion' | 'showStatus'> {
  /** True only while the host is creating the child session, not while restoring history. */
  pending: boolean;
}

export function SubagentDelegationAvatar({ pending, size = 32, sessionId, motion = true, ...props }: SubagentDelegationAvatarProps) {
  return <SubagentHatch phase={sessionId ? 'ready' : pending ? 'incubating' : 'stopped'} size={size} active={motion}>
    {sessionId && <SubagentAvatar {...props} sessionId={sessionId} size={size} motion={motion} />}
  </SubagentHatch>;
}
