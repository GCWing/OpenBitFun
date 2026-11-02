import {
  SUBAGENT_AVATAR_IDS,
  SUBAGENT_AVATAR_CATALOG_VERSION,
  type SubagentAvatarId,
} from './catalog';
import { hashSubagentIdentity } from './identityHash';
import { APPEARANCE_DOMAIN_TOKENS } from '@/infrastructure/appearance/appearanceDomainTokens';

export interface SubagentAvatarPresentation {
  avatarId: SubagentAvatarId;
}

/**
 * Resolve the Web UI avatar directly from the stable subagent session ID.
 *
 * The mapping deliberately does not depend on lineage hydration, active state,
 * allocation order, or persisted frontend state. Avatar collisions are allowed.
 */
export function resolveSubagentAvatarId(sessionId: string): SubagentAvatarId {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return SUBAGENT_AVATAR_IDS[0];
  }

  const hash = hashSubagentIdentity(
    `${SUBAGENT_AVATAR_CATALOG_VERSION}:avatar:${normalizedSessionId}`,
  );
  return SUBAGENT_AVATAR_IDS[hash % SUBAGENT_AVATAR_IDS.length];
}

export function resolveSubagentAvatarPresentation(
  sessionId: string,
): SubagentAvatarPresentation {
  return {
    avatarId: resolveSubagentAvatarId(sessionId),
  };
}

export function resolveSubagentAvatarAccent(sessionId: string): string {
  return APPEARANCE_DOMAIN_TOKENS.subagentAvatar(resolveSubagentAvatarId(sessionId));
}
