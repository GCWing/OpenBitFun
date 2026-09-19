/**
 * Session-level actions for FlowChat.
 * The workspace scene renders these actions in the shared scene top bar;
 * standalone FlowChat hosts keep the inline fallback.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Keyboard, Square } from 'lucide-react';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Icon, IconButton, Menu, MenuItem, SearchField, Switch, Tooltip } from '@openbitfun/ui';
import { SceneChromeContribution } from '@/app/components/SceneTopBar/SceneChrome';
import { useSceneChromeContext } from '@/app/components/SceneTopBar/sceneChromeContext';
import { useTranslation } from 'react-i18next';
import { SessionFilesBadge } from './SessionFilesBadge';
import { SessionTreePopover, type SessionTreeSelection } from './SessionTreePopover';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { gitAPI, reviewPlatformAPI, type ReviewPlatformPullRequest } from '@/infrastructure/api';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance';
import { computeFixedPopoverPosition } from '@/shared/utils/fixedPopoverViewport';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import {
  createReviewPlatformPullRequestDetailTab,
  createReviewPlatformTab,
} from '@/shared/utils/tabUtils';
import './FlowChatHeader.scss';

const PULL_REQUEST_OVERVIEW_LIMIT = 3;

interface PullRequestOverviewState {
  status: 'idle' | 'loading' | 'loaded' | 'not-git' | 'no-workspace' | 'error';
  items: ReviewPlatformPullRequest[];
  totalCount: number;
}

export interface FlowChatHeaderCommandSummary {
  execSessionKey: string;
  execSessionId: number;
  title: string;
  command: string;
  status: 'running' | 'exited' | 'interrupted' | 'killed' | 'pruned' | 'failed';
  remote?: boolean;
  tty?: boolean;
  exitCode?: number;
  elapsedMs?: number;
  isStopping?: boolean;
}

export interface FlowChatHeaderProps {
  /** Whether the header is visible. */
  visible: boolean;
  /** Session ID. */
  sessionId?: string;
  /** Current search query string. */
  searchQuery?: string;
  /** Called when the user types in the search box. */
  onSearchChange?: (query: string) => void;
  /** Total number of search matches. */
  searchMatchCount?: number;
  /** 1-based index of the currently focused match. */
  searchCurrentMatch?: number;
  /** Navigate to the next match. */
  onSearchNext?: () => void;
  /** Navigate to the previous match. */
  onSearchPrev?: () => void;
  /** Called when the user closes the search bar. */
  onSearchClose?: () => void;
  /** Increments each time the parent requests to open the search bar. */
  searchOpenRequest?: number;
  /** Open a Session from the active Agent tree. */
  onOpenSessionTreeSession?: (selection: SessionTreeSelection) => void;
  /** Whether the active Agent tree contains running descendants. */
  hasActiveSessionTreeDescendants?: boolean;
  /** Cancel one running session from the active Agent tree without cancelling descendants. */
  onCancelSessionTreeSession?: (selection: SessionTreeSelection) => Promise<boolean>;
  onDeleteSessionTreeSession?: (selection: SessionTreeSelection) => Promise<boolean>;
  /** Long-running background commands launched by the active parent session. */
  backgroundCommands?: FlowChatHeaderCommandSummary[];
  /** Open a read-only output panel for a background command. */
  onOpenBackgroundCommandOutput?: (command: FlowChatHeaderCommandSummary) => void;
  /** Request user-provided stdin for an interactive background command. */
  onRequestBackgroundCommandInput?: (command: FlowChatHeaderCommandSummary) => void;
  /** Stop a running background command. */
  onStopBackgroundCommand?: (command: FlowChatHeaderCommandSummary) => void;
  /** Stop all running background commands. */
  onStopAllBackgroundCommands?: () => void;
  /** Whether the host-owned session right panel is open. */
  isRightPanelOpen?: boolean;
  /** Toggle the host-owned session right panel. */
  onToggleRightPanel?: () => void;
}
export const FlowChatHeader: React.FC<FlowChatHeaderProps> = ({
  visible,
  sessionId,
  searchQuery = '',
  onSearchChange,
  searchMatchCount = 0,
  searchCurrentMatch = 0,
  onSearchNext,
  onSearchPrev,
  onSearchClose,
  searchOpenRequest = 0,
  onOpenSessionTreeSession,
  hasActiveSessionTreeDescendants = false,
  onCancelSessionTreeSession,
  onDeleteSessionTreeSession,
  backgroundCommands = [],
  onOpenBackgroundCommandOutput,
  onRequestBackgroundCommandInput,
  onStopBackgroundCommand,
  onStopAllBackgroundCommands,
  isRightPanelOpen = false,
  onToggleRightPanel,
}) => {
  const { t } = useTranslation('flow-chat');
  const { currentWorkspace } = useWorkspaceContext();
  // Callbacks key on the workspace record's identifying facts, not the context
  // object, so a provider re-render cannot restart pull-request loading.
  const currentWorkspaceId = currentWorkspace?.id;
  const currentWorkspaceRootPath = currentWorkspace?.rootPath;
  const sceneChrome = useSceneChromeContext();
  const isSceneChromeActive = sceneChrome?.activeSceneId === 'session';
  const [isSessionOverviewOpen, setIsSessionOverviewOpen] = useState(false);
  const [activeAgentsOnly, setActiveAgentsOnly] = useState(true);
  const [isBackgroundCommandSectionMenuOpen, setIsBackgroundCommandSectionMenuOpen] = useState(false);
  const [openBackgroundCommandMenuId, setOpenBackgroundCommandMenuId] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const sessionOverviewRootRef = useRef<HTMLDivElement | null>(null);
  const sessionOverviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sessionOverviewPanelRef = useRef<HTMLDivElement | null>(null);
  const backgroundCommandMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const backgroundCommandMenuRef = useRef<HTMLDivElement | null>(null);
  const pullRequestOverviewRequestRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [backgroundCommandMenuPosition, setBackgroundCommandMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [pullRequestOverview, setPullRequestOverview] = useState<PullRequestOverviewState>({
    status: 'idle',
    items: [],
    totalCount: 0,
  });

  const hasBackgroundCommands = backgroundCommands.length > 0;
  const backgroundCommandCount = backgroundCommands.length;
  const runningBackgroundCommandCount = backgroundCommands.filter(command => command.status === 'running').length;
  const hasSessionActivity = hasActiveSessionTreeDescendants || runningBackgroundCommandCount > 0;
  const displayBackgroundCommands = useMemo(() => (
    backgroundCommands.map((command) => ({
      ...command,
      title: command.title.trim() || t('flowChatHeader.backgroundCommandUntitled'),
    }))
  ), [backgroundCommands, t]);
  const hasSearchQuery = searchQuery.trim().length > 0;
  const hasNoResults = hasSearchQuery && searchMatchCount === 0;
  const searchStatus = !hasSearchQuery
    ? ''
    : hasNoResults
      ? t('flowChatHeader.searchNoResults')
      : t('flowChatHeader.searchResult', {
        current: searchCurrentMatch,
        total: searchMatchCount,
      });
  const isSearchMode = visible && isSearchOpen;
  const hasOpenBackgroundCommandMenu =
    isBackgroundCommandSectionMenuOpen ||
    openBackgroundCommandMenuId !== null;
  const sessionOverviewPanelLayout = useAnchoredPopoverPosition({
    open: isSessionOverviewOpen,
    anchorRef: sessionOverviewTriggerRef,
    popoverRef: sessionOverviewPanelRef,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 8,
    layoutRevision: [
      backgroundCommandCount,
      runningBackgroundCommandCount,
      hasActiveSessionTreeDescendants,
      pullRequestOverview.status,
      pullRequestOverview.items.length,
    ].join(':'),
  });

  const updateBackgroundCommandMenuPosition = useCallback(() => {
    const anchor = backgroundCommandMenuAnchorRef.current;
    if (!anchor) return;

    const menu = backgroundCommandMenuRef.current;
    const { top, left } = computeFixedPopoverPosition(
      anchor.getBoundingClientRect(),
      menu?.offsetWidth ?? 200,
      menu?.offsetHeight ?? 96,
      4,
      8,
    );
    setBackgroundCommandMenuPosition({ top, left });
  }, []);

  const prepareBackgroundCommandMenu = useCallback((anchor: HTMLButtonElement) => {
    backgroundCommandMenuAnchorRef.current = anchor;
    updateBackgroundCommandMenuPosition();
  }, [updateBackgroundCommandMenuPosition]);

  const loadPullRequestOverview = useCallback(async () => {
    const requestId = pullRequestOverviewRequestRef.current + 1;
    pullRequestOverviewRequestRef.current = requestId;
    const workspaceId = currentWorkspaceId;
    const repositoryPath = currentWorkspaceRootPath;

    if (!workspaceId || !repositoryPath) {
      setPullRequestOverview({ status: 'no-workspace', items: [], totalCount: 0 });
      return;
    }

    setPullRequestOverview({ status: 'loading', items: [], totalCount: 0 });

    try {
      const isGitRepository = await gitAPI.isGitRepository({ workspaceId });
      if (pullRequestOverviewRequestRef.current !== requestId) return;
      if (!isGitRepository) {
        setPullRequestOverview({ status: 'not-git', items: [], totalCount: 0 });
        return;
      }

      const snapshot = await reviewPlatformAPI.getWorkspaceSnapshot(
        { workspaceId, repositoryPath },
        null,
        1,
        PULL_REQUEST_OVERVIEW_LIMIT,
      );
      if (pullRequestOverviewRequestRef.current !== requestId) return;

      setPullRequestOverview({
        status: 'loaded',
        items: snapshot.pullRequests.slice(0, PULL_REQUEST_OVERVIEW_LIMIT),
        totalCount: snapshot.pagination.total ?? snapshot.pullRequests.length,
      });
    } catch {
      if (pullRequestOverviewRequestRef.current !== requestId) return;
      setPullRequestOverview({ status: 'error', items: [], totalCount: 0 });
    }
  }, [currentWorkspaceId, currentWorkspaceRootPath]);

  useEffect(() => {
    if (!isSessionOverviewOpen) return undefined;
    void loadPullRequestOverview();

    return () => {
      pullRequestOverviewRequestRef.current += 1;
    };
  }, [isSessionOverviewOpen, loadPullRequestOverview]);

  const closeSessionOverview = useCallback((returnFocus = false) => {
    setIsSessionOverviewOpen(false);
    setIsBackgroundCommandSectionMenuOpen(false);
    setOpenBackgroundCommandMenuId(null);
    setBackgroundCommandMenuPosition(null);
    if (returnFocus) {
      requestAnimationFrame(() => sessionOverviewTriggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
    let removeOverlayKeydown1: (() => void) | undefined;
    if (!isSessionOverviewOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const targetElement = event.target instanceof Element ? event.target : null;
      if (
        !sessionOverviewRootRef.current?.contains(target) &&
        !sessionOverviewPanelRef.current?.contains(target) &&
        !backgroundCommandMenuRef.current?.contains(target) &&
        !targetElement?.closest('[data-openbitfun-part="sessionTreeMenu"]')
      ) {
        closeSessionOverview(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSessionOverview(true);
      }
    };

    removeOverlayMousedown0 = subscribeOverlayInteraction(sessionOverviewPanelRef, 'mousedown', handlePointerDown);
    removeOverlayKeydown1 = subscribeOverlayInteraction(sessionOverviewPanelRef, 'keydown', handleKeyDown);

    return () => {
      removeOverlayMousedown0?.();
      removeOverlayKeydown1?.();
    };
  }, [closeSessionOverview, isSessionOverviewOpen]);

  useLayoutEffect(() => {
    if (!hasOpenBackgroundCommandMenu) {
      setBackgroundCommandMenuPosition(null);
      return;
    }

    updateBackgroundCommandMenuPosition();
    window.addEventListener('resize', updateBackgroundCommandMenuPosition);
    window.addEventListener('scroll', updateBackgroundCommandMenuPosition, true);

    return () => {
      window.removeEventListener('resize', updateBackgroundCommandMenuPosition);
      window.removeEventListener('scroll', updateBackgroundCommandMenuPosition, true);
    };
  }, [
    hasOpenBackgroundCommandMenu,
    isBackgroundCommandSectionMenuOpen,
    openBackgroundCommandMenuId,
    updateBackgroundCommandMenuPosition,
  ]);

  const prevSearchOpenRequestRef = useRef(0);
  useEffect(() => {
    if (searchOpenRequest > 0 && searchOpenRequest !== prevSearchOpenRequestRef.current) {
      prevSearchOpenRequestRef.current = searchOpenRequest;
      closeSessionOverview(false);
      setIsSearchOpen(true);
    }
  }, [closeSessionOverview, searchOpenRequest]);

  useEffect(() => {
    if (hasBackgroundCommands) return;

    setIsBackgroundCommandSectionMenuOpen(false);
    setOpenBackgroundCommandMenuId(null);
    setBackgroundCommandMenuPosition(null);
  }, [hasBackgroundCommands]);

  useEffect(() => {
    if (!isSearchOpen) return;

    const frameId = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [isSceneChromeActive, isSearchOpen, visible]);

  const handleOpenSearch = useCallback(() => {
    closeSessionOverview(false);
    setIsSearchOpen(true);
  }, [closeSessionOverview]);

  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
    onSearchClose?.();
  }, [onSearchClose]);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.defaultPrevented) return;

      if (e.key === 'Escape') {
        handleCloseSearch();
        e.preventDefault();
        return;
      }

      if (e.key === 'Enter' && e.target === searchInputRef.current) {
        if (e.shiftKey) {
          onSearchPrev?.();
        } else {
          onSearchNext?.();
        }
        e.preventDefault();
      }
    },
    [handleCloseSearch, onSearchNext, onSearchPrev],
  );

  const handleToggleSessionOverview = (event: React.MouseEvent<HTMLButtonElement>) => {
    const nextOpen = !isSessionOverviewOpen;
    setIsBackgroundCommandSectionMenuOpen(false);
    setOpenBackgroundCommandMenuId(null);
    setBackgroundCommandMenuPosition(null);
    setIsSessionOverviewOpen(nextOpen);
    if (!nextOpen && event.detail === 0) {
      requestAnimationFrame(() => sessionOverviewTriggerRef.current?.focus());
    }
  };

  const handleOpenPullRequests = useCallback(() => {
    if (!currentWorkspaceId) return;
    createReviewPlatformTab(currentWorkspaceId, currentWorkspaceRootPath);
    closeSessionOverview(false);
  }, [closeSessionOverview, currentWorkspaceId, currentWorkspaceRootPath]);

  const handleOpenPullRequest = useCallback((pullRequest: ReviewPlatformPullRequest) => {
    if (!currentWorkspaceId) return;
    createReviewPlatformPullRequestDetailTab({
      workspaceId: currentWorkspaceId,
      workspacePath: currentWorkspaceRootPath,
      remoteId: pullRequest.providerId ?? undefined,
      pullRequestId: pullRequest.id,
      pullRequestUrl: pullRequest.webUrl,
      title: `#${pullRequest.number} ${pullRequest.title}`,
    });
    closeSessionOverview(false);
  }, [closeSessionOverview, currentWorkspaceId, currentWorkspaceRootPath]);

  const handleCommandSectionMenuToggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (isBackgroundCommandSectionMenuOpen) {
      setBackgroundCommandMenuPosition(null);
    } else {
      prepareBackgroundCommandMenu(event.currentTarget);
    }
    setOpenBackgroundCommandMenuId(null);
    setIsBackgroundCommandSectionMenuOpen(open => !open);
  };

  const handleCommandSelect = (command: FlowChatHeaderCommandSummary) => {
    onOpenBackgroundCommandOutput?.(command);
    closeSessionOverview(false);
  };

  const handleCommandMenuToggle = (
    event: React.MouseEvent<HTMLButtonElement>,
    command: FlowChatHeaderCommandSummary,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (openBackgroundCommandMenuId === command.execSessionKey) {
      setBackgroundCommandMenuPosition(null);
    } else {
      prepareBackgroundCommandMenu(event.currentTarget);
    }
    setIsBackgroundCommandSectionMenuOpen(false);
    setOpenBackgroundCommandMenuId(previous => previous === command.execSessionKey ? null : command.execSessionKey);
  };

  const handleCommandInputRequest = (
    event: React.MouseEvent<HTMLButtonElement>,
    command: FlowChatHeaderCommandSummary,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    onRequestBackgroundCommandInput?.(command);
    setOpenBackgroundCommandMenuId(null);
    closeSessionOverview(false);
  };

  const handleCommandStop = (
    event: React.MouseEvent<HTMLButtonElement>,
    command: FlowChatHeaderCommandSummary,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    onStopBackgroundCommand?.(command);
    setOpenBackgroundCommandMenuId(null);
  };

  const handleCommandStopAll = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onStopAllBackgroundCommands?.();
    setIsBackgroundCommandSectionMenuOpen(false);
  };

  const renderBackgroundCommandActions = (command: FlowChatHeaderCommandSummary) => {
    const canSendBackgroundCommandInput =
      command.status === 'running' &&
      command.tty === true &&
      !!onRequestBackgroundCommandInput;
    const canStopBackgroundCommand =
      command.status === 'running' &&
      !!onStopBackgroundCommand;

    if (!canSendBackgroundCommandInput && !canStopBackgroundCommand) {
      return null;
    }

    return (
      <div
        className="flowchat-header__background-command-actions"
        data-openbitfun-component="flow-chat-header"
        data-openbitfun-part="backgroundActivity"
      >
        <Tooltip content={t('flowChatHeader.backgroundCommandActions')}>
          <IconButton
            className="flowchat-header__background-command-menu-button"
            size="sm"
            onClick={(event) => handleCommandMenuToggle(event, command)}
            aria-label={t('flowChatHeader.backgroundCommandActions')}
            aria-haspopup="menu"
            aria-expanded={openBackgroundCommandMenuId === command.execSessionKey}
            icon={<Icon name="more" size="lg" style={{ width: 13, height: 13 }} aria-hidden="true" />}
          />
        </Tooltip>
        {openBackgroundCommandMenuId === command.execSessionKey && backgroundCommandMenuPosition ? createOverlayPortal(
          <Menu
            ref={backgroundCommandMenuRef}
            className="flowchat-header__background-command-menu flowchat-header__background-command-menu--portal"
            data-openbitfun-component="flow-chat-header"
            data-openbitfun-part="commandMenu"
            data-openbitfun-native-webview-occlusion
            aria-label={t('flowChatHeader.backgroundCommandActions')}
            style={backgroundCommandMenuPosition}
            data-testid="flowchat-header-background-menu"
          >
            {canSendBackgroundCommandInput ? (
              <MenuItem
                type="button"
                data-openbitfun-component="flow-chat-header"
                data-openbitfun-part="commandItem"
                onClick={(event) => handleCommandInputRequest(event, command)}
                leading={<Keyboard size={12} aria-hidden="true" />}
              >
                <span>{t('flowChatHeader.backgroundCommandSendInput')}</span>
              </MenuItem>
            ) : null}
            {canStopBackgroundCommand ? (
              <MenuItem
                type="button"
                tone="danger"
                data-openbitfun-component="flow-chat-header"
                data-openbitfun-part="commandItem"
                onClick={(event) => handleCommandStop(event, command)}
                disabled={command.isStopping === true}
                leading={<Square size={12} aria-hidden="true" />}
              >
                <span>
                  {command.isStopping
                    ? t('flowChatHeader.backgroundCommandStopping')
                    : t('flowChatHeader.backgroundCommandStop')}
                </span>
              </MenuItem>
            ) : null}
          </Menu>,
          getAppearanceOverlayHost(),
        ) : null}
      </div>
    );
  };

  const sessionOverviewLabel = hasSessionActivity
    ? t('flowChatHeader.sessionOverviewActive')
    : t('flowChatHeader.sessionOverview');
  const agentOverviewSummary = !sessionId
    ? t('flowChatHeader.sessionOverviewAgentsUnavailable')
    : hasActiveSessionTreeDescendants
      ? t('flowChatHeader.sessionOverviewAgentsActive')
      : t('flowChatHeader.sessionOverviewAgentsIdle');
  const backgroundOverviewSummary = runningBackgroundCommandCount > 0
    ? t('flowChatHeader.sessionOverviewBackgroundRunning', {
        count: runningBackgroundCommandCount,
      })
    : hasBackgroundCommands
      ? t('flowChatHeader.sessionOverviewBackgroundFinished', {
          count: backgroundCommandCount,
        })
      : t('flowChatHeader.backgroundCommandEmpty');
  let pullRequestOverviewSummary: string;
  switch (pullRequestOverview.status) {
    case 'loading':
      pullRequestOverviewSummary = t('flowChatHeader.pullRequestLoading');
      break;
    case 'not-git':
      pullRequestOverviewSummary = t('flowChatHeader.pullRequestNotGitRepository');
      break;
    case 'no-workspace':
      pullRequestOverviewSummary = t('flowChatHeader.pullRequestWorkspaceUnavailable');
      break;
    case 'error':
      pullRequestOverviewSummary = t('flowChatHeader.pullRequestLoadFailed');
      break;
    default:
      pullRequestOverviewSummary = pullRequestOverview.totalCount > 0
        ? t('flowChatHeader.pullRequestCount', { count: pullRequestOverview.totalCount })
        : t('flowChatHeader.pullRequestEmpty');
  }
  const isPullRequestOverviewUnavailable =
    pullRequestOverview.status === 'not-git' || pullRequestOverview.status === 'no-workspace';
  const rightPanelLabel = isRightPanelOpen
    ? t('common:header.collapseRightPanel')
    : t('common:header.expandRightPanel');

  const leftActions = (
    <div
      className="flowchat-header__actions flowchat-header__actions--left"
      data-openbitfun-component="flow-chat-header"
      data-openbitfun-part="leftActions"
    >
      <SessionFilesBadge sessionId={sessionId} />
    </div>
  );
  const rightActions = (
    <div
      className="flowchat-header__actions"
      data-openbitfun-component="flow-chat-header"
      data-openbitfun-part="actions"
    >
        {isSearchMode ? (
          <div
            className="flowchat-header__search"
            role="search"
            onKeyDown={handleSearchKeyDown}
            data-testid="flowchat-header-search-bar"
            data-openbitfun-component="flow-chat-header"
            data-openbitfun-part="search"
            data-openbitfun-state="active"
          >
            <SearchField
              ref={searchInputRef}
              className="flowchat-header__search-field"
              variant={hasSearchQuery ? 'panel' : 'default'}
              leadingIcon={<Icon name="search" size="sm" />}
              footer={hasSearchQuery ? (
                <>
                  <span className="flowchat-header__search-status" aria-hidden="true">
                    <OverflowText>{searchStatus}</OverflowText>
                  </span>
                  <span className="flowchat-header__search-navigation">
                    <Tooltip content={t('flowChatHeader.searchPrevious')}>
                      <IconButton
                        size="xs"
                        shape="circle"
                        variant="fill"
                        disabled={hasNoResults || !onSearchPrev}
                        onClick={onSearchPrev}
                        onMouseDown={event => event.preventDefault()}
                        aria-label={t('flowChatHeader.searchPrevious')}
                        icon={<Icon name="arrow-up" />}
                      />
                    </Tooltip>
                    <Tooltip content={t('flowChatHeader.searchNext')}>
                      <IconButton
                        size="xs"
                        shape="circle"
                        variant="fill"
                        disabled={hasNoResults || !onSearchNext}
                        onClick={onSearchNext}
                        onMouseDown={event => event.preventDefault()}
                        aria-label={t('flowChatHeader.searchNext')}
                        icon={<Icon name="arrow-down" />}
                      />
                    </Tooltip>
                  </span>
                </>
              ) : undefined}
              trailingAction={
                <span
                  className="flowchat-header__search-controls"
                  data-openbitfun-component="flow-chat-header"
                  data-openbitfun-part="searchControls"
                >
                  <Tooltip content={t('flowChatHeader.searchClose')}>
                    <IconButton
                      className="flowchat-header__search-close"
                      size="xs"
                      shape="circle"
                      variant="quiet"
                      onClick={handleCloseSearch}
                      onMouseDown={event => event.preventDefault()}
                      aria-label={t('flowChatHeader.searchClose')}
                      icon={<Icon name="xmark" />}
                    />
                  </Tooltip>
                </span>
              }
              value={searchQuery}
              onChange={e => onSearchChange?.(e.target.value)}
              placeholder={t('flowChatHeader.searchPlaceholder')}
              aria-label={t('flowChatHeader.searchPlaceholder')}
              size="sm"
            />
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {searchStatus}
            </span>
          </div>
        ) : visible ? (
          <Tooltip content={t('flowChatHeader.searchOpen')}>
            <IconButton
              className="flowchat-header__search-btn"
              size="xs"
              onClick={handleOpenSearch}
              aria-label={t('flowChatHeader.searchOpen')}
              data-testid="flowchat-header-search"
              icon={<Icon name="search" size="sm" />}
            />
          </Tooltip>
        ) : null}
        {!isSearchMode ? (
          <div
            className="flowchat-header__session-overview"
            ref={sessionOverviewRootRef}
            data-openbitfun-component="flow-chat-header"
            data-openbitfun-part="sessionOverview"
          >
          <Tooltip content={sessionOverviewLabel}>
            <IconButton
              ref={sessionOverviewTriggerRef}
              className={[
                'flowchat-header__session-overview-trigger',
                isSessionOverviewOpen && 'flowchat-header__session-overview-trigger--active',
                hasSessionActivity && 'flowchat-header__session-overview-trigger--has-activity',
              ].filter(Boolean).join(' ')}
              data-openbitfun-component="flow-chat-header"
              data-openbitfun-part="sessionOverviewTrigger"
              data-openbitfun-state={[
                isSessionOverviewOpen ? 'open' : null,
                hasSessionActivity ? 'active' : null,
              ].filter(Boolean).join(' ') || undefined}
              size="xs"
              onClick={handleToggleSessionOverview}
              aria-label={sessionOverviewLabel}
              aria-expanded={isSessionOverviewOpen}
              aria-haspopup="dialog"
              data-testid="flowchat-header-session-overview"
              icon={<span className="flowchat-header__session-overview-trigger-inner">
                <Icon name="settings" size="sm" />
                {hasSessionActivity ? (
                  <span
                    className="flowchat-header__session-overview-status-dot"
                    aria-hidden="true"
                  />
                ) : null}
              </span>}
            />
          </Tooltip>

          {isSessionOverviewOpen && createOverlayPortal(
            <div
              ref={sessionOverviewPanelRef}
              className="flowchat-header__session-overview-panel"
              data-openbitfun-component="flow-chat-header"
              data-openbitfun-part="sessionOverviewPanel"
              data-openbitfun-native-webview-occlusion
              data-openbitfun-placement={sessionOverviewPanelLayout?.placement ?? 'bottom'}
              role="dialog"
              aria-label={t('flowChatHeader.sessionOverview')}
              data-testid="flowchat-header-session-overview-panel"
              style={{
                top: `${sessionOverviewPanelLayout?.top ?? 0}px`,
                left: `${sessionOverviewPanelLayout?.left ?? 0}px`,
                visibility: sessionOverviewPanelLayout ? 'visible' : 'hidden',
              }}
            >
              <div className="flowchat-header__session-overview-panel-header">
                <div className="flowchat-header__session-overview-panel-heading">
                  <OverflowText>{t('flowChatHeader.sessionOverview')}</OverflowText>
                </div>
              </div>

              <div
                className="flowchat-header__session-overview-list"
                data-openbitfun-component="flow-chat-header"
                data-openbitfun-part="sessionOverviewList"
              >
                <div
                  className="flowchat-header__session-overview-section"
                  data-openbitfun-component="flow-chat-header"
                  data-openbitfun-part="sessionOverviewItem"
                  data-openbitfun-state={hasActiveSessionTreeDescendants ? 'active' : undefined}
                  data-testid="flowchat-header-session-tree-section"
                >
                  <div
                    className="flowchat-header__session-overview-section-header"
                    aria-label={`${t('flowChatHeader.agentTree')}, ${agentOverviewSummary}`}
                  >
                    <span className="flowchat-header__session-overview-section-title">
                      <OverflowText>{t('flowChatHeader.agentTree')}</OverflowText>
                      {hasActiveSessionTreeDescendants ? (
                        <span className="flowchat-header__session-overview-section-status" aria-hidden="true" />
                      ) : null}
                    </span>
                    <Tooltip content={t('flowChatHeader.agentTreeActiveOnly')}>
                      <Switch
                        checked={activeAgentsOnly}
                        aria-label={t('flowChatHeader.agentTreeActiveOnly')}
                        onChange={(event) => setActiveAgentsOnly(event.currentTarget.checked)}
                      />
                    </Tooltip>
                  </div>
                  {sessionId ? (
                    <SessionTreePopover
                      sessionId={sessionId}
                      fallbackWorkspaceId={currentWorkspaceId}
                      onSelectSession={onOpenSessionTreeSession}
                      hasActiveDescendants={hasActiveSessionTreeDescendants}
                      onCancelSession={onCancelSessionTreeSession}
                      onDeleteSession={onDeleteSessionTreeSession}
                      embedded
                      activeOnly={activeAgentsOnly}
                      open={isSessionOverviewOpen}
                      onRequestClose={() => closeSessionOverview(false)}
                      t={t}
                    />
                  ) : (
                    <div
                      className="flowchat-header__session-overview-empty-state"
                      data-openbitfun-state="empty"
                    >
                      {t('flowChatHeader.sessionOverviewAgentsUnavailable')}
                    </div>
                  )}
                </div>

                <div
                  className="flowchat-header__session-overview-section"
                  data-openbitfun-component="flow-chat-header"
                  data-openbitfun-part="sessionOverviewItem"
                  data-openbitfun-state={runningBackgroundCommandCount > 0 ? 'active' : undefined}
                  data-testid="flowchat-header-background-commands"
                >
                  <div
                    className="flowchat-header__session-overview-section-header"
                    aria-label={`${t('flowChatHeader.backgroundCommandOverview')}, ${backgroundOverviewSummary}`}
                  >
                    <span className="flowchat-header__session-overview-section-title">
                      <OverflowText>{t('flowChatHeader.backgroundCommandOverview')}</OverflowText>
                    </span>
                    <span className="flowchat-header__session-overview-section-count" aria-hidden="true">
                      {backgroundCommandCount}
                    </span>
                    <div className="flowchat-header__session-overview-section-actions">
                      {hasBackgroundCommands && onStopAllBackgroundCommands ? (
                        <Tooltip content={t('flowChatHeader.backgroundCommandActions')}>
                          <IconButton
                            className="flowchat-header__background-command-menu-button"
                            size="sm"
                            onClick={handleCommandSectionMenuToggle}
                            aria-label={t('flowChatHeader.backgroundCommandActions')}
                            aria-haspopup="menu"
                            aria-expanded={isBackgroundCommandSectionMenuOpen}
                            disabled={displayBackgroundCommands.every(command => (
                              command.status !== 'running' || command.isStopping === true
                            ))}
                            icon={<Icon name="more" size="lg" style={{ width: 13, height: 13 }} aria-hidden="true" />}
                          />
                        </Tooltip>
                      ) : null}
                      {isBackgroundCommandSectionMenuOpen && backgroundCommandMenuPosition ? createOverlayPortal(
                        <Menu
                          ref={backgroundCommandMenuRef}
                          className="flowchat-header__background-command-menu flowchat-header__background-command-menu--portal"
                          data-openbitfun-component="flow-chat-header"
                          data-openbitfun-part="commandMenu"
                          data-openbitfun-native-webview-occlusion
                          aria-label={t('flowChatHeader.backgroundCommandActions')}
                          style={backgroundCommandMenuPosition}
                          data-testid="flowchat-header-background-menu"
                        >
                          <MenuItem
                            type="button"
                            tone="danger"
                            data-openbitfun-component="flow-chat-header"
                            data-openbitfun-part="commandItem"
                            onClick={handleCommandStopAll}
                            leading={<Square size={12} aria-hidden="true" />}
                          >
                            <span>{t('flowChatHeader.backgroundCommandStopAll')}</span>
                          </MenuItem>
                        </Menu>,
                        getAppearanceOverlayHost(),
                      ) : null}
                    </div>
                  </div>
                  {hasBackgroundCommands ? (
                    <div
                      className="flowchat-header__background-command-list"
                      data-openbitfun-component="flow-chat-header"
                      data-openbitfun-part="activitySection"
                    >
                      {displayBackgroundCommands.map((command) => (
                        <div
                          key={command.execSessionKey}
                          className="flowchat-header__background-command-list-item"
                        >
                          <button data-overflow-trigger
                            type="button"
                            className="flowchat-header__background-command-list-item-button flowchat-header__background-command-open-button"
                            onClick={() => handleCommandSelect(command)}
                            aria-label={`${command.title}, ${t(command.status === 'running'
                              ? 'flowChatHeader.backgroundCommandStatusRunning'
                              : 'flowChatHeader.backgroundCommandStatusFinished')}`}
                          >
                            <span className="flowchat-header__background-command-list-title">
                              <span
                                className="flowchat-header__background-command-icon"
                                data-running={command.status === 'running' ? 'true' : undefined}
                                aria-hidden="true"
                              >
                                <Icon name="terminal" size="xs" />
                              </span>
                              <OverflowText>{command.title}</OverflowText>
                            </span>
                          </button>
                          {renderBackgroundCommandActions(command)}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div
                      className="flowchat-header__session-overview-empty-state"
                      data-openbitfun-component="flow-chat-header"
                      data-openbitfun-part="activitySection"
                      data-openbitfun-state="empty"
                      data-testid="flowchat-header-background-empty"
                    >
                      {t('flowChatHeader.backgroundCommandEmpty')}
                    </div>
                  )}
                </div>

                <div
                  className="flowchat-header__session-overview-section flowchat-header__session-overview-section--pull-requests"
                  data-openbitfun-component="flow-chat-header"
                  data-openbitfun-part="sessionOverviewItem"
                  data-openbitfun-state={isPullRequestOverviewUnavailable ? 'unavailable' : pullRequestOverview.status}
                  data-testid="flowchat-header-pull-requests"
                >
                  <button data-overflow-trigger
                    type="button"
                    className="flowchat-header__session-overview-section-header flowchat-header__session-overview-section-header--action"
                    onClick={handleOpenPullRequests}
                    aria-label={`${t('flowChatHeader.pullRequests')}, ${pullRequestOverviewSummary}`}
                    disabled={isPullRequestOverviewUnavailable}
                  >
                    <OverflowText className="flowchat-header__session-overview-section-title">
                      {t('flowChatHeader.pullRequests')}
                    </OverflowText>
                    {pullRequestOverview.status === 'loaded' ? (
                      <span className="flowchat-header__session-overview-section-count" aria-hidden="true">
                        {pullRequestOverview.totalCount}
                      </span>
                    ) : null}
                  </button>

                  {pullRequestOverview.status === 'loading' || pullRequestOverview.status === 'idle' ? (
                    <div
                      className="flowchat-header__session-overview-empty-state"
                      data-openbitfun-state="loading"
                      aria-live="polite"
                    >
                      {t('flowChatHeader.pullRequestLoading')}
                    </div>
                  ) : pullRequestOverview.status === 'error' ? (
                    <button
                      type="button"
                      className="flowchat-header__session-overview-empty-state flowchat-header__session-overview-empty-state--action flowchat-header__session-overview-empty-state--error"
                      data-openbitfun-state="error"
                      onClick={() => void loadPullRequestOverview()}
                    >
                      {t('flowChatHeader.pullRequestLoadFailed')}
                    </button>
                  ) : pullRequestOverview.status === 'not-git' ? (
                    <div
                      className="flowchat-header__session-overview-empty-state"
                      data-openbitfun-state="unavailable"
                      data-testid="flowchat-header-pull-requests-unavailable"
                    >
                      {t('flowChatHeader.pullRequestNotGitRepository')}
                    </div>
                  ) : pullRequestOverview.status === 'no-workspace' ? (
                    <div
                      className="flowchat-header__session-overview-empty-state"
                      data-openbitfun-state="unavailable"
                      data-testid="flowchat-header-pull-requests-unavailable"
                    >
                      {t('flowChatHeader.pullRequestWorkspaceUnavailable')}
                    </div>
                  ) : pullRequestOverview.items.length === 0 ? (
                    <div
                      className="flowchat-header__session-overview-empty-state"
                      data-openbitfun-state="empty"
                      data-testid="flowchat-header-pull-requests-empty"
                    >
                      {t('flowChatHeader.pullRequestEmpty')}
                    </div>
                  ) : (
                    <div className="flowchat-header__pull-request-list">
                      {pullRequestOverview.items.map(pullRequest => (
                        <button data-overflow-trigger
                          key={`${pullRequest.providerId ?? 'auto'}:${pullRequest.id}`}
                          type="button"
                          className="flowchat-header__pull-request-item"
                          onClick={() => handleOpenPullRequest(pullRequest)}
                          title={`#${pullRequest.number} ${pullRequest.title}`}
                          data-testid="flowchat-header-pull-request-item"
                        >
                          <OverflowText>#{pullRequest.number} {pullRequest.title}</OverflowText>
                          <Icon name="chevron-right" size="lg" style={{ width: 13, height: 13 }} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>,
            getAppearanceOverlayHost(),
          )}
          </div>
        ) : null}
        {!isSearchMode && onToggleRightPanel ? (
          <Tooltip content={rightPanelLabel}>
            <IconButton
              className={[
                'flowchat-header__right-panel-trigger',
                isRightPanelOpen && 'flowchat-header__right-panel-trigger--active',
              ].filter(Boolean).join(' ')}
              data-openbitfun-component="flow-chat-header"
              data-openbitfun-part="rightPanelTrigger"
              data-openbitfun-state={isRightPanelOpen ? 'open' : 'collapsed'}
              size="xs"
              onClick={onToggleRightPanel}
              aria-label={rightPanelLabel}
              aria-pressed={isRightPanelOpen}
              data-testid="flowchat-header-right-panel"
              icon={<Icon name="sidebar-right" size="sm" />}
            />
          </Tooltip>
        ) : null}
      </div>
  );

  if (sceneChrome) {
    return (
      <SceneChromeContribution sceneId="session">
        <div
          className="flowchat-header__chrome-actions flow-chat-typography"
          data-shortcut-scope="chat"
          data-openbitfun-component="flow-chat-header"
          data-openbitfun-part="root"
        >
          {!isSearchMode ? leftActions : null}
          {rightActions}
        </div>
      </SceneChromeContribution>
    );
  }

  if (!visible) {
    return null;
  }

  return (
    <div
      className={[
        'flowchat-header',
        isSearchMode && 'flowchat-header--searching',
      ].filter(Boolean).join(' ')}
      data-openbitfun-component="flow-chat-header"
      data-openbitfun-part="root"
    >
      {!isSearchMode ? leftActions : null}
      {rightActions}
    </div>
  );
};

FlowChatHeader.displayName = 'FlowChatHeader';
