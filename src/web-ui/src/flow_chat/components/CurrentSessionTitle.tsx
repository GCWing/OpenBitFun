import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { flowChatStore } from '../store/FlowChatStore';
import { FlowChatState, Session } from '../types/flow-chat';
import { OverflowText, Tooltip, Icon } from '@openbitfun/ui';
import { i18nService } from '@/infrastructure/i18n';
import { resolveSessionTitle } from '../utils/sessionTitle';
import './CurrentSessionTitle.scss';

interface CurrentSessionTitleProps {
  onCreateSession?: () => void;
}

/**
 * Current session title component.
 * Renders the active session name in the header.
 */
const CurrentSessionTitle: React.FC<CurrentSessionTitleProps> = ({ onCreateSession }) => {
  const { t } = useTranslation('flow-chat');
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() => 
    flowChatStore.getState()
  );
  // Subscribe to FlowChatStore updates to keep the title in sync.
  useEffect(() => {
    const unsubscribe = flowChatStore.subscribe((state) => {
      setFlowChatState(state);
    });
    return () => unsubscribe();
  }, []);

  const activeSession: Session | undefined = flowChatState.activeSessionId 
    ? flowChatState.sessions.get(flowChatState.activeSessionId)
    : undefined;

  const getSessionTitle = (session: Session | undefined): string => {
    if (!session) {
      return t('session.noSession');
    }
    return resolveSessionTitle(session, (key, options) => i18nService.t(key, options));
  };

  const title = getSessionTitle(activeSession);

  const handleCreateSession = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onCreateSession) {
      onCreateSession();
    }
  };

  const newSessionLabel = t('session.newCode');

  return (
    <div data-openbitfun-component="current-session-title" data-openbitfun-part="root" className="openbitfun-current-session-title">
      <OverflowText data-openbitfun-component="current-session-title" data-openbitfun-part="title" className="openbitfun-current-session-title__text">{title}</OverflowText>
      <Tooltip content={newSessionLabel} placement="bottom">
        <button
          data-openbitfun-component="current-session-title"
          data-openbitfun-part="create"
          className="openbitfun-current-session-title__create-btn"
          onClick={handleCreateSession}
          aria-label={newSessionLabel}
        >
          <Icon name="plus" size="md" />
        </button>
      </Tooltip>
    </div>
  );
};

export default CurrentSessionTitle;
export { CurrentSessionTitle };
