import { useCallback } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import { formatDesignLabNumber } from '../i18n/core.mjs';
import { flowChatEn } from '../i18n/flowChatMessages';
import type { PresentationTranslate } from '@openbitfun/flow-chat-presentation/exec';

export function usePresentationTranslate(): PresentationTranslate {
  const { t } = useI18n();
  return (key, values) => {
    const messageKey = `flowChat.${key}`;
    if (!(messageKey in flowChatEn)) throw new Error(`Missing FlowChat preview translation: ${key}`);
    return t(messageKey as MessageKey, values as Record<string, string | number>);
  };
}

export function usePresentationFormatNumber() {
  const { locale } = useI18n();
  return useCallback((value: number) => formatDesignLabNumber(value, locale), [locale]);
}
