import {
  SUBAGENT_AVATAR_IDS,
  SUBAGENT_AVATAR_CATALOG_VERSION,
  type SubagentAvatarId,
} from './catalog';

export interface SubagentAvatarPresentation {
  avatarId: SubagentAvatarId;
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
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

  const hash = hashString(
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
