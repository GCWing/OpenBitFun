import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, Square } from 'lucide-react';
import { OverflowText, Spinner, Tooltip } from '@openbitfun/ui';
import { RetainedMountBoundary } from '@/shared/presence';
import { sessionAPI, type SessionLineageSnapshot } from '@/infrastructure/api/service-api/SessionAPI';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { computeFixedPopoverPosition } from '@/shared/utils/fixedPopoverViewport';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { flowChatStore } from '../../store/FlowChatStore';
import {
  buildSessionLineageTree,
  collectExpandedRunningBranches,
  countSessionLineageDescendants,
  filterActiveSessionLineageTree,
  type SessionLineageLifecycle,
  type SessionLineageNode,
} from '../../utils/sessionLineage';
import {
  formatAgentIdForDisplay,
  SubagentAvatar,
} from '../../subagent-identity';
import './SessionTreePopover.scss';
import { IconButton, Menu, MenuItem, Icon } from '@openbitfun/ui';

export interface SessionTreeSelection {
  sessionId: string;
  parentSessionId?: string;
  parentToolCallId?: string;
  title: string;
  displayTitle: string;
  agentType?: string;
  subagentType?: string;
  agentId?: string;
  /** Owning workspace ID; authoritative when present. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  isRoot: boolean;
}

interface SessionTreePopoverProps {
  sessionId?: string;
  fallbackWorkspaceId?: string;
  hasActiveDescendants?: boolean;
  onSelectSession?: (selection: SessionTreeSelection) => void;
  onCancelSession?: (selection: SessionTreeSelection) => Promise<boolean>;
  onDeleteSession?: (selection: SessionTreeSelection) => Promise<boolean>;
  /** Render the tree inside a parent-owned popover instead of creating another trigger and surface. */
  embedded?: boolean;
  activeOnly?: boolean;
  /** Whether an embedded tree is active and should load live data. */
  open?: boolean;
  /** Ask the parent-owned popover to close after a selection or keyboard dismissal. */
  onRequestClose?: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function lifecycleLabel(
  lifecycle: SessionLineageLifecycle,
  t: SessionTreePopoverProps['t'],
): string {
  return t(`flowChatHeader.agentTreeStatus.${lifecycle}`);
}

function nodeHasActiveWork(node: SessionLineageNode): boolean {
  return node.lifecycle === 'running' || node.lifecycle === 'finishing';
}

function nodeDisplayTitle(node: SessionLineageNode): string {
  return !node.isRoot && node.agentId
    ? formatAgentIdForDisplay(node.agentId)
    : node.title;
}

export const SessionTreePopover: React.FC<SessionTreePopoverProps> = ({
  sessionId,
  fallbackWorkspaceId,
  hasActiveDescendants = false,
  onSelectSession,
  onCancelSession,
  onDeleteSession,
  embedded = false,
  activeOnly = false,
  open = false,
  onRequestClose,
  t,
}) => {
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const [keyboardNavigationOpen, setKeyboardNavigationOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<SessionLineageSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [liveRevision, setLiveRevision] = useState(0);
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(new Set());
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(new Set());
  const [openActionSessionId, setOpenActionSessionId] = useState<string | null>(null);
  const [cancellingSessionIds, setCancellingSessionIds] = useState<Set<string>>(new Set());
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const actionMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const requestGenerationRef = useRef(0);
  const [actionMenuPosition, setActionMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const isOpen = embedded ? open : internalIsOpen;

  const refreshSnapshot = useCallback(async () => {
    if (!sessionId) return;
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    const session = flowChatStore.getState().sessions.get(sessionId);
    const workspaceId = session?.workspaceId || session?.config.workspaceId || fallbackWorkspaceId;
    if (!workspaceId) {
      if (requestGeneration === requestGenerationRef.current) setLoadFailed(true);
      return;
    }

    setIsLoading(true);
    setLoadFailed(false);
    try {
      const nextSnapshot = await sessionAPI.getSessionLineage({
        sessionId,
        workspaceId,
      });
      if (requestGeneration === requestGenerationRef.current) {
        setSnapshot(nextSnapshot);
      }
    } catch {
      if (requestGeneration === requestGenerationRef.current) {
        setLoadFailed(true);
      }
    } finally {
      if (requestGeneration === requestGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, [fallbackWorkspaceId, sessionId]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    setInternalIsOpen(false);
    setKeyboardNavigationOpen(false);
    setSnapshot(null);
    setLoadFailed(false);
    setExpandedSessionIds(new Set());
    setCollapsedSessionIds(new Set());
    setOpenActionSessionId(null);
    setCancellingSessionIds(new Set());
    setActionMenuPosition(null);
  }, [sessionId]);

  const closePopover = useCallback((source: 'keyboard' | 'pointer' | 'selection') => {
    const activeElement = document.activeElement;
    const focusIsInside = Boolean(
      activeElement
      && (
        panelRef.current?.contains(activeElement)
        || actionMenuRef.current?.contains(activeElement)
      ),
    );

    if (source === 'pointer') {
      setKeyboardNavigationOpen(false);
    }
    if (!embedded && (source === 'keyboard' || source === 'selection' || focusIsInside)) {
      triggerRef.current?.focus();
    }

    if (embedded) {
      onRequestClose?.();
    } else {
      setInternalIsOpen(false);
    }
    setOpenActionSessionId(null);
    setActionMenuPosition(null);
  }, [embedded, onRequestClose]);

  useEffect(() => {
    if (!isOpen) return;
    void refreshSnapshot();

    let frameId: number | null = null;
    const unsubscribe = flowChatStore.subscribe(() => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        setLiveRevision(revision => revision + 1);
      });
    });
    return () => {
      unsubscribe();
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [isOpen, refreshSnapshot]);

  useEffect(() => {
    if (!isOpen) return;
    if (embedded) {
      const handleEmbeddedPointerDown = (event: MouseEvent) => {
        const target = event.target as Node;
        if (
          openActionSessionId &&
          !actionMenuRef.current?.contains(target) &&
          !actionMenuAnchorRef.current?.contains(target)
        ) {
          setOpenActionSessionId(null);
          setActionMenuPosition(null);
        }
      };
      document.addEventListener('mousedown', handleEmbeddedPointerDown);
      return () => document.removeEventListener('mousedown', handleEmbeddedPointerDown);
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (
        !containerRef.current?.contains(event.target as Node) &&
        !panelRef.current?.contains(event.target as Node) &&
        !actionMenuRef.current?.contains(event.target as Node)
      ) {
        closePopover('pointer');
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePopover('keyboard');
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closePopover, embedded, isOpen, openActionSessionId]);

  const updateActionMenuPosition = useCallback(() => {
    const anchor = actionMenuAnchorRef.current;
    if (!anchor) return;

    const menu = actionMenuRef.current;
    const position = computeFixedPopoverPosition(
      anchor.getBoundingClientRect(),
      menu?.offsetWidth ?? 150,
      menu?.offsetHeight ?? 40,
      4,
      8,
    );
    setActionMenuPosition(position);
  }, []);

  useLayoutEffect(() => {
    if (!openActionSessionId) {
      setActionMenuPosition(null);
      return;
    }

    updateActionMenuPosition();
    window.addEventListener('resize', updateActionMenuPosition);
    window.addEventListener('scroll', updateActionMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateActionMenuPosition);
      window.removeEventListener('scroll', updateActionMenuPosition, true);
    };
  }, [openActionSessionId, updateActionMenuPosition]);

  const tree = useMemo(() => {
    void liveRevision;
    if (!sessionId) return null;
    return buildSessionLineageTree(
      sessionId,
      snapshot,
      flowChatStore.getState().sessions,
    );
  }, [liveRevision, sessionId, snapshot]);

  const visibleTree = useMemo(() => activeOnly ? filterActiveSessionLineageTree(tree) : tree, [activeOnly, tree]);
  const descendantCount = countSessionLineageDescendants(visibleTree);
  const panelLayout = useAnchoredPopoverPosition({
    open: isOpen && !embedded,
    anchorRef: triggerRef,
    popoverRef: panelRef,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 8,
    layoutRevision: `${descendantCount}:${isLoading}:${loadFailed}`,
  });
  const retainedPanelLayoutRef = useRef(panelLayout);
  if (panelLayout) {
    retainedPanelLayoutRef.current = panelLayout;
  }
  const renderedPanelLayout = panelLayout ?? retainedPanelLayoutRef.current;

  useEffect(() => {
    if (!tree) return;
    const defaults = collectExpandedRunningBranches(tree);
    setExpandedSessionIds(previous => {
      const next = new Set(previous);
      defaults.forEach(sessionId => {
        if (!collapsedSessionIds.has(sessionId)) {
          next.add(sessionId);
        }
      });
      return next.size === previous.size ? previous : next;
    });
  }, [collapsedSessionIds, tree]);

  const toggleExpanded = useCallback((targetSessionId: string) => {
    const isExpanded = expandedSessionIds.has(targetSessionId);
    setExpandedSessionIds(previous => {
      const next = new Set(previous);
      if (isExpanded) next.delete(targetSessionId);
      else next.add(targetSessionId);
      return next;
    });
    setCollapsedSessionIds(previous => {
      const next = new Set(previous);
      if (isExpanded) next.add(targetSessionId);
      else next.delete(targetSessionId);
      return next;
    });
  }, [expandedSessionIds]);

  const handleSelect = useCallback((node: SessionLineageNode) => {
    const selection = {
      sessionId: node.sessionId,
      parentSessionId: node.parentSessionId,
      parentToolCallId: node.parentToolCallId,
      title: node.title,
      displayTitle: nodeDisplayTitle(node),
      agentType: node.agentType,
      subagentType: node.subagentType,
      agentId: node.agentId,
      workspaceId: node.workspaceId,
      workspacePath: node.workspacePath,
      remoteConnectionId: node.remoteConnectionId,
      remoteSshHost: node.remoteSshHost,
      isRoot: node.isRoot,
    } satisfies SessionTreeSelection;
    onSelectSession?.(selection);
    closePopover('selection');
  }, [closePopover, onSelectSession]);

  const handleActionMenuToggle = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    node: SessionLineageNode,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (node.isRoot || (!onDeleteSession && (!onCancelSession || !nodeHasActiveWork(node)))) return;

    if (openActionSessionId === node.sessionId) {
      setOpenActionSessionId(null);
      setActionMenuPosition(null);
      return;
    }

    actionMenuAnchorRef.current = event.currentTarget;
    setOpenActionSessionId(node.sessionId);
    updateActionMenuPosition();
  }, [onCancelSession, onDeleteSession, openActionSessionId, updateActionMenuPosition]);

  const handleDelete = useCallback(async (node: SessionLineageNode) => {
    if (!onDeleteSession || node.isRoot || deletingSessionId) return;
    const scope = getActiveSurfaceScope();
    setOpenActionSessionId(null);
    setActionMenuPosition(null);
    setDeletingSessionId(node.sessionId);
    try {
      await onDeleteSession({ ...node, displayTitle: nodeDisplayTitle(node) });
    } finally {
      setDeletingSessionId(null);
      if (scope.isCurrent()) await refreshSnapshot();
    }
  }, [deletingSessionId, onDeleteSession, refreshSnapshot]);

  const handleCancel = useCallback(async (node: SessionLineageNode) => {
    if (!onCancelSession || node.isRoot || !nodeHasActiveWork(node)) return;
    if (cancellingSessionIds.has(node.sessionId)) return;

    const selection = {
      sessionId: node.sessionId,
      parentSessionId: node.parentSessionId,
      parentToolCallId: node.parentToolCallId,
      title: node.title,
      displayTitle: nodeDisplayTitle(node),
      agentType: node.agentType,
      subagentType: node.subagentType,
      agentId: node.agentId,
      workspaceId: node.workspaceId,
      workspacePath: node.workspacePath,
      remoteConnectionId: node.remoteConnectionId,
      remoteSshHost: node.remoteSshHost,
      isRoot: node.isRoot,
    } satisfies SessionTreeSelection;

    setOpenActionSessionId(null);
    setActionMenuPosition(null);
    setCancellingSessionIds(previous => new Set(previous).add(node.sessionId));
    try {
      await onCancelSession(selection);
    } finally {
      setCancellingSessionIds(previous => {
        const next = new Set(previous);
        next.delete(node.sessionId);
        return next;
      });
    }
  }, [cancellingSessionIds, onCancelSession]);

  const renderNode = (node: SessionLineageNode, depth: number): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedSessionIds.has(node.sessionId);
    const isCancelling = cancellingSessionIds.has(node.sessionId);
    const statusLabel = isCancelling
      ? t('flowChatHeader.agentTreeCancelling')
      : lifecycleLabel(node.lifecycle, t);
    const secondaryLabel = node.subagentType || node.agentType;
    const primaryLabel = nodeDisplayTitle(node);
    const nodeMeta = secondaryLabel;
    const canCancel = !!onCancelSession && !node.isRoot && nodeHasActiveWork(node);
    const canDelete = !!onDeleteSession && !node.isRoot;

    return (
      <React.Fragment key={node.sessionId}>
        <div
          className={[
            'session-tree-popover__node',
            node.isRoot && 'session-tree-popover__node--root',
            !node.isRoot && 'session-tree-popover__node--subagent',
            nodeHasActiveWork(node) && 'session-tree-popover__node--active',
            isCancelling && 'session-tree-popover__node--cancelling',
          ].filter(Boolean).join(' ')}
          data-openbitfun-component="flow-chat-header"
          data-openbitfun-part="sessionTreeNode"
          data-openbitfun-status={node.lifecycle}
          data-openbitfun-state={isCancelling ? 'cancelling' : undefined}
          data-session-id={node.sessionId}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={hasChildren ? isExpanded : undefined}
          style={{ paddingLeft: `${(embedded ? 0 : 6) + Math.min(depth, 10) * 14}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              className="session-tree-popover__expand"
              onClick={() => toggleExpanded(node.sessionId)}
              aria-label={isExpanded
                ? t('flowChatHeader.agentTreeCollapse')
                : t('flowChatHeader.agentTreeExpand')}
            >
              {isExpanded ? <Icon name="chevron-down" size="xs" /> : <Icon name="chevron-right" size="xs" />}
            </button>
          ) : (
            <span className="session-tree-popover__expand-spacer" aria-hidden="true" />
          )}
          <button data-overflow-trigger
            type="button"
            className="session-tree-popover__node-main"
            onClick={() => handleSelect(node)}
            aria-label={node.isRoot
              ? undefined
              : [primaryLabel, secondaryLabel, statusLabel]
                  .filter(Boolean)
                  .join(', ')}
          >
            {node.isRoot
              ? <MessageSquare size={13} aria-hidden="true" />
              : (
                  <SubagentAvatar
                    sessionId={node.sessionId}
                    name={primaryLabel}
                    size={embedded ? 24 : 28}
                    status={node.lifecycle}
                  />
                )}
            <span className="session-tree-popover__node-copy">
              <OverflowText
                className="session-tree-popover__node-title"
                data-openbitfun-component="flow-chat-header"
                data-openbitfun-part="sessionTreeNodeTitle"
              >
                {primaryLabel}
              </OverflowText>
              {nodeMeta ? (
                <OverflowText className="session-tree-popover__node-meta">{nodeMeta}</OverflowText>
              ) : null}
            </span>
          </button>
          {canCancel || canDelete ? (
            <div className="session-tree-popover__node-actions">
              <Tooltip content={t('flowChatHeader.agentTreeActions')}>
                <IconButton
                  className="session-tree-popover__action-menu-button"
                  size="sm"
                  onClick={(event) => handleActionMenuToggle(event, node)}
                  aria-label={t('flowChatHeader.agentTreeActions')}
                  aria-haspopup="menu"
                  aria-expanded={openActionSessionId === node.sessionId}
                  disabled={isCancelling || deletingSessionId !== null}
                  icon={<Icon name="more" size="lg" style={{ width: 13, height: 13 }} aria-hidden="true" />}
                />
              </Tooltip>
              {openActionSessionId === node.sessionId && actionMenuPosition ? createPortal(
                <Menu
                  ref={actionMenuRef}
                  className="session-tree-popover__action-menu"
                  data-openbitfun-component="flow-chat-header"
                  data-openbitfun-part="sessionTreeMenu"
                  data-openbitfun-native-webview-occlusion
                  aria-label={t('flowChatHeader.agentTreeActions')}
                  style={actionMenuPosition}
                  data-testid="flowchat-header-session-tree-menu"
                >
                  {canCancel ? <MenuItem
                    type="button"
                    tone="danger"
                    data-openbitfun-component="flow-chat-header"
                    data-openbitfun-part="sessionTreeMenuItem"
                    onClick={() => void handleCancel(node)}
                    disabled={isCancelling}
                    leading={<Square size={12} aria-hidden="true" />}
                  >
                    <span>{isCancelling
                      ? t('flowChatHeader.agentTreeCancelling')
                      : t('flowChatHeader.agentTreeCancel')}</span>
                  </MenuItem> : null}
                  {canDelete ? <MenuItem
                    type="button"
                    tone="danger"
                    onClick={() => void handleDelete(node)}
                    disabled={deletingSessionId !== null}
                    leading={<Icon name="delete" size="sm" />}
                  >
                    {t('flowChatHeader.agentTreeDelete')}
                  </MenuItem> : null}
                </Menu>,
                getAppearanceOverlayHost(),
              ) : null}
            </div>
          ) : null}
          {node.isRoot ? (
            <span
              className={`session-tree-popover__status session-tree-popover__status--${node.lifecycle}`}
              title={statusLabel}
              aria-label={statusLabel}
            />
          ) : null}
        </div>
        {hasChildren && isExpanded ? node.children.map(child => renderNode(child, depth + 1)) : null}
      </React.Fragment>
    );
  };

  const panelLabel = t('flowChatHeader.agentTree');
  const renderedTreeNodes = visibleTree
    ? embedded
      ? visibleTree.children.map(child => renderNode(child, 0))
      : renderNode(visibleTree, 0)
    : null;

  const treeBody = (
    <div
      className="session-tree-popover__body"
      data-openbitfun-component="flow-chat-header"
      data-openbitfun-part="sessionTreeBody"
    >
      {visibleTree ? <div role="tree">{renderedTreeNodes}</div> : null}
      {isLoading && !tree ? (
        <div
          className="session-tree-popover__state"
          data-openbitfun-component="flow-chat-header"
          data-openbitfun-part="sessionTreeState"
          data-openbitfun-state="loading"
          aria-live="polite"
        >
          <Spinner size="sm" />
          <span>{t('flowChatHeader.agentTreeLoading')}</span>
        </div>
      ) : null}
      {!isLoading && !loadFailed && tree && descendantCount === 0 ? (
        <div
          className="session-tree-popover__state"
          data-openbitfun-component="flow-chat-header"
          data-openbitfun-part="sessionTreeState"
          data-openbitfun-state="empty"
        >
          {t(activeOnly ? 'flowChatHeader.agentTreeNoActive' : 'flowChatHeader.agentTreeEmpty')}
        </div>
      ) : null}
      {loadFailed ? (
        <div
          className="session-tree-popover__state session-tree-popover__state--error"
          data-openbitfun-component="flow-chat-header"
          data-openbitfun-part="sessionTreeState"
          data-openbitfun-state="error"
        >
          <span>{t('flowChatHeader.agentTreeLoadFailed')}</span>
          <Tooltip content={t('flowChatHeader.agentTreeRetry')}>
            <IconButton
              size="sm"
              onClick={() => void refreshSnapshot()}
              aria-label={t('flowChatHeader.agentTreeRetry')}
              icon={<Icon name="refresh" size="lg" style={{ width: 13, height: 13 }} />}
            />
          </Tooltip>
        </div>
      ) : null}
    </div>
  );

  if (embedded) {
    return (
      <div
        className="session-tree-popover session-tree-popover--embedded"
        ref={containerRef}
        data-openbitfun-component="flow-chat-header"
        data-openbitfun-part="sessionTree"
        data-testid="flowchat-header-session-tree-content"
      >
        {treeBody}
      </div>
    );
  }

  return (
    <div
      className="session-tree-popover"
      ref={containerRef}
      data-openbitfun-component="flow-chat-header"
      data-openbitfun-part="sessionTree"
    >
      <Tooltip content={panelLabel}>
        <IconButton
          ref={triggerRef}
          className={[
            'session-tree-popover__trigger',
            isOpen && 'session-tree-popover__trigger--active',
            hasActiveDescendants && 'session-tree-popover__trigger--has-activity',
          ].filter(Boolean).join(' ')}
          data-openbitfun-component="flow-chat-header"
          data-openbitfun-part="sessionTreeTrigger"
          data-openbitfun-state={[
            isOpen ? 'open' : null,
            hasActiveDescendants ? 'active' : null,
          ].filter(Boolean).join(' ') || undefined}
          size="sm"
          onClick={(event) => {
            const nextOpen = !isOpen;
            if (nextOpen) {
              setKeyboardNavigationOpen(event.detail === 0);
              setInternalIsOpen(true);
            } else {
              if (event.detail !== 0) {
                setKeyboardNavigationOpen(false);
              }
              closePopover(event.detail === 0 ? 'keyboard' : 'pointer');
            }
          }}
          aria-label={panelLabel}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          disabled={!sessionId}
          data-testid="flowchat-header-session-tree"
          icon={<span className="session-tree-popover__trigger-inner">
            <Icon name="user" size="sm" />
            {hasActiveDescendants ? (
              <span className="session-tree-popover__status-dot" aria-hidden="true" />
            ) : null}
          </span>}
        />
      </Tooltip>

      <RetainedMountBoundary present={isOpen}>
        {createPortal(
          <div
          ref={panelRef}
          className="session-tree-popover__panel"
          data-openbitfun-component="flow-chat-header"
          data-openbitfun-part="sessionTreePanel"
          data-openbitfun-placement={renderedPanelLayout?.placement ?? 'bottom'}
          data-open={isOpen ? 'true' : 'false'}
          data-keyboard-open={keyboardNavigationOpen ? 'true' : 'false'}
          role="dialog"
          aria-label={panelLabel}
          aria-hidden={!isOpen}
          {...(!isOpen ? { inert: '' } : {})}
          style={{
            top: `${renderedPanelLayout?.top ?? 0}px`,
            left: `${renderedPanelLayout?.left ?? 0}px`,
            visibility: renderedPanelLayout ? 'visible' : 'hidden',
          }}
        >
          <div
            className="session-tree-popover__header"
            data-openbitfun-component="flow-chat-header"
            data-openbitfun-part="sessionTreeHeader"
          >
            <span>{panelLabel}</span>
            <span>{descendantCount + (tree ? 1 : 0)}</span>
          </div>
          {treeBody}
          </div>,
          getAppearanceOverlayHost(),
        )}
      </RetainedMountBoundary>
    </div>
  );
};

SessionTreePopover.displayName = 'SessionTreePopover';
