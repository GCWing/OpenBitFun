import { Icon as CatalogIcon } from '@openbitfun/ui';
/**
 * TerminalScene — renders a ConnectedTerminal for the session selected
 * via terminalSceneStore.
 *
 * When no session is active, shows a minimal empty state prompting the
 * user that no terminal is currently open.
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useTerminalSceneStore } from '../../stores/terminalSceneStore';
import ConnectedTerminal from '../../../tools/terminal/components/ConnectedTerminal';
import './TerminalScene.scss';

interface TerminalSceneProps {
  isActive?: boolean;
}

const TerminalScene: React.FC<TerminalSceneProps> = ({ isActive = true }) => {
  const { activeSessionId, setActiveSession } = useTerminalSceneStore();
  const { t } = useTranslation('panels/terminal');

  const handleClose = useCallback(() => {
    setActiveSession(null);
  }, [setActiveSession]);

  // Keep the ConnectedTerminal mounted when the scene is inactive. Unmounting
  // would dispose xterm and force replay on return, which can lose scrollback
  // and cursor state after resize-sensitive shell output.
  return (
    <div
      className="openbitfun-terminal-scene"
      aria-hidden={!isActive}
      data-testid="shell-panel"
      data-openbitfun-scene="terminal"
      data-openbitfun-part="root"
      data-openbitfun-state={isActive ? undefined : 'inactive'}
    >
      {activeSessionId ? (
        <ConnectedTerminal
          key={activeSessionId}
          sessionId={activeSessionId}
          autoFocus={isActive}
          renderingActive={isActive}
          showToolbar
          showStatusBar
          onClose={handleClose}
          closeBehavior="detach"
        />
      ) : (
        <div className="openbitfun-terminal-scene__empty" data-testid="shell-command-list" data-openbitfun-scene="terminal" data-openbitfun-part="empty">
          <CatalogIcon name="terminal" size="lg" className="openbitfun-terminal-scene__empty-icon" style={{ width: 32, height: 32 }} />
          <p className="openbitfun-terminal-scene__empty-hint" data-testid="shell-panel-title">{t('emptyState')}</p>
        </div>
      )}
    </div>
  );
};

export default TerminalScene;
