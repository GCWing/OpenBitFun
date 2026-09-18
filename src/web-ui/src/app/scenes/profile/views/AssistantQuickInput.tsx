/**
 * AssistantQuickInput — standalone input for the assistant detail page.
 *
 * Sends a message by:
 *   1. Creating a new session under the assistant workspace
 *   2. Sending the message as the first turn
 *   3. Navigating to the session scene
 *
 * Completely independent from the main ChatInput / FlowChat stores.
 */

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { OverflowText, Composer, ComposerToolbar, Icon, IconButton } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { ModelSelector } from '@/flow_chat/components/ModelSelector';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { useImeOwnedKeyGuard } from '@/flow_chat/hooks/useImeOwnedKeyGuard';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import './AssistantQuickInput.scss';

const log = createLogger('AssistantQuickInput');

interface AssistantQuickInputProps {
  workspacePath: string;
  workspaceId?: string;
  assistantName?: string;
}

const AssistantQuickInput: React.FC<AssistantQuickInputProps> = ({
  workspacePath,
  workspaceId,
  assistantName,
}) => {
  const { t } = useTranslation('flow-chat');
  const { setActiveWorkspace } = useWorkspaceContext();
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { isImeOwnedKey, handleCompositionStart, handleCompositionEnd } = useImeOwnedKeyGuard();

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
  }, []);

  const handleSend = useCallback(async () => {
    const text = value.trim();
    if (!text || sending || !workspaceId) return;

    setSending(true);
    try {
      // Switch to the assistant workspace first
      await setActiveWorkspace(workspaceId);

      // Create a new session owned by the assistant workspace ID; the path is
      // only the IO projection recorded on the session.
      const sessionId = await flowChatManager.createChatSession({ workspaceId, workspacePath });

      // Send the message
      await flowChatManager.sendMessage(text, sessionId);

      // Navigate to the session scene
      await openMainSession(sessionId, {
        workspaceId,
        activateWorkspace: workspaceId
          ? async (id: string) => { await setActiveWorkspace(id); }
          : undefined,
      });

      setValue('');
    } catch (err) {
      log.error('send quick message', err);
      notificationService.error(t('errors.sendFailed'));
    } finally {
      setSending(false);
    }
  }, [value, sending, workspacePath, workspaceId, setActiveWorkspace, t]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isImeOwnedKey(e)) return;
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend, isImeOwnedKey]);

  const placeholder = assistantName
    ? t('input.assistantPlaceholder', { name: assistantName })
    : t('input.placeholder');

  return (
    <div data-openbitfun-component="assistant-quick-input" data-openbitfun-part="root" className="aqi">
      <Composer
        aria-label={placeholder}
        className="aqi__composer"
        disabled={sending}
        toolbar={(
          <ComposerToolbar
            leading={(
              <div
                className="aqi__footer-left"
                data-openbitfun-component="assistant-quick-input"
                data-openbitfun-part="footerLeft"
              >
                <ModelSelector currentMode="Claw" className="aqi__model" />
                <OverflowText
                  className="aqi__hint"
                  data-openbitfun-component="assistant-quick-input"
                  data-openbitfun-part="hint"
                >
                  {t('input.sendHint')}
                </OverflowText>
              </div>
            )}
            trailing={(
              <IconButton
                type="button"
                variant="primary"
                size="sm"
                loading={sending}
                disabled={!value.trim() || sending}
                onClick={() => { void handleSend(); }}
                aria-label={t('actions.send')}
                className="aqi__send"
                icon={<Icon name="arrow-up" size="lg" />}
              />
            )}
          />
        )}
      >
        <textarea
          ref={textareaRef}
          className="aqi__editor"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          placeholder={placeholder}
          rows={1}
          disabled={sending}
        />
      </Composer>
    </div>
  );
};

export default AssistantQuickInput;
