import { useDeviceDirectory, resolveDeviceName } from '@/infrastructure/account/deviceDirectory';
/**
 * Two fixed rails in the composer's upper context band.
 *
 * The left rail is the situation the session is in — its workspace and branch,
 * followed by the local/remote execution target. Worktree isolation is a local
 * target mode. The right rail is the contract for the next turn — how much
 * confirmation it asks for and how
 * much context is left. Nothing is centered and no column template is
 * conditional, so a control appearing or disappearing cannot move the rest of
 * the track.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Circle, Shield, ShieldAlert, ShieldCheck, Square, SquareCheck } from 'lucide-react';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Menu, MenuItem, MenuSection, MenuSeparator } from '@openbitfun/ui';
import { Tooltip, Icon } from '@openbitfun/ui';
import { BranchQuickSwitch } from '@/tools/git/components/BranchQuickSwitch';
import { useGitState } from '@/tools/git/hooks/useGitState';
import type { SessionExecutionTarget } from '@/infrastructure/api/service-api/WorktreeAPI';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import {
  getWorkspaceDisplayName,
  useOptionalWorkspaceContext,
} from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n';
import { WorkspaceKind } from '@/shared/types';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { DispatchResultDialog } from '@/features/dispatch/DispatchResultDialog';
import { DispatchTargetPicker } from '@/features/dispatch/DispatchTargetPicker';
import type { DispatchSelection, DispatchTarget } from '@/features/dispatch/types';
import { formatCompactTokenCount } from '../utils/tokenUsageDisplay';
import './ChatInputWorkspaceStrip.scss';

export interface ChatInputWorkspaceStripProps {
  /** Repo root for git status; may come from session when global workspace is unset. */
  repositoryPath: string;
  workspaceId: string;
  /** Resolved display name (workspace title or folder basename). */
  workspaceLabel: string;
  /** Session usage report (/usage) — context ring on the right rail. */
  usageReport?: {
    visible: boolean;
    currentTokens: number;
    maxTokens: number;
    onOpen: () => void;
  };
  /** Native-tool permission mode for this session, exposed as a compact strip control. */
  permissionControl?: {
    /**
     * The session-scoped mode. This is what the checkmark marks, so it stays
     * separate from `nextTurnMode`: one is session state, the other a temporary
     * override, and conflating them would make the menu lie about which is
     * which once a one-off is armed.
     */
    mode: ChatInputPermissionMode;
    saving?: boolean;
    disabled?: boolean;
    options?: Array<Exclude<ChatInputPermissionMode, 'acp'>>;
    /** Scope owned by the primary radio list, such as the current session. */
    scopeLabel?: string;
    /**
     * The session chose its own mode instead of following the default. Shown so
     * two sessions sitting on different modes is legible rather than confusing.
     */
    overridden?: boolean;
    /** Clears the session's own selection and follows the default again. */
    onResetToDefault?: () => void | Promise<void>;
    /** Opens the settings page that owns the default this row follows. */
    onOpenDefaultSettings?: () => void;
    /**
     * Temporary one-off mode. While idle it is armed for the next submission;
     * while a turn is active it is that turn's mutable override.
     */
    nextTurnMode?: ChatInputPermissionMode | null;
    /** Whether `nextTurnMode` currently belongs to the active turn. */
    activeTurn?: boolean;
    onChange?: (mode: Exclude<ChatInputPermissionMode, 'acp'>) => void | Promise<void>;
    /** Updates the one-off mode exposed through the secondary scope menu. */
    onChangeForNextTurn?: (
      mode: Exclude<ChatInputPermissionMode, 'acp'>,
    ) => void | Promise<void>;
  };
  /** Keep the strip on cached Git state while historical content is still restoring. */
  deferPassiveGitRefresh?: boolean;
  /** Resolved target bound to the active session. */
  executionTarget?: SessionExecutionTarget;
  /**
   * Per-session worktree isolation, exposed as a local execution-target mode.
   * Omitted when the session cannot host a worktree at all (remote, no session).
   */
  worktreeControl?: {
    /** Desired state, including an armed worktree not created until first send. */
    enabled: boolean;
    /** Locked once the session has a transcript — its history describes one directory. */
    locked: boolean;
    /** Why the control is locked, when a transcript is not the reason. */
    lockedReason?: 'dispatch';
    onChange: (enabled: boolean) => void;
  };
  /** Immutable per-session dispatch destination. Hidden on embedded/mini composers. */
  dispatchControl?: {
    target: DispatchTarget;
    sourceWorkspacePath?: string;
    locked: boolean;
    onSelectLocal?: () => void;
    onSelectTarget: (selection: DispatchSelection) => void;
    /** Target worktree can be committed and synced from running onward. */
    syncableJobId?: string;
    branch?: string;
    baselineWorktreePath?: string;
    baselineMissing?: boolean;
  };
}

export type ChatInputPermissionMode = 'ask' | 'auto' | 'full_access' | 'reject' | 'acp';

const NATIVE_PERMISSION_MODES: Array<Exclude<ChatInputPermissionMode, 'acp' | 'reject'>> = [
  'ask',
  'auto',
  'full_access',
];

/**
 * Risk ramp shared by the trigger and the menu rows: the shield gains a mark as
 * the mode gives up more confirmation, and its color follows the same ramp.
 */
const PERMISSION_MODE_ICONS: Record<ChatInputPermissionMode, typeof Shield> = {
  ask: Shield,
  auto: ShieldCheck,
  full_access: ShieldAlert,
  reject: Shield,
  acp: Shield,
};

export const ChatInputWorkspaceStrip: React.FC<ChatInputWorkspaceStripProps> = ({
  repositoryPath,
  workspaceId,
  workspaceLabel,
  usageReport,
  permissionControl,
  deferPassiveGitRefresh = false,
  executionTarget,
  worktreeControl,
  dispatchControl,
}) => {
  useDeviceDirectory();
  const { t } = useTranslation('flow-chat');
  const { t: tWorktrees } = useI18n('worktrees');
  const { t: tCommon } = useI18n('common');
  const workspaceContext = useOptionalWorkspaceContext();
  const permissionRootRef = useRef<HTMLDivElement>(null);
  const permissionTriggerRef = useRef<HTMLButtonElement>(null);
  const permissionMenuRef = useRef<HTMLDivElement>(null);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [permissionMenuView, setPermissionMenuView] = useState<'session' | 'turn'>('session');
  const permissionMenuFocusTargetRef = useRef<string | null>(null);
  const [resultDialogOpen, setResultDialogOpen] = useState(false);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const branchPickerId = useId();
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const permissionMenuLayout = useAnchoredPopoverPosition({
    open: permissionMenuOpen,
    anchorRef: permissionTriggerRef,
    popoverRef: permissionMenuRef,
    preferredPlacement: 'top',
    alignment: 'end',
    gap: 7,
    layoutRevision: `${permissionMenuView}:${permissionControl?.options?.length ?? 0}`,
  });
  const workspaceMenuLayout = useAnchoredPopoverPosition({
    open: workspaceMenuOpen,
    anchorRef: workspaceTriggerRef,
    popoverRef: workspaceMenuRef,
    preferredPlacement: 'top',
    alignment: 'start',
    gap: 7,
  });
  const trimmedPath = repositoryPath.trim();
  const label = workspaceLabel.trim();

  const { currentBranch, isRepository, repositoryTrustRequired, refreshBasic } = useGitState({
    repositoryPath: { workspaceId, repositoryPath: trimmedPath },
    layers: ['basic'],
    isActive: !deferPassiveGitRefresh,
    refreshOnMount: !deferPassiveGitRefresh,
    refreshOnActive: false,
    debugSource: 'chat_input_workspace_strip',
  });

  // Toggling worktree isolation moves the execution root under a live strip.
  // The shared Git cache holds nothing for the new directory, and useGitState
  // only auto-refreshes on mount, so ask for the new branch explicitly.
  const previousRepositoryPathRef = useRef(trimmedPath);
  useEffect(() => {
    if (previousRepositoryPathRef.current === trimmedPath) return;
    previousRepositoryPathRef.current = trimmedPath;
    if (trimmedPath) {
      void refreshBasic();
    }
  }, [refreshBasic, trimmedPath]);

  const showUsage = usageReport?.visible && !!usageReport.onOpen;
  const showPermission = !!permissionControl;
  const showDispatchResult = !!dispatchControl?.syncableJobId;
  const isWorktree = !!executionTarget?.worktreeId;
  const worktreeEnabled = worktreeControl?.enabled ?? isWorktree;
  const worktreeEnabledRef = useRef(worktreeEnabled);
  worktreeEnabledRef.current = worktreeEnabled;
  // Remote dispatch still requires Git, but the local execution target is a
  // useful breadcrumb for every workspace. In a plain folder the picker stays
  // visible and locked, so the strip does not lose its middle breadcrumb or
  // accidentally offer an unsupported remote action.
  //
  // A repository Git refuses to read for ownership reasons is still a
  // repository: `isRepository` only turns true after a status call the
  // ownership gate blocks, so leaving it out would hide the Git controls on
  // exactly the workspace whose problem the user has to act on.
  const isGitWorkspace = isRepository || repositoryTrustRequired || isWorktree || worktreeEnabled;
  const showWorktreeToggle = !!worktreeControl && isGitWorkspace;
  const showDispatchPicker = !!dispatchControl;
  const dispatchPickerLocked = !!dispatchControl && (dispatchControl.locked || !isGitWorkspace);
  const permissionModeLabels = {
    ask: t('chatInput.permissionMode.ask.label'),
    auto: t('chatInput.permissionMode.auto.label'),
    full_access: t('chatInput.permissionMode.fullAccess.label'),
    reject: t('chatInput.permissionMode.reject.label'),
    acp: t('chatInput.permissionMode.acp.label'),
  } satisfies Record<ChatInputPermissionMode, string>;
  const permissionCopy = {
    ask: {
      label: permissionModeLabels.ask,
      description: t('chatInput.permissionMode.ask.description'),
    },
    auto: {
      label: permissionModeLabels.auto,
      description: t('chatInput.permissionMode.auto.description'),
    },
    full_access: {
      label: permissionModeLabels.full_access,
      description: t('chatInput.permissionMode.fullAccess.description'),
    },
    reject: {
      label: permissionModeLabels.reject,
      description: t('chatInput.permissionMode.reject.description'),
    },
    acp: {
      label: permissionModeLabels.acp,
      description: t('chatInput.permissionMode.acp.tooltip'),
    },
  } satisfies Record<ChatInputPermissionMode, {
    label: string;
    description: string;
  }>;

  const closePermissionMenu = useCallback(() => {
    permissionMenuFocusTargetRef.current = null;
    setPermissionMenuOpen(false);
    setPermissionMenuView('session');
  }, []);

  const openPermissionTurnMenu = useCallback((focusTarget: string) => {
    permissionMenuFocusTargetRef.current = focusTarget;
    setPermissionMenuView('turn');
  }, []);

  const returnToPermissionSessionMenu = useCallback(() => {
    permissionMenuFocusTargetRef.current = 'chat-input-permission-turn-scope';
    setPermissionMenuView('session');
  }, []);

  useEffect(() => {
    if (!permissionMenuOpen || !permissionMenuFocusTargetRef.current) return;

    const focusTarget = permissionMenuFocusTargetRef.current;
    permissionMenuFocusTargetRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      permissionMenuRef.current
        ?.querySelector<HTMLButtonElement>(`[data-testid="${focusTarget}"]`)
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [permissionMenuOpen, permissionMenuView]);

  useEffect(() => {
    if (!permissionMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !permissionRootRef.current?.contains(target)
        && !permissionMenuRef.current?.contains(target)
      ) {
        closePermissionMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (permissionMenuView === 'turn') {
          returnToPermissionSessionMenu();
        } else {
          closePermissionMenu();
          permissionTriggerRef.current?.focus();
        }
      }
    };

    const removeOverlayPointerdown0 = subscribeOverlayInteraction(permissionMenuRef, 'pointerdown', handlePointerDown);
    const removeOverlayKeydown1 = subscribeOverlayInteraction(permissionMenuRef, 'keydown', handleKeyDown);
    return () => {
      removeOverlayPointerdown0?.();
      removeOverlayKeydown1?.();
    };
  }, [
    closePermissionMenu,
    permissionMenuOpen,
    permissionMenuView,
    returnToPermissionSessionMenu,
  ]);

  useEffect(() => {
    if (!workspaceMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !workspaceTriggerRef.current?.contains(target)
        && !workspaceMenuRef.current?.contains(target)
      ) {
        setWorkspaceMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkspaceMenuOpen(false);
      }
    };

    const removeOverlayPointerdown2 = subscribeOverlayInteraction(workspaceMenuRef, 'pointerdown', handlePointerDown);
    const removeOverlayKeydown3 = subscribeOverlayInteraction(workspaceMenuRef, 'keydown', handleKeyDown);
    return () => {
      removeOverlayPointerdown2?.();
      removeOverlayKeydown3?.();
    };
  }, [workspaceMenuOpen]);

  const dispatchBranch = dispatchControl?.locked
    && worktreeControl?.lockedReason === 'dispatch'
    ? dispatchControl?.branch?.trim()
    : undefined;
  // A managed worktree/dispatch branch is part of the session execution
  // target. Only the ordinary workspace branch is mutable from this strip;
  // changing a managed target behind its lifecycle owner would leave the
  // session binding and cleanup metadata describing a different checkout.
  const branchSwitchable = !dispatchBranch
    && !isWorktree
    && isRepository
    && !!currentBranch?.trim()
    && !!trimmedPath;

  useEffect(() => {
    setBranchMenuOpen(false);
  }, [branchSwitchable, currentBranch, trimmedPath]);

  const branchTooltipContent = useMemo(
    () =>
      dispatchBranch
        || (isRepository && currentBranch?.trim()
        ? currentBranch.trim()
        // "Not a Git repository" is the wrong answer for a repository Git
        // refused to read: the branch is unknown because the directory is owned
        // by someone else, and that is a state the user can clear.
        : repositoryTrustRequired
        ? t('workspaceStrip.branchTooltipUntrusted')
        : t('workspaceStrip.branchTooltipUnavailable')),
    [currentBranch, dispatchBranch, isRepository, repositoryTrustRequired, t],
  );

  const hasContextRail = !!label || showDispatchPicker;
  const hasNextRail = showPermission || showUsage || showDispatchResult;
  if (!hasContextRail && !hasNextRail) {
    return null;
  }

  const branchLabel = dispatchBranch
    || (branchSwitchable ? currentBranch?.trim() : undefined)
    || executionTarget?.branch?.trim()
    || (isWorktree && currentBranch?.trim())
    || (isWorktree && executionTarget?.baseCommit
      ? tWorktrees('labels.detached', { commit: executionTarget.baseCommit.slice(0, 9) })
      : isRepository && currentBranch?.trim()
      ? currentBranch.trim()
      : '—');

  const workspaceTooltipContent = trimmedPath || label;
  const switchableWorkspaces = workspaceContext?.openedWorkspacesList ?? [];
  // Same rule as the shell nav switcher: a single open workspace has nothing
  // to switch to, so the name stays a fact rather than offering a dead menu.
  const workspaceSwitchable = !!workspaceContext && switchableWorkspaces.length > 1;
  const worktreeToggleDisabled = !!worktreeControl?.locked;
  let worktreeTooltip = tWorktrees('strip.toggleOffDescription');
  if (worktreeControl?.lockedReason === 'dispatch') {
    worktreeTooltip = tWorktrees('strip.dispatchBaseline');
  } else if (worktreeControl?.locked) {
    worktreeTooltip = tWorktrees('strip.toggleLocked');
  } else if (worktreeEnabled && !isWorktree) {
    worktreeTooltip = tWorktrees('strip.togglePendingOnDescription');
  } else if (!worktreeEnabled && isWorktree) {
    worktreeTooltip = tWorktrees('strip.togglePendingOffDescription');
  } else if (isWorktree) {
    worktreeTooltip = tWorktrees('strip.toggleOnDescription', { path: trimmedPath });
  }
  const permissionMode = permissionControl?.mode ?? 'ask';
  const permissionModes = permissionControl?.options ?? NATIVE_PERMISSION_MODES;
  const permissionDisabled =
    permissionControl?.disabled
    || permissionControl?.saving
    || permissionMode === 'acp';
  const permissionOverridden = !!permissionControl?.overridden && permissionMode !== 'acp';
  const permissionNextTurnMode = permissionMode === 'acp'
    ? null
    : permissionControl?.nextTurnMode ?? null;
  const permissionNextTurnArmed = permissionNextTurnMode !== null;
  const permissionActiveTurn = permissionMode !== 'acp' && !!permissionControl?.activeTurn;
  // The trigger reports what the active turn (or the next submission while
  // idle) runs with, so a one-off outranks the session mode there.
  const permissionDisplayMode = permissionNextTurnMode ?? permissionMode;
  const permissionModeLabel = permissionCopy[permissionDisplayMode].label;
  const permissionTooltip = permissionMode === 'acp'
    ? t('chatInput.permissionMode.acp.tooltip')
    : permissionNextTurnArmed
      ? t(
          permissionActiveTurn
            ? 'chatInput.permissionMode.currentActiveTurnOverride'
            : 'chatInput.permissionMode.currentTurnOverride',
          { mode: permissionModeLabel },
        )
      : permissionOverridden
        ? t('chatInput.permissionMode.currentSessionOverride', { mode: permissionModeLabel })
      : t('chatInput.permissionMode.current', { mode: permissionModeLabel });
  const PermissionIcon = PERMISSION_MODE_ICONS[permissionDisplayMode];
  const PermissionSessionIcon = PERMISSION_MODE_ICONS[permissionMode];
  const permissionTurnScopeLabel = t(permissionActiveTurn
    ? 'chatInput.permissionMode.activeTurnScope'
    : 'chatInput.permissionMode.turnScope');
  const permissionSessionScopeLabel = permissionControl?.scopeLabel
    ?? t('chatInput.permissionMode.globalScope');
  const permissionTurnSettingsLabel = t(permissionActiveTurn
    ? 'chatInput.permissionMode.activeTurnSettings'
    : 'chatInput.permissionMode.turnSettings');
  const permissionMenuScopeLabel = permissionMenuView === 'session'
    ? permissionSessionScopeLabel
    : permissionTurnScopeLabel;
  const permissionTurnFocusTarget = permissionNextTurnMode
    && permissionNextTurnMode !== 'acp'
    && permissionModes.includes(permissionNextTurnMode)
    ? `chat-input-permission-next-turn-${permissionNextTurnMode}`
    : 'chat-input-permission-follow-session';
  const usageCurrentTokens = Number.isFinite(usageReport?.currentTokens)
    ? Math.max(0, Math.round(usageReport?.currentTokens ?? 0))
    : 0;
  const usageMaxTokens = Number.isFinite(usageReport?.maxTokens)
    ? Math.max(0, Math.round(usageReport?.maxTokens ?? 0))
    : 0;
  const usagePercentage = usageMaxTokens > 0
    ? Math.min(100, Math.max(0, Math.round((usageCurrentTokens / usageMaxTokens) * 100)))
    : 0;
  const usageTooltip = `${formatCompactTokenCount(usageCurrentTokens)}/${formatCompactTokenCount(usageMaxTokens)} ${usagePercentage}%`;
  const usageDash = `${((usagePercentage / 100) * 62.83).toFixed(2)} 62.83`;

  const handleWorktreeChange = (enabled: boolean) => {
    if (!worktreeControl || worktreeToggleDisabled) {
      return;
    }
    if (worktreeEnabledRef.current === enabled) {
      return;
    }
    worktreeEnabledRef.current = enabled;
    worktreeControl.onChange(enabled);
  };

  const handleWorktreeToggle = () => {
    handleWorktreeChange(!worktreeEnabledRef.current);
  };

  // The ordinary workspace branch doubles as a picker. Managed worktree and
  // detached-dispatch branches stay facts because their lifecycle owner must
  // remain the only writer of that execution target.
  const renderBranchChip = () => {
    const contents = (
      <>
        <Icon name="git" size="xs" className="openbitfun-chat-input-workspace-strip__branch-icon" aria-hidden />
        <span
          data-openbitfun-component="chat-input-workspace-strip"
          data-openbitfun-part="branch"
          className="openbitfun-chat-input-workspace-strip__branch"
        ><OverflowText>
          {branchLabel}
        </OverflowText></span>
      </>
    );

    if (!branchSwitchable || !currentBranch?.trim()) {
      return (
        <Tooltip content={branchTooltipContent} placement="top">
          <span className="openbitfun-chat-input-workspace-strip__chip openbitfun-chat-input-workspace-strip__chip--branch">
            {contents}
          </span>
        </Tooltip>
      );
    }

    return (
      <>
        <Tooltip content={branchTooltipContent} placement="top" disabled={branchMenuOpen}>
          <button
            ref={branchTriggerRef}
            type="button"
            className="openbitfun-chat-input-workspace-strip__chip openbitfun-chat-input-workspace-strip__chip--branch openbitfun-chat-input-workspace-strip__chip--branch-switchable"
            aria-label={t('workspaceStrip.branchSwitchLabel', { branch: branchLabel })}
            aria-haspopup="dialog"
            aria-expanded={branchMenuOpen}
            aria-controls={branchMenuOpen ? branchPickerId : undefined}
            data-testid="chat-input-branch-trigger"
            onClick={event => {
              event.stopPropagation();
              setBranchMenuOpen(open => !open);
            }}
          >
            {contents}
          </button>
        </Tooltip>
        <BranchQuickSwitch
          id={branchPickerId}
          isOpen={branchMenuOpen}
          onClose={() => setBranchMenuOpen(false)}
          repositoryPath={{ workspaceId, repositoryPath: trimmedPath }}
          currentBranch={currentBranch.trim()}
          anchorRef={branchTriggerRef}
          onSwitchSuccess={() => {
            void refreshBasic();
          }}
        />
      </>
    );
  };

  // The workspace names where the session lives; with more than one workspace
  // open it doubles as the switcher. Either way it wears the track's pill so
  // the row keeps one rhythm — only the hover fill says whether it answers.
  const renderWorkspaceControl = () => {
    if (!workspaceSwitchable || !workspaceContext) {
      return (
        <Tooltip content={workspaceTooltipContent} placement="top">
          <span data-openbitfun-component="chat-input-workspace-strip" data-openbitfun-part="workspace" className="openbitfun-chat-input-workspace-strip__workspace">
            <span className="openbitfun-chat-input-workspace-strip__workspace-name"><OverflowText>{label}</OverflowText></span>
          </span>
        </Tooltip>
      );
    }

    return (
      <>
        <Tooltip content={tCommon('header.switchWorkspace')} placement="top">
          <button data-overflow-trigger
            ref={workspaceTriggerRef}
            type="button"
            data-openbitfun-component="chat-input-workspace-strip"
            data-openbitfun-part="workspace"
            className="openbitfun-chat-input-workspace-strip__workspace openbitfun-chat-input-workspace-strip__workspace--switchable"
            aria-haspopup="menu"
            aria-expanded={workspaceMenuOpen}
            data-testid="chat-input-workspace-trigger"
            onClick={event => {
              event.stopPropagation();
              setWorkspaceMenuOpen(open => !open);
            }}
          >
            <span className="openbitfun-chat-input-workspace-strip__workspace-name"><OverflowText>{label}</OverflowText></span>
          </button>
        </Tooltip>
        {workspaceMenuOpen ? createOverlayPortal(
          <Menu
            ref={workspaceMenuRef}
            data-openbitfun-component="chat-input-workspace-strip"
            data-openbitfun-part="workspaceMenu"
            data-openbitfun-state="open"
            data-openbitfun-placement={workspaceMenuLayout?.placement ?? 'top'}
            className="openbitfun-chat-input-workspace-strip__workspace-menu"
            style={{
              top: `${workspaceMenuLayout?.top ?? 0}px`,
              left: `${workspaceMenuLayout?.left ?? 0}px`,
              visibility: workspaceMenuLayout ? 'visible' : 'hidden',
            }}
            aria-label={tCommon('header.switchWorkspace')}
            data-testid="chat-input-workspace-menu"
            autoFocusFirstItem
          >
            {switchableWorkspaces.map(workspace => {
              const isActive = workspace.id === workspaceContext.activeWorkspace?.id;
              const workspaceName = getWorkspaceDisplayName(workspace);
              const workspacePath = workspace.rootPath?.trim();
              const isAssistantWorkspace = workspace.workspaceKind === WorkspaceKind.Assistant;
              const isPrimaryAssistantWorkspace = (
                isAssistantWorkspace
                && (
                  workspace.id === workspaceContext.primaryAssistantWorkspaceId
                  || (!workspaceContext.primaryAssistantWorkspaceId && !workspace.assistantId)
                )
              );
              const workspaceDetail = isAssistantWorkspace
                ? t(isPrimaryAssistantWorkspace
                    ? 'workspaceStrip.primaryAssistant'
                    : 'workspaceStrip.personalAssistant')
                : workspacePath;
              return (
                <MenuItem data-overflow-trigger
                  key={workspace.id}
                  role="menuitemradio"
                  checked={isActive}
                  data-openbitfun-component="chat-input-workspace-strip"
                  data-openbitfun-part="workspaceOption"
                  data-openbitfun-state={isActive ? 'active' : undefined}
                  data-testid={`chat-input-workspace-option-${workspace.id}`}
                  aria-label={workspaceDetail
                    ? `${workspaceName}, ${workspaceDetail}`
                    : workspaceName}
                  title={workspaceDetail || workspaceName}
                  metadata={isActive ? <Icon name="check-line" size="lg" style={{ width: 13, height: 13 }} aria-hidden /> : null}
                  onClick={event => {
                    event.stopPropagation();
                    setWorkspaceMenuOpen(false);
                    if (!isActive) {
                      void workspaceContext.setActiveWorkspace(workspace.id);
                    }
                  }}
                >
                  <span className="openbitfun-chat-input-workspace-strip__workspace-option-copy">
                    <OverflowText className="openbitfun-chat-input-workspace-strip__workspace-option-name">
                      {workspaceName}
                    </OverflowText>
                    {workspaceDetail ? (
                      <OverflowText className="openbitfun-chat-input-workspace-strip__workspace-option-detail">
                        {workspaceDetail}
                      </OverflowText>
                    ) : null}
                  </span>
                </MenuItem>
              );
            })}
          </Menu>,
          getAppearanceOverlayHost(),
        ) : null}
      </>
    );
  };

  const renderWorktreeToggle = () => (showWorktreeToggle ? (
    <Tooltip content={worktreeTooltip} placement="top">
      <button
        type="button"
        role="switch"
        aria-checked={worktreeEnabled}
        aria-label={tWorktrees('strip.toggleLabel')}
        className={[
          'openbitfun-chat-input-workspace-strip__worktree-toggle',
          worktreeEnabled && 'openbitfun-chat-input-workspace-strip__worktree-toggle--on',
        ]
          .filter(Boolean)
          .join(' ')}
        disabled={worktreeToggleDisabled}
        data-testid="chat-input-worktree-toggle"
        data-worktree-enabled={worktreeEnabled ? 'true' : 'false'}
        data-worktree-materialized={isWorktree ? 'true' : 'false'}
        onClick={handleWorktreeToggle}
      >
        {worktreeEnabled ? (
          <SquareCheck size={12} strokeWidth={1.8} aria-hidden />
        ) : (
          <Square size={12} strokeWidth={1.8} aria-hidden />
        )}
        <span className="openbitfun-chat-input-workspace-strip__worktree-label">
          {tWorktrees('strip.toggleLabel')}
        </span>
      </button>
    </Tooltip>
  ) : null);

  // A hairline parts the workspace/branch coordinate from the execution
  // destination. Worktree isolation belongs inside the local destination
  // menu, so it no longer creates a third statement on this rail.
  const renderDivider = (key: string) => (
    <span
      key={key}
      data-openbitfun-component="chat-input-workspace-strip"
      data-openbitfun-part="divider"
      className="openbitfun-chat-input-workspace-strip__divider"
      aria-hidden
    />
  );

  const renderPermissionModeOption = (
    mode: Exclude<ChatInputPermissionMode, 'acp'>,
    selectionScope: 'session' | 'turn',
  ) => {
    const oneOff = selectionScope === 'turn';
    const selected = oneOff
      ? permissionNextTurnMode === mode
      : permissionMode === mode;
    const copy = permissionCopy[mode];
    const OptionIcon = PERMISSION_MODE_ICONS[mode];
    const accessibleLabel = oneOff
      ? t(permissionActiveTurn
          ? 'chatInput.permissionMode.activeTurnOnly'
          : 'chatInput.permissionMode.nextTurnOnly', {
          mode: copy.label,
        })
      : `${copy.label} — ${copy.description}`;
    const optionTestId = oneOff
      ? `chat-input-permission-next-turn-${mode}`
      : `chat-input-permission-option-${mode}`;
    const selectedTestId = oneOff
      ? `chat-input-permission-next-turn-selected-${mode}`
      : `chat-input-permission-selected-${mode}`;

    return (
      <Tooltip
        key={`${selectionScope}-${mode}`}
        content={copy.description}
        placement="left"
      >
        <MenuItem
          role="menuitemradio"
          checked={selected}
          aria-label={accessibleLabel}
          leading={(
            <OptionIcon
              size={13}
              strokeWidth={2}
              className={`openbitfun-chat-input-workspace-strip__permission-option-icon openbitfun-chat-input-workspace-strip__permission-option-icon--${mode}`}
              aria-hidden
            />
          )}
          metadata={selected ? (
            <Icon name="check-line" size="sm" data-testid={selectedTestId} aria-hidden />
          ) : null}
          disabled={permissionControl?.saving}
          data-testid={optionTestId}
          onClick={event => {
            event.stopPropagation();
            closePermissionMenu();
            if (oneOff) {
              if (!selected) void permissionControl?.onChangeForNextTurn?.(mode);
            } else {
              void permissionControl?.onChange?.(mode);
            }
          }}
        >
          {copy.label}
        </MenuItem>
      </Tooltip>
    );
  };

  return (
    <div data-openbitfun-component="chat-input-workspace-strip" data-openbitfun-part="root"
      className="openbitfun-chat-input-workspace-strip"
      data-testid="chat-input-workspace-strip"
    >
      <div
        data-openbitfun-component="chat-input-workspace-strip"
        data-openbitfun-part="context"
        className="openbitfun-chat-input-workspace-strip__context"
      >
        {label ? (
          <span className="openbitfun-chat-input-workspace-strip__location">
            {renderWorkspaceControl()}
            {isGitWorkspace ? renderBranchChip() : null}
          </span>
        ) : null}
        {showDispatchPicker && label ? renderDivider('context-target') : null}
        {showDispatchPicker && dispatchControl ? (
          <DispatchTargetPicker
            target={dispatchControl.target}
            sourceWorkspaceId={workspaceId} sourceWorkspacePath={dispatchControl.sourceWorkspacePath}
            locked={dispatchPickerLocked}
            localWorktreeControl={showWorktreeToggle && worktreeControl ? {
              enabled: worktreeEnabled,
              locked: worktreeToggleDisabled,
              label: tWorktrees('strip.newWorktree'),
              description: worktreeTooltip,
              onChange: handleWorktreeChange,
            } : undefined}
            onSelectLocal={dispatchControl.onSelectLocal}
            onSelectTarget={dispatchControl.onSelectTarget}
          />
        ) : null}
        {!showDispatchPicker && showWorktreeToggle
          ? renderDivider('context-isolation')
          : null}
        {!showDispatchPicker ? renderWorktreeToggle() : null}
      </div>

      <div
        data-openbitfun-component="chat-input-workspace-strip"
        data-openbitfun-part="next"
        className="openbitfun-chat-input-workspace-strip__next"
      >
        {dispatchControl?.syncableJobId ? (
          <>
            <Tooltip content={tCommon('dispatch.syncTitle')} placement="top">
              <button data-overflow-trigger
                type="button"
                className="openbitfun-chat-input-workspace-strip__dispatch-result"
                onClick={() => setResultDialogOpen(true)}
                data-testid="dispatch-sync-trigger"
              >
                <Icon name="refresh" size="xs" aria-hidden />
                <span><OverflowText>{tCommon('dispatch.syncAction')}</OverflowText></span>
              </button>
            </Tooltip>
            <DispatchResultDialog
              open={resultDialogOpen}
              jobId={dispatchControl.syncableJobId}
              branch={dispatchControl.branch}
              baselineWorktreePath={dispatchControl.baselineWorktreePath}
              baselineMissing={dispatchControl.baselineMissing}
              targetLabel={dispatchControl.target.kind !== 'local'
                ? (dispatchControl.target.kind === 'device' ? resolveDeviceName(dispatchControl.target.deviceId, dispatchControl.target.displayName) : dispatchControl.target.displayName)
                : undefined}
              onClose={() => setResultDialogOpen(false)}
            />
          </>
        ) : null}
        {showPermission && permissionControl ? (
          <div
            ref={permissionRootRef}
            data-openbitfun-component="chat-input-workspace-strip"
            data-openbitfun-part="permission"
            className="openbitfun-chat-input-workspace-strip__permission"
          >
            <Tooltip content={permissionTooltip} placement="top">
              <button data-overflow-trigger
                ref={permissionTriggerRef}
                type="button"
                className={[
                  'openbitfun-chat-input-workspace-strip__permission-trigger',
                  `openbitfun-chat-input-workspace-strip__permission-trigger--${permissionDisplayMode}`,
                  permissionMenuOpen && 'openbitfun-chat-input-workspace-strip__permission-trigger--open',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-label={permissionTooltip}
                aria-haspopup={permissionDisabled ? undefined : 'menu'}
                aria-expanded={permissionDisabled ? undefined : permissionMenuOpen}
                disabled={permissionDisabled}
                data-testid="chat-input-permission-trigger"
                data-permission-mode={permissionDisplayMode}
                data-permission-overridden={permissionOverridden ? 'true' : undefined}
                data-permission-next-turn={permissionNextTurnArmed ? 'true' : undefined}
                data-permission-active-turn={permissionActiveTurn ? 'true' : undefined}
                onClick={event => {
                  event.stopPropagation();
                  if (!permissionDisabled) {
                    if (permissionMenuOpen) {
                      closePermissionMenu();
                    } else {
                      setPermissionMenuView('session');
                      setPermissionMenuOpen(true);
                    }
                  }
                }}
              >
                <PermissionIcon
                  className="openbitfun-chat-input-workspace-strip__permission-overview-icon"
                  size={12}
                  strokeWidth={1.8}
                  aria-hidden
                />
                <span className="openbitfun-chat-input-workspace-strip__permission-label"><OverflowText>
                  {permissionModeLabel}
                </OverflowText></span>
                {/* Only a one-off override gets a dot: a session-level choice
                    is already legible from the label the trigger shows, and
                    marking both made every customized session look pending. */}
                {permissionNextTurnArmed ? (
                  <span
                    className="openbitfun-chat-input-workspace-strip__permission-next-turn-dot"
                    data-testid="chat-input-permission-next-turn-dot"
                    aria-hidden
                  />
                ) : null}
              </button>
            </Tooltip>

            {permissionMenuOpen && permissionMode !== 'acp' ? createOverlayPortal(
              <Menu
                ref={permissionMenuRef}
                data-openbitfun-component="chat-input-workspace-strip"
                data-openbitfun-part="permissionMenu"
                data-openbitfun-state="open"
                data-openbitfun-placement={permissionMenuLayout?.placement ?? 'top'}
                className="openbitfun-chat-input-workspace-strip__permission-menu"
                style={{
                  top: `${permissionMenuLayout?.top ?? 0}px`,
                  left: `${permissionMenuLayout?.left ?? 0}px`,
                  visibility: permissionMenuLayout ? 'visible' : 'hidden',
                }}
                aria-label={`${t('chatInput.permissionMode.menuLabel')} · ${permissionMenuScopeLabel}`}
                data-testid="chat-input-permission-menu"
                autoFocusFirstItem
                onKeyDown={event => {
                  if (
                    permissionMenuView === 'turn'
                    && (event.key === 'ArrowLeft' || event.key === 'Escape')
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    returnToPermissionSessionMenu();
                  }
                }}
              >
                {permissionMenuView === 'session' ? (
                  <>
                    <MenuSection
                      title={`${t('chatInput.permissionMode.menuLabel')} · ${permissionSessionScopeLabel}`}
                      data-openbitfun-component="chat-input-workspace-strip"
                      data-openbitfun-part="permissionOptions"
                    >
                      {permissionModes.map(mode => renderPermissionModeOption(mode, 'session'))}
                    </MenuSection>
                    {permissionControl.onChangeForNextTurn ? (
                      <>
                        <MenuSeparator />
                        <MenuItem
                          leading={<Icon name="clock" size="sm" aria-hidden />}
                          metadata={permissionNextTurnArmed ? permissionModeLabel : undefined}
                          shortcut={<Icon name="chevron-right" size="sm" aria-hidden />}
                          aria-haspopup="menu"
                          data-testid="chat-input-permission-turn-scope"
                          onClick={event => {
                            event.stopPropagation();
                            openPermissionTurnMenu(permissionTurnFocusTarget);
                          }}
                          onKeyDown={event => {
                            if (event.key !== 'ArrowRight') return;
                            event.preventDefault();
                            event.stopPropagation();
                            openPermissionTurnMenu(permissionTurnFocusTarget);
                          }}
                        >
                          {permissionTurnSettingsLabel}
                        </MenuItem>
                      </>
                    ) : null}
                    {permissionOverridden && permissionControl.onResetToDefault ? (
                      <>
                        <MenuSeparator />
                        <MenuItem
                          data-testid="chat-input-permission-reset-default"
                          disabled={permissionControl.saving}
                          actions={permissionControl.onOpenDefaultSettings ? [{
                            id: 'open-default-settings',
                            label: t('chatInput.permissionMode.openDefaultSettings'),
                            icon: <Icon name="gear" size="lg" style={{ width: 13, height: 13 }} aria-hidden />,
                            testId: 'chat-input-permission-open-default-settings',
                            onClick: event => {
                              event.stopPropagation();
                              closePermissionMenu();
                              permissionControl.onOpenDefaultSettings?.();
                            },
                          }] : []}
                          onClick={event => {
                            event.stopPropagation();
                            closePermissionMenu();
                            void permissionControl.onResetToDefault?.();
                          }}
                        >
                          {t('chatInput.permissionMode.resetToDefault')}
                        </MenuItem>
                      </>
                    ) : null}
                  </>
                ) : (
                  <MenuSection
                    title={`${t('chatInput.permissionMode.menuLabel')} · ${permissionTurnScopeLabel}`}
                    data-openbitfun-component="chat-input-workspace-strip"
                    data-openbitfun-part="permissionOptions"
                  >
                    <MenuItem
                      leading={<Icon name="chevron-left" size="sm" aria-hidden />}
                      metadata={permissionCopy[permissionMode].label}
                      aria-label={t('chatInput.permissionMode.backToSessionSettings')}
                      data-testid="chat-input-permission-turn-back"
                      onClick={event => {
                        event.stopPropagation();
                        returnToPermissionSessionMenu();
                      }}
                    >
                      {permissionSessionScopeLabel}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      role="menuitemradio"
                      checked={!permissionNextTurnArmed}
                      aria-label={`${t('chatInput.permissionMode.followSessionMode')} — ${permissionCopy[permissionMode].label}`}
                      leading={(
                        <PermissionSessionIcon
                          size={13}
                          strokeWidth={2}
                          className={`openbitfun-chat-input-workspace-strip__permission-option-icon openbitfun-chat-input-workspace-strip__permission-option-icon--${permissionMode}`}
                          aria-hidden
                        />
                      )}
                      metadata={!permissionNextTurnArmed ? (
                        <Icon name="check-line" size="sm" data-testid="chat-input-permission-follow-session-selected" aria-hidden />
                      ) : null}
                      disabled={permissionControl.saving}
                      data-testid="chat-input-permission-follow-session"
                      onClick={event => {
                        event.stopPropagation();
                        closePermissionMenu();
                        if (permissionNextTurnMode && permissionNextTurnMode !== 'acp') {
                          void permissionControl.onChangeForNextTurn?.(permissionNextTurnMode);
                        }
                      }}
                    >
                      {t('chatInput.permissionMode.followSessionMode')}
                    </MenuItem>
                    {permissionModes.map(mode => renderPermissionModeOption(mode, 'turn'))}
                  </MenuSection>
                )}
              </Menu>,
              getAppearanceOverlayHost(),
            ) : null}
          </div>
        ) : null}
        {showUsage ? (
          <Tooltip content={usageTooltip}>
            <button
              data-openbitfun-component="chat-input-workspace-strip"
              data-openbitfun-part="usageAction"
              className="openbitfun-chat-input-workspace-strip__usage-btn"
              type="button"
              aria-label={t('usage.runtime.open')}
              onClick={e => {
                e.stopPropagation();
                usageReport.onOpen();
              }}
            >
              <span className="openbitfun-chat-input-workspace-strip__usage-ring" aria-hidden>
                <Circle className="is-track" size={12} strokeWidth={3.2} />
                {usagePercentage > 0 ? (
                  <Circle
                    className="is-value"
                    size={12}
                    strokeWidth={3.2}
                    strokeDasharray={usageDash}
                  />
                ) : null}
              </span>
            </button>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
};

ChatInputWorkspaceStrip.displayName = 'ChatInputWorkspaceStrip';
