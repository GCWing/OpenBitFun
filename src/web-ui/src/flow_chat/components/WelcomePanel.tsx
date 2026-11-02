/**
 * Welcome panel shown in the empty chat state.
 * The heading is centered above the floating composer; supporting content follows below.
 */

import React, { useState, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Button, Icon, MenuPopover, PageHeader, type MenuEntry } from '@openbitfun/ui';
import { createLogger } from '@/shared/utils/logger';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import { agentName, canonicalHarnessId, HARNESS_IDS, type HarnessId } from '@/shared/agents/identity';
import { HARNESS_PRESENTATION } from '@/shared/agents/harnessPresentation';
import { notificationService } from '@/shared/notification-system';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import CoworkExampleCards from './CoworkExampleCards';
import { AssistantAvatar } from '@/app/components/AssistantAvatar';
import { useAgentIdentityDocument } from '@/app/scenes/my-agent/useAgentIdentityDocument';
import { flowChatSessionConfigForWorkspace } from '@/app/utils/projectSessionWorkspace';
import { useSessionWorkspaceSelection } from '../hooks/useSessionWorkspaceSelection';
import { useSessionModeSelection } from '../hooks/useSessionModeSelection';
import { FlowChatStore } from '../store/FlowChatStore';
import { chatInputModePreferenceService } from '../services/ChatInputModePreferenceService';
import { FlowChatManager } from '../services/FlowChatManager';
import { resolveChatInputExecutionLevelPolicy } from '../utils/chatInputExecutionLevelPolicy';
import { isSessionBindingLocked } from '../utils/sessionLifecycle';
import { acpAgentTypeFromSession } from '../utils/acpSession';
import { sessionProjectWorkspacePath } from '../utils/sessionWorkspace';
import type { Session } from '../types/flow-chat';
import { useChatInputState } from '../store/chatInputStateStore';
import { computeFlowChatInputOverlayInsetPx } from '../utils/flowChatScrollLayout';
import './WelcomePanel.css';

const log = createLogger('WelcomePanel');

/** Keep all four marks mounted so interrupted expansion and selection reverse smoothly. */
export function WelcomeModeSelector({ profile, disabled, pending, onSelect, onExpandedChange }: {
  profile: HarnessId;
  disabled: boolean;
  pending: boolean;
  onSelect: (profile: HarnessId) => void;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const { t } = useTranslation('flow-chat');
  const [expanded, setExpanded] = useState(false);
  const [focusProfile, setFocusProfile] = useState<HarnessId | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<Partial<Record<HarnessId, HTMLButtonElement | null>>>({});
  const choicesId = useId();
  const name = (id: HarnessId) => agentName({ id, name: id }, t);

  useLayoutEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  useEffect(() => {
    setExpanded(false);
    if (containerRef.current?.contains(document.activeElement)) {
      buttonsRef.current[profile]?.focus();
    }
  }, [profile, disabled]);

  useEffect(() => {
    if (expanded && focusProfile) buttonsRef.current[focusProfile]?.focus();
  }, [expanded, focusProfile]);

  useEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [expanded]);

  return (
    <div
      ref={containerRef}
      id={choicesId}
      role="group"
      aria-label={t('chatInput.harness.selectorTooltip', { name: name(profile) })}
      aria-busy={pending}
      className="welcome-panel__mode-choices"
      data-openbitfun-product-component="welcome-panel"
      data-openbitfun-product-part="modeChoices"
      data-openbitfun-state={expanded ? 'open' : undefined}
      data-expanded={expanded}
      data-motion="welcome-mode-expansion"
      onBlur={event => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false);
        }
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(false);
          buttonsRef.current[profile]?.focus();
          return;
        }
        if (disabled || pending) return;
        const focusedIndex = HARNESS_IDS.findIndex(id => buttonsRef.current[id] === document.activeElement);
        const index = focusedIndex < 0 ? HARNESS_IDS.indexOf(profile) : focusedIndex;
        let target: HarnessId | undefined;
        if (event.key === 'ArrowRight') target = HARNESS_IDS[(index + 1) % HARNESS_IDS.length];
        if (event.key === 'ArrowLeft') target = HARNESS_IDS[(index + HARNESS_IDS.length - 1) % HARNESS_IDS.length];
        if (event.key === 'Home') target = HARNESS_IDS[0];
        if (event.key === 'End') target = HARNESS_IDS[HARNESS_IDS.length - 1];
        if (target) {
          event.preventDefault();
          setExpanded(true);
          setFocusProfile(target);
        }
      }}
    >
      {HARNESS_IDS.map(id => {
        const current = profile === id;
        return (
          <div key={id} className="welcome-panel__mode-slot" data-current={current}
            aria-hidden={!expanded && !current}>
            <button
              ref={element => { buttonsRef.current[id] = element; }}
              type="button"
              className="welcome-panel__mode-option"
              data-openbitfun-product-component="welcome-panel"
              data-openbitfun-product-part="modeOption"
              data-harness-profile={id}
              aria-label={name(id)}
              aria-pressed={current}
              aria-expanded={current ? expanded : undefined}
              aria-controls={current ? choicesId : undefined}
              tabIndex={expanded || current ? 0 : -1}
              disabled={disabled || pending || (!expanded && !current)}
              onClick={() => {
                if (!expanded) {
                  setExpanded(true);
                  setFocusProfile(profile);
                } else if (current) {
                  setExpanded(false);
                } else {
                  onSelect(id);
                }
              }}
            >
              <span className="welcome-panel__mode-mark"
                data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="modeIcon"
                data-harness-profile={id} aria-hidden>
                <Icon name={HARNESS_PRESENTATION[id].icon} size="lg" />
              </span>
              <span className="welcome-panel__mode-name"
                data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="modeName">
                {name(id)}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface WelcomePanelProps {
  onQuickAction?: (command: string) => void;
  className?: string;
  session?: Session | null;
  sessionMode?: string;
  /** Owning workspace ID of the session being welcomed; selects the assistant identity document. */
  workspaceId?: string;
  workspacePath?: string;
}

export const WelcomePanel: React.FC<WelcomePanelProps> = ({
  onQuickAction,
  className = '',
  session,
  sessionMode: initialSessionMode,
  workspaceId: initialWorkspaceId,
  workspacePath: initialWorkspacePath = '',
}) => {
  const { t } = useTranslation('flow-chat');
  const { t: tCommon } = useTranslation('common');
  const inputHeight = useChatInputState(state => state.inputHeight);
  const inputOverlayInsetPx = computeFlowChatInputOverlayInsetPx(inputHeight);
  const [isSelectingWorkspace, setIsSelectingWorkspace] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [modeSelectorExpanded, setModeSelectorExpanded] = useState(false);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const captionContentRef = useRef<HTMLDivElement>(null);

  const {
    hasWorkspace: hasActiveWorkspace,
    currentWorkspace,
    openedWorkspaces,
    openWorkspace,
    switchWorkspace,
  } = useWorkspaceContext();
  const { selectedWorkspace, workspaceControl } = useSessionWorkspaceSelection(session);
  const workspace = session ? selectedWorkspace
    : initialWorkspaceId ? openedWorkspaces.get(initialWorkspaceId) : currentWorkspace;
  const workspaceId = session ? workspaceControl.selectedId : initialWorkspaceId ?? workspace?.id;
  const workspacePath = session?.draft ? selectedWorkspace?.rootPath ?? ''
    : session?.workspacePath ?? initialWorkspacePath;
  const hasWorkspace = session ? Boolean(workspaceId) : hasActiveWorkspace;
  const sessionMode = session?.mode ?? session?.config.agentType ?? initialSessionMode;
  const sessionModeLower = (sessionMode || '').toLowerCase();
  const isCoworkSession = sessionModeLower === 'cowork';
  const isClawSession = sessionModeLower === 'claw';
  const harnessProfile = canonicalHarnessId(sessionMode || 'Standard');
  const isModeExpanded = Boolean(harnessProfile && modeSelectorExpanded);
  const workspaceName = hasWorkspace ? workspace?.name.trim() : undefined;
  const showWorkspaceHeading = !isCoworkSession && !isClawSession && Boolean(workspaceName);
  const canSelectWorkspace = !isSelectingWorkspace && (!session?.draft || session.draft.phase === 'editing');
  const surface = getActiveSurfaceScope();
  const executionPolicy = resolveChatInputExecutionLevelPolicy({
    isAssistantWorkspace: workspace?.workspaceKind === WorkspaceKind.Assistant,
    sessionMode,
    isAcpTargetSession: Boolean(acpAgentTypeFromSession(session)),
    isSubagentInputTarget: Boolean(session?.parentSessionId || session?.isTransient),
  });
  const canSelectMode = Boolean(session && harnessProfile && executionPolicy.userConfigurable
    && !isSessionBindingLocked(session)
    && (!session.draft || session.draft.phase === 'editing')
    && !session.config.dispatchTarget && !session.config.dispatchJobId);
  const publishMode = useCallback((modeId: string) => {
    if (surface.isCurrent() && session) {
      FlowChatStore.getInstance().updateSessionMode(session.sessionId, modeId);
    }
  }, [session, surface]);
  const reportModeFailure = useCallback((error: unknown) => {
    if (!surface.isCurrent()) return;
    log.warn('Failed to change welcome session mode', error);
    notificationService.error(t('chatInput.modeChangeFailed'));
  }, [surface, t]);
  const rememberMode = useCallback((modeId: string) => {
    if (!surface.isCurrent()) return;
    void chatInputModePreferenceService.rememberMode(modeId).catch(error => {
      if (!surface.isCurrent()) return;
      log.warn('Failed to remember welcome session mode', error);
      notificationService.warning(t('chatInput.harness.rememberFailed'));
    });
  }, [surface, t]);
  const { requestModeChange, isModeChangePending } = useSessionModeSelection(session ? {
    sessionId: session.sessionId,
    draft: Boolean(session.draft),
    workspacePath: sessionProjectWorkspacePath(session),
    remoteConnectionId: session.remoteConnectionId ?? session.config.remoteConnectionId,
    remoteSshHost: session.remoteSshHost ?? session.config.remoteSshHost,
  } : null, publishMode, reportModeFailure, rememberMode);
  const handleSelectMode = useCallback((profile: HarnessId) => {
    if (!canSelectMode || !surface.isCurrent()) return;
    const live = session && FlowChatStore.getInstance().getState().sessions.get(session.sessionId);
    if (!live || isSessionBindingLocked(live) || (live.draft && live.draft.phase !== 'editing')) return;
    requestModeChange(profile);
  }, [canSelectMode, surface, session, requestModeChange]);

  useEffect(() => {
    setWorkspaceMenuOpen(false);
  }, [session?.sessionId, workspaceId, canSelectWorkspace, isModeExpanded]);

  const handleSelectWorkspace = useCallback(async (target: WorkspaceInfo) => {
    setWorkspaceMenuOpen(false);
    if (!surface.isCurrent() || !canSelectWorkspace || target.id === workspaceId) return;
    if (session && !workspaceControl.locked) {
      workspaceControl.onSelect(target.id);
      return;
    }
    setIsSelectingWorkspace(true);
    try {
      if (session) {
        // A persisted session keeps its owner. Enter the selected workspace
        // through the same fresh-draft/navigation path as the sidebar.
        const nextSessionId = await FlowChatManager.getInstance().createChatDraft(
          flowChatSessionConfigForWorkspace(target), harnessProfile ?? undefined,
        );
        surface.assertCurrent('open selected workspace conversation');
        const { openMainSession } = await import('../services/sessionActivation');
        surface.assertCurrent('navigate selected workspace conversation');
        await openMainSession(nextSessionId, {
          workspaceId: target.id,
          activateWorkspace: () => switchWorkspace(target),
          isCurrent: () => surface.isCurrent(),
        });
      } else {
        await switchWorkspace(target);
      }
    } catch (error) {
      if (!surface.isCurrent()) return;
      log.warn('Failed to switch workspace', error);
      notificationService.error(t('workspaceStrip.unavailable'));
    } finally {
      if (surface.isCurrent()) setIsSelectingWorkspace(false);
    }
  }, [session, workspaceControl, switchWorkspace, t, surface, canSelectWorkspace, workspaceId, harnessProfile]);

  const workspaceMenuItems = useMemo<MenuEntry[]>(() => {
    const options = session ? workspaceControl.options : [...openedWorkspaces.values()]
      .filter(item => item.workspaceKind !== WorkspaceKind.Assistant);
    return [
      ...options.map(target => ({
        id: target.id,
        label: target.name,
        role: 'menuitemradio' as const,
        checked: target.id === workspaceId,
        onSelect: () => { void handleSelectWorkspace(target); },
      })),
      { id: 'separator', label: '', separator: true },
      {
        id: 'open-other-project',
        label: t('welcome.openOtherProject'),
        onSelect: () => {
          setWorkspaceMenuOpen(false);
          window.dispatchEvent(new Event('nav:new-project'));
        },
      },
    ];
  }, [session, workspaceControl.options, openedWorkspaces, workspaceId, handleSelectWorkspace, t]);

  const identityWorkspace = useMemo(
    () => (isClawSession && workspaceId ? { id: workspaceId, rootPath: workspacePath } : null),
    [isClawSession, workspaceId, workspacePath],
  );
  const { document: identityDoc } = useAgentIdentityDocument(identityWorkspace);
  const assistantName = isClawSession ? (identityDoc.name || '') : '';

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    const showGreeting = isCoworkSession || isClawSession;
    if (hour >= 5 && hour < 12) return {
      title: showGreeting ? t('welcome.greetingMorning') : t('welcome.openingMorning'),
      subtitle: isCoworkSession ? t('welcome.subtitleMorningCowork') : undefined,
    };
    if (hour >= 12 && hour < 18) return {
      title: showGreeting ? t('welcome.greetingAfternoon') : t('welcome.openingAfternoon'),
      subtitle: isCoworkSession ? t('welcome.subtitleAfternoonCowork') : undefined,
    };
    if (hour >= 18 && hour < 23) return {
      title: showGreeting ? t('welcome.greetingEvening') : t('welcome.openingEvening'),
      subtitle: isCoworkSession ? t('welcome.subtitleEveningCowork') : undefined,
    };
    return {
      title: showGreeting ? t('welcome.greetingNight') : t('welcome.openingNight'),
      subtitle: isCoworkSession ? t('welcome.subtitleNightCowork') : undefined,
    };
  }, [t, isCoworkSession, isClawSession]);

  const showNarrative = !isClawSession && !hasWorkspace;
  const showDetails = Boolean(greeting.subtitle) || showNarrative || isCoworkSession;

  const aiPartnerKey = isCoworkSession ? 'welcome.aiPartnerCowork' : isClawSession ? 'welcome.aiPartnerClaw' : null;

  // Measure the caption independently of its animated shell, so it can give
  // the mode choices its exact space without wrapping or jumping mid-motion.
  useLayoutEffect(() => {
    const shell = captionRef.current;
    const content = captionContentRef.current;
    if (!shell || !content) return;
    const measure = () => {
      const width = content.getBoundingClientRect().width;
      if (width > 0) shell.style.setProperty('--_welcome-caption-width', `${width}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(content);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [greeting.title, workspaceName, aiPartnerKey, assistantName, t]);

  const handleOpenOtherFolder = useCallback(async () => {
    try {
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

  const handleQuickActionClick = useCallback((cmd: string) => {
    onQuickAction?.(cmd);
  }, [onQuickAction]);

  return (
    <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="root" className={`welcome-panel ${className}`}
      style={{ height: `max(0px, calc(100% - ${inputOverlayInsetPx}px))` }}>
      <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="content" className="welcome-panel__content">
        {/* Greeting */}
        <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="greeting"
          className="welcome-panel__greeting" data-mode-expanded={isModeExpanded}>
          {harnessProfile ? (
            <WelcomeModeSelector profile={harnessProfile} disabled={!canSelectMode}
              pending={isModeChangePending} onSelect={handleSelectMode}
              onExpandedChange={setModeSelectorExpanded} />
          ) : <span
            className="welcome-panel__mode-mark"
            data-openbitfun-product-component="welcome-panel"
            data-openbitfun-product-part="modeIcon"
            data-harness-profile={harnessProfile ?? 'other'}
            aria-hidden
          >
            {isClawSession
              ? <AssistantAvatar size="lg" className="welcome-panel__assistant-avatar" />
              : <Icon name="user" size="lg" />}
          </span>}
          <div ref={captionRef} className="welcome-panel__caption" aria-hidden={isModeExpanded}
            data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="caption">
            <PageHeader
              ref={captionContentRef}
              className="welcome-panel__caption-content"
              align="start"
              size="display"
              title={<span data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="heading">
                {showWorkspaceHeading ? (
                  <Trans
                    i18nKey="welcome.openingWorkspace"
                    t={t}
                    values={{ workspace: workspaceName }}
                    components={{
                      workspace: (
                        <button
                          ref={workspaceTriggerRef}
                          type="button"
                          className="welcome-panel__workspace-name"
                          data-openbitfun-product-component="welcome-panel"
                          data-openbitfun-product-part="workspaceAction"
                          data-openbitfun-state={workspaceMenuOpen ? 'open' : undefined}
                          onClick={() => setWorkspaceMenuOpen(open => !open)}
                          disabled={!canSelectWorkspace || isModeExpanded}
                          aria-haspopup="menu"
                          aria-expanded={workspaceMenuOpen && canSelectWorkspace}
                          title={tCommon('header.selectProjectDirectory')}
                        >
                          {workspaceName}
                        </button>
                      ),
                    }}
                  />
                ) : greeting.title}
                {aiPartnerKey && <>，{t(aiPartnerKey)}{isClawSession && assistantName ? `，${assistantName}` : ''}</>}
              </span>}
            />
          </div>
        </div>

        <MenuPopover
          anchorRef={workspaceTriggerRef}
          items={workspaceMenuItems}
          open={workspaceMenuOpen && showWorkspaceHeading && canSelectWorkspace && !isModeExpanded}
          onClose={() => setWorkspaceMenuOpen(false)}
          placement="bottom"
          aria-label={tCommon('header.selectProjectDirectory')}
          data-openbitfun-product-component="welcome-panel"
          data-openbitfun-product-part="workspaceMenu"
        />

        {showDetails && (
          <div className={`welcome-panel__details${greeting.subtitle ? ' welcome-panel__details--with-tagline' : ''}`}>
            {greeting.subtitle && (
              <p data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="tagline" className="welcome-panel__tagline">{greeting.subtitle}</p>
            )}
            <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="divider" className="welcome-panel__divider" />

            {showNarrative && (
              <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="narrative" className="welcome-panel__narrative">
                <p className="welcome-panel__narrative-text">
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
                </p>
              </div>
            )}

            {/* Cowork examples */}
            {isCoworkSession && (
              <div data-openbitfun-product-component="welcome-panel" data-openbitfun-product-part="cowork" className="welcome-panel__cowork">
                <CoworkExampleCards resetKey={0} onSelectPrompt={p => handleQuickActionClick(p)} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default WelcomePanel;
