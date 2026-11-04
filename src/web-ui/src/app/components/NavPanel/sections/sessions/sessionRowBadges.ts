import { i18nService } from '@/infrastructure/i18n';
import type { Session } from '@/flow_chat/types/flow-chat';

/** Short label of a child session's kind; shared by live and background rows. */
export const getChildSessionBadge = (kind: Session['sessionKind']): string => {
  const normalizedKind =
    kind === 'review' || kind === 'deep_review' || kind === 'subagent'
      ? kind
      : 'btw';
  const fallback = normalizedKind === 'deep_review'
    ? 'Strict'
    : normalizedKind === 'review'
      ? 'Review'
      : normalizedKind === 'subagent'
        ? 'Agent'
      : 'btw';
  return i18nService.t(`flow-chat:childSession.kinds.${normalizedKind}.short`, {
    defaultValue: fallback,
  });
};
