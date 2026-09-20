/**
 * Welcome panel shown in the empty chat state.
 * Layout mirrors WelcomeScene: centered container, left-aligned content.
 */

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, FolderPlus } from 'lucide-react';
import { subscribeOverlayInteraction, createOverlayPortal, Button, Menu, MenuItem, MenuSeparator, Icon, PageHeader } from '@openbitfun/ui';
import { useApp } from '../../app/hooks/useApp';
import { createLogger } from '@/shared/utils/logger';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import type { WorkspaceInfo } from '@/shared/types';
import CoworkExampleCards from './CoworkExampleCards';
import { useAgentIdentityDocument } from '@/app/scenes/my-agent/useAgentIdentityDocument';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { useGitState } from '@/tools/git/hooks/useGitState';
import './WelcomePanel.css';
import './WelcomePanelSurface.scss';

const log = createLogger('WelcomePanel');

interface WelcomePanelProps {
  onQuickAction?: (command: string) => void;
  className?: string;
  sessionMode?: string;
  /** Owning workspace ID of the session being welcomed; selects the assistant identity document. */
  workspaceId?: string;
  workspacePath?: string;
}

export const WelcomePanel: React.FC<WelcomePanelProps> = ({
  onQuickAction,
  className = '',
  sessionMode,
  workspaceId,
  workspacePath = '',
}) => {
  const { t } = useTranslation('flow-chat');
  const { t: tCommon } = useTranslation('common');
  const [workspaceDropdownOpen, setWorkspaceDropdownOpen] = useState(false);
  const [isSelectingWorkspace, setIsSelectingWorkspace] = useState(false);
  const workspaceDropdownRef = useRef<HTMLDivElement>(null);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);

  const { switchLeftPanelTab } = useApp();
  const {
    hasWorkspace,
    currentWorkspace,
    openedWorkspacesList,
    openWorkspace,
    switchWorkspace,
  } = useWorkspaceContext();
  const sessionModeLower = (sessionMode || '').toLowerCase();
  const isCoworkSession = sessionModeLower === 'cowork';
  const isClawSession = sessionModeLower === 'claw';

  // Subscribe to shared Git state so the welcome panel stays in sync with
  // branch / worktree changes (including external ones picked up by the
  // GitStateManager poll). When there is no workspace or we are in a
  // cowork/claw session we pass a blank scope so the hook stays idle.
  const activeWsId = !isCoworkSession && !isClawSession ? currentWorkspace?.id : undefined;
  const gitScope = activeWsId ? { workspaceId: activeWsId } : { workspaceId: '' };
  const {
    isRepository,
    currentBranch,
    ahead,
    staged,
    unstaged,
    untracked,
  } = useGitState({
    repositoryPath: gitScope,
    layers: ['basic', 'status'],
    isActive: !!activeWsId,
    refreshOnMount: !!activeWsId,
    refreshOnActive: true,
    participateInWindowFocusRefresh: true,
    debugSource: 'welcome_panel',
  });

  // Derive the same shape the old loadGitState produced so the render and
  // narrative helpers below do not have to change.
  const gitState = useMemo(() => {
    if (!isRepository || !currentBranch) return null;
    return {
      currentBranch,
      unstagedFiles: (unstaged?.length || 0) + (untracked?.length || 0),
      stagedFiles: staged?.length || 0,
      unpushedCommits: ahead || 0,
    };
  }, [isRepository, currentBranch, ahead, staged, unstaged, untracked]);

  const identityWorkspace = useMemo(
    () => (isClawSession && workspaceId ? { id: workspaceId, rootPath: workspacePath } : null),
    [isClawSession, workspaceId, workspacePath],
  );
  const { document: identityDoc } = useAgentIdentityDocument(identityWorkspace);
  const assistantName = isClawSession ? (identityDoc.name || '') : '';

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    const s = isCoworkSession ? 'Cowork' : isClawSession ? 'Claw' : '';
    if (hour >= 5 && hour < 12) return {
      title: s ? t('welcome.greetingMorning') : t('welcome.openingMorning'),
      subtitle: s ? t(`welcome.subtitleMorning${s}`) : undefined,
    };
    if (hour >= 12 && hour < 18) return {
      title: s ? t('welcome.greetingAfternoon') : t('welcome.openingAfternoon'),
      subtitle: s ? t(`welcome.subtitleAfternoon${s}`) : undefined,
    };
    if (hour >= 18 && hour < 23) return {
      title: s ? t('welcome.greetingEvening') : t('welcome.openingEvening'),
      subtitle: s ? t(`welcome.subtitleEvening${s}`) : undefined,
    };
    return {
      title: s ? t('welcome.greetingNight') : t('welcome.openingNight'),
      subtitle: s ? t(`welcome.subtitleNight${s}`) : undefined,
    };
  }, [t, isCoworkSession, isClawSession]);

  const aiPartnerKey = isCoworkSession ? 'welcome.aiPartnerCowork' : isClawSession ? 'welcome.aiPartnerClaw' : null;

  const otherWorkspaces = useMemo(
    () => openedWorkspacesList.filter(ws => ws.id !== currentWorkspace?.id),
    [openedWorkspacesList, currentWorkspace?.id],
  );
  const workspaceMenuLayout = useAnchoredPopoverPosition({
    open: workspaceDropdownOpen,
    anchorRef: workspaceTriggerRef,
    popoverRef: workspaceMenuRef,
    preferredPlacement: 'bottom',
    alignment: 'start',
    gap: 4,
    layoutRevision: otherWorkspaces.length,
  });

  const handleGitClick = useCallback(() => {
    switchLeftPanelTab('git');
  }, [switchLeftPanelTab]);

  const isGitClean = useMemo(
    () => !!gitState && gitState.unstagedFiles === 0 && gitState.stagedFiles === 0 && gitState.unpushedCommits === 0,
    [gitState],
  );

  const buildGitNarrative = useCallback((): React.ReactNode => {
    if (!gitState) return null;
    const parts: { key: string; label: string; suffix: string }[] = [];
    if (gitState.unstagedFiles > 0)
      parts.push({ key: 'unstaged', label: t('welcome.gitUnstaged', { count: gitState.unstagedFiles }), suffix: t('welcome.waitingToStage') });
    if (gitState.stagedFiles > 0)
      parts.push({ key: 'staged', label: t('welcome.gitStaged', { count: gitState.stagedFiles }), suffix: t('welcome.stagedReady') });
    if (gitState.unpushedCommits > 0)
      parts.push({ key: 'unpushed', label: t('welcome.gitUnpushed', { count: gitState.unpushedCommits }), suffix: t('welcome.toPush') });
    if (parts.length === 0) return null;
    return (
      <>
        {t('welcome.currentlyHas')}
        {parts.map(({ key, label, suffix }, i) => (
          <React.Fragment key={key}>
            {i > 0 && t('welcome.commaSeparator')}
            <Button labelBehavior="static" variant="text"
              type="button"
              data-openbitfun-product-component="welcome-panel"
              data-openbitfun-product-part="gitAction"
              className="welcome-panel__inline-btn"
              onClick={handleGitClick}
            >
              {label}
            </Button>
            {' '}{suffix}
          </React.Fragment>
        ))}
        {t('welcome.period')}
      </>
    );
  }, [gitState, handleGitClick, t]);

  useEffect(() => {
    if (!workspaceDropdownOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        workspaceDropdownRef.current &&
        !workspaceDropdownRef.current.contains(target) &&
        !workspaceMenuRef.current?.contains(target)
      ) {
        setWorkspaceDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setWorkspaceDropdownOpen(false);
      workspaceTriggerRef.current?.focus();
    };
    const removeOverlayMousedown0 = subscribeOverlayInteraction(workspaceMenuRef, 'mousedown', handlePointerDown);
    const removeOverlayKeydown1 = subscribeOverlayInteraction(workspaceMenuRef, 'keydown', handleKeyDown);
    return () => {
      removeOverlayMousedown0?.();
      removeOverlayKeydown1?.();
    };
  }, [workspaceDropdownOpen]);

  const handleSwitchWorkspace = useCallback(async (ws: WorkspaceInfo) => {
    try { setWorkspaceDropdownOpen(false); await switchWorkspace(ws); }
    catch (err) { log.warn('Failed to switch workspace', err); }
  }, [switchWorkspace]);

  const handleOpenOtherFolder = useCallback(async () => {
    try {
      setWorkspaceDropdownOpen(false);
      setIsSelectingWorkspace(true);
      const { pickWorkspaceDirectory } = await import(
        '@/infrastructure/peer-device/pickWorkspaceDirectory'
      );
      const selected = await pickWorkspaceDirectory({
        title: tCommon('header.selectProjectDirectory'),
      });
      if (selected) await openWorkspace(selected);
    } catch (err) {
      log.warn('Failed to open workspace folder', err);
    } finally {
      setIsSelectingWorkspace(false);
    }
  }, [openWorkspace, tCommon]);

  const handleCreateWorkspace = useCallback(() => {
    setWorkspaceDropdownOpen(false);
    window.dispatchEvent(new Event('nav:new-project'));
  }, []);

  const handleQuickActionClick = useCallback((cmd: string) => {
    onQuickAction?.(cmd);
  }, [onQuickAction]);

  return (
    <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="root" className={`welcome-panel ${className}`}>
      <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="content" className="welcome-panel__content">
        {/* Greeting */}
        <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="greeting" className="welcome-panel__greeting">
          <PageHeader
            size="display"
            title={<span data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="heading">
              {greeting.title}
              {aiPartnerKey && <>，{t(aiPartnerKey)}{isClawSession && assistantName ? `，${assistantName}` : ''}</>}
            </span>}
            description={greeting.subtitle ? (
              <span data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="tagline">{greeting.subtitle}</span>
            ) : undefined}
          />
        </div>

        <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="divider" className="welcome-panel__divider" />

        {/* Narrative: workspace + git in natural language */}
        <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="narrative" className="welcome-panel__narrative">
          <p className="welcome-panel__narrative-text">
            {isClawSession ? (
              t('welcome.narrativeClaw')
            ) : !hasWorkspace ? (
              <>
                {t('welcome.noWorkspaceHint')}
                <Button labelBehavior="static" variant="text"
                  type="button"
                  data-openbitfun-product-component="welcome-panel"
                  data-openbitfun-product-part="openWorkspaceAction"
                  className="welcome-panel__inline-btn welcome-panel__inline-btn--interactive"
                  onClick={() => { void handleOpenOtherFolder(); }}
                  disabled={isSelectingWorkspace}
                >
                  {t('welcome.openOne')}
                </Button>
                {' '}{t('welcome.toStart')}
              </>
            ) : (
              <>
                <span className="welcome-panel__narrative-sentence">
                  <span className="welcome-panel__narrative-sentence__text">
                    {isCoworkSession ? t('welcome.workingInCowork') : t('welcome.workingIn')}
                  </span>
                  <span className="welcome-panel__context-row">
                    <span className="welcome-panel__workspace-anchor" ref={workspaceDropdownRef}>
                      <Button
                        labelBehavior="static"
                        variant="text"
                        leadingIcon={<FolderOpen size={13} className="welcome-panel__inline-icon" />}
                        trailingIcon={
                          <Icon
                            name="chevron-down"
                            size="lg"
                            style={{ width: 11, height: 11 }}
                            className={`welcome-panel__inline-chevron${workspaceDropdownOpen ? ' welcome-panel__inline-chevron--open' : ''}`}
                          />
                        }
                        ref={workspaceTriggerRef}
                        type="button"
                        data-openbitfun-product-component="welcome-panel"
                        data-openbitfun-product-part="workspaceAction"
                        data-openbitfun-state={workspaceDropdownOpen ? 'open' : undefined}
                        className={`welcome-panel__inline-btn welcome-panel__inline-btn--interactive${workspaceDropdownOpen ? ' welcome-panel__inline-btn--active' : ''}`}
                        onClick={() => setWorkspaceDropdownOpen(v => !v)}
                        disabled={isSelectingWorkspace}
                        title={currentWorkspace?.rootPath}
                        aria-haspopup="menu"
                        aria-expanded={workspaceDropdownOpen}
                      >
                        {currentWorkspace?.name || t('shared:features.workspace')}
                      </Button>
                      {workspaceDropdownOpen && createOverlayPortal(
                        <Menu
                          ref={workspaceMenuRef}
                          data-openbitfun-product-component="welcome-panel"
                          data-openbitfun-product-part="workspaceMenu"
                          data-openbitfun-placement={workspaceMenuLayout?.placement ?? 'bottom'}
                          className="welcome-panel__dropdown"
                          style={{
                            top: `${workspaceMenuLayout?.top ?? 0}px`,
                            left: `${workspaceMenuLayout?.left ?? 0}px`,
                            visibility: workspaceMenuLayout ? 'visible' : 'hidden',
                          }}
                          autoFocusFirstItem
                          aria-label={t('shared:features.workspace')}
                        >
                          <MenuItem
                            data-openbitfun-product-component="welcome-panel"
                            data-openbitfun-product-part="workspaceItem"
                            leading={<FolderPlus size={12} />}
                            onClick={() => { void handleCreateWorkspace(); }}
                          >
                            {tCommon('header.newProject')}
                          </MenuItem>
                          {(hasWorkspace || otherWorkspaces.length > 0) && <MenuSeparator />}
                          {hasWorkspace && currentWorkspace && (
                            <MenuItem
                              role="menuitemradio"
                              checked
                              aria-disabled="true"
                              leading={<FolderOpen size={12} />}
                              metadata={<Icon name="check-line" size="lg" style={{ width: 11, height: 11 }} />}
                            >
                              {currentWorkspace.name}
                            </MenuItem>
                          )}
                          {otherWorkspaces.length > 0 && (
                            <>
                              {hasWorkspace && currentWorkspace && <MenuSeparator />}
                              {otherWorkspaces.map(ws => (
                                <MenuItem
                                  key={ws.id}
                                  data-openbitfun-product-component="welcome-panel"
                                  data-openbitfun-product-part="workspaceItem"
                                  leading={<FolderOpen size={12} />}
                                  onClick={() => { void handleSwitchWorkspace(ws); }}
                                  title={ws.rootPath}
                                >
                                  {ws.name}
                                </MenuItem>
                              ))}
                            </>
                          )}
                        </Menu>,
                        getAppearanceOverlayHost(),
                      )}
                    </span>
                    {!isCoworkSession && gitState && (
                      <>
                        <span className="welcome-panel__context-sep">/</span>
                        <Button
                          labelBehavior="static"
                          variant="text"
                          leadingIcon={<Icon name="git" size="lg" style={{ width: 13, height: 13 }} className="welcome-panel__inline-icon" />}
                          type="button"
                          data-openbitfun-product-component="welcome-panel"
                          data-openbitfun-product-part="gitAction"
                          className="welcome-panel__inline-btn"
                          onClick={handleGitClick}
                        >
                          {gitState.currentBranch}
                        </Button>
                      </>
                    )}
                  </span>
                  <span className="welcome-panel__narrative-sentence__text">
                    {!isCoworkSession && gitState ? t('welcome.project') : t('welcome.projectCowork')}
                  </span>
                </span>
                {!isCoworkSession && gitState ? (
                  <span className="welcome-panel__narrative-git">
                    {isGitClean
                      ? <span className="welcome-panel__narrative-clean">{t('welcome.gitClean')}</span>
                      : buildGitNarrative()}
                  </span>
                ) : null}
              </>
            )}
          </p>
        </div>

        {/* Cowork examples */}
        {isCoworkSession && (
          <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="cowork" className="welcome-panel__cowork">
            <CoworkExampleCards resetKey={0} onSelectPrompt={p => handleQuickActionClick(p)} />
          </div>
        )}
      </div>
    </div>
  );
};

export default WelcomePanel;
