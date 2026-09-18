import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { gitService } from '@/tools/git/services/GitService';
import { createLogger } from '@/shared/utils/logger';
import './ChatEmptyState.scss';

const log = createLogger('ChatEmptyState');

/**
 * Chat empty state component
 * Displays current workspace, branch info, and prompts user to interact via AI chat
 */
export const ChatEmptyState: React.FC = () => {
  const { t } = useTranslation('flow-chat');
  const { workspace: currentWorkspace } = useCurrentWorkspace();
  const [currentBranch, setCurrentBranch] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadGitInfo = async () => {
      if (!currentWorkspace?.rootPath) {
        setLoading(false);
        return;
      }

      try {
        const status = await gitService.getStatus({ workspaceId: currentWorkspace.id });
        if (status) {
          setCurrentBranch(status.current_branch || '');
        }
      } catch (error) {
        log.debug('Failed to get Git info', error);
      } finally {
        setLoading(false);
      }
    };

    loadGitInfo();
  }, [currentWorkspace]);

  return (
    <div data-openbitfun-component="chat-empty-state" data-openbitfun-part="root" data-openbitfun-state={loading ? 'loading' : ''} className="fc-chat-empty">
      <div data-openbitfun-component="chat-empty-state" data-openbitfun-part="container" className="fc-chat-empty__container">
        {!loading && currentWorkspace && (
          <>
            <div data-openbitfun-component="chat-empty-state" data-openbitfun-part="greeting" className="fc-chat-empty__greeting">
              <p>{t('emptyState.welcomeBack')}</p>
              <p>
                {currentBranch ? (
                  <Trans
                    i18nKey="emptyState.workingInWithBranch"
                    t={t}
                    values={{ workspace: currentWorkspace.name, branch: currentBranch }}
                    components={{
                      workspace: <span className="fc-chat-empty__workspace-name" />,
                      branch: <span className="fc-chat-empty__branch-name" />
                    }}
                  />
                ) : (
                  <Trans
                    i18nKey="emptyState.workingIn"
                    t={t}
                    values={{ workspace: currentWorkspace.name }}
                    components={{
                      workspace: <span className="fc-chat-empty__workspace-name" />
                    }}
                  />
                )}
              </p>
            </div>

            <div data-openbitfun-component="chat-empty-state" data-openbitfun-part="divider" className="fc-chat-empty__divider" />

            <div data-openbitfun-component="chat-empty-state" data-openbitfun-part="prompt" className="fc-chat-empty__prompt">
              <p>{t('emptyState.capabilities')}</p>
              <p>{t('emptyState.capabilities2')}</p>
              <p className="fc-chat-empty__prompt-hint">{t('emptyState.readyToHelp')}</p>
            </div>
          </>
        )}

        {!loading && !currentWorkspace && (
          <div data-openbitfun-component="chat-empty-state" data-openbitfun-part="noWorkspace" className="fc-chat-empty__no-workspace">
            <p>{t('emptyState.noWorkspace')}</p>
            <p className="fc-chat-empty__hint">{t('emptyState.openProject')}</p>
          </div>
        )}
      </div>
    </div>
  );
};

