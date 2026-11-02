import React from 'react';
import { useTranslation } from 'react-i18next';
import { FlowChatRuntimeStatus } from '@openbitfun/ui/flow-chat';
import { useRuntimeStatusStore } from '../../store/runtimeStatusStore';
import { submittedMessageStatusDelay } from '../../services/submittedMessagePresentation';
import './RuntimeStatusSlot.scss';

const EMPTY_HINTS: readonly string[] = [];
const FALLBACK_I18N_CACHE_OWNER = {};
const translatedHintsCache = new WeakMap<object, Map<string, readonly string[]>>();

// Status labels supplied by the runtime do not need the generated hint list;
// defer translation work until an unlabeled status is actually visible.
function getTranslatedHints(
  cacheOwner: object,
  t: (key: string, options?: Record<string, unknown>) => unknown,
  language: string,
  ready: boolean,
): readonly string[] {
  const cacheKey = `${language}:${ready ? 'ready' : 'loading'}`;
  let hintsByLanguage = translatedHintsCache.get(cacheOwner);
  if (!hintsByLanguage) {
    hintsByLanguage = new Map();
    translatedHintsCache.set(cacheOwner, hintsByLanguage);
  }

  const cachedHints = hintsByLanguage.get(cacheKey);
  if (cachedHints) return cachedHints;

  const rawHints = t('items', { returnObjects: true });
  const hints = Array.isArray(rawHints)
    ? rawHints.filter((item): item is string => typeof item === 'string')
    : EMPTY_HINTS;
  hintsByLanguage.set(cacheKey, hints);
  return hints;
}

interface RuntimeStatusSlotProps {
  sessionId?: string | null;
  placement?: 'footer' | 'inline';
  className?: string;
}

function stableHintIndex(seed: string, hintCount: number): number {
  if (hintCount === 0) return 0;
  const hash = seed.split('').reduce((value, character) => value + character.charCodeAt(0), 0);
  return Math.abs(hash) % hintCount;
}

export const RuntimeStatusSlot: React.FC<RuntimeStatusSlotProps> = ({
  sessionId,
  placement = 'inline',
  className = '',
}) => {
  const status = useRuntimeStatusStore(state => (
    sessionId ? state.bySessionId.get(sessionId) : undefined
  ));
  const { t, i18n, ready } = useTranslation('flow-chat/processing-hints');
  const needsGeneratedHint = Boolean(status && !status.label);
  const language = i18n?.resolvedLanguage ?? i18n?.language ?? 'default';
  const cacheOwner = i18n ?? FALLBACK_I18N_CACHE_OWNER;
  const hints = React.useMemo(
    () => needsGeneratedHint
      ? getTranslatedHints(cacheOwner, t, language, ready)
      : EMPTY_HINTS,
    [cacheOwner, language, needsGeneratedHint, ready, t],
  );
  const hint = status
    ? status.label
      || hints[stableHintIndex(`${status.turnId}:${status.roundId}`, hints.length)]
      || ''
    : '';
  const visible = Boolean(status && hint);
  const revealDelay = status && visible
    ? submittedMessageStatusDelay(status.sessionId, status.turnId)
    : 0;

  return <FlowChatRuntimeStatus
    label={hint}
    visible={visible}
    placement={placement}
    revealDelayMs={revealDelay}
    className={className}
  />;
};
