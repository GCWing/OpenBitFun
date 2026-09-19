/**
 * Toolbar Mode component.
 * Single-window morph UI for compact toolbar view.
 *
 * Two window states:
 * - Collapsed: a compact status strip (latest activity + confirm/cancel controls).
 * - Expanded: ConversationModeSurface matches the Hello bubble's text/voice
 *   capability shell, while ChatPane renders the same FlowChat conversation
 *   and ChatInput composer the session scene uses. This mode therefore owns no
 *   parallel conversation, composer, or realtime-voice implementation.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { subscribeOverlayInteraction, createOverlayPortal, IconButton, OverflowText, Menu, MenuItem } from '@openbitfun/ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Square, Maximize2, MoreVertical, PanelTopOpen, PanelTopClose } from 'lucide-react';
import { useToolbarModeContext } from './ToolbarModeContext';
import { type FlowToolItem } from '../../types/flow-chat';
import { projectEffectiveToolItem } from '../../utils/toolInvocationIdentity';
import { createLogger } from '@/shared/utils/logger';
import { isMacOSDesktopRuntime } from '@/infrastructure/runtime';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { SessionMenu, useFlowChatSessions } from '../session-menu';
import {
  ConversationModeSurface,
} from '../voice/ConversationModeSurface';
import { useRealtimeVoiceCall } from '../voice/RealtimeVoiceCallContext';

const log = createLogger('ToolbarMode');
import ChatPane from '@/app/scenes/session/ChatPane';
import { Tooltip, Icon } from '@openbitfun/ui';
import './ToolbarMode.scss';

export const ToolbarMode: React.FC = () => {
  const { t } = useTranslation('flow-chat');
  const { t: tVoice } = useTranslation('settings/voice-input');
  const {
    isToolbarMode,
    isExpanded,
    disableToolbarMode,
    toggleExpanded,
    toolbarState
  } = useToolbarModeContext();

  const [showHeaderOverflowMenu, setShowHeaderOverflowMenu] = useState(false);
  const headerOverflowTriggerRef = useRef<HTMLButtonElement>(null);
  const headerOverflowRef = useRef<HTMLDivElement>(null);
  const headerOverflowLayout = useAnchoredPopoverPosition({
    open: showHeaderOverflowMenu,
    anchorRef: headerOverflowTriggerRef,
    popoverRef: headerOverflowRef,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 4,
  });

  const isMacOS = useMemo(() => isMacOSDesktopRuntime(), []);
  const { workspacePath } = useCurrentWorkspace();
  const { activeSession, sessionTitle } = useFlowChatSessions();
  const { phase: voicePhase, end: endVoiceCall } = useRealtimeVoiceCall();
  const isVoiceMode = voicePhase !== 'idle';
  const surfaceTitle = isVoiceMode ? tVoice('voiceCall.call.title') : sessionTitle;

  const lastMessageContent = useMemo(() => {
    if (!activeSession || !activeSession.dialogTurns || activeSession.dialogTurns.length === 0) {
      return null;
    }

    const lastTurn = activeSession.dialogTurns[activeSession.dialogTurns.length - 1];

    // Prefer the last text item in the latest model round.
    if (lastTurn.modelRounds && lastTurn.modelRounds.length > 0) {
      const lastRound = lastTurn.modelRounds[lastTurn.modelRounds.length - 1];
      for (let i = lastRound.items.length - 1; i >= 0; i--) {
        const item = lastRound.items[i];
        if (item.type === 'text' && 'content' in item) {
          const content = (item as any).content as string;
          const lines = content.trim().split('\n');
          return lines[lines.length - 1].trim() || lines[lines.length - 2]?.trim() || content.slice(-100);
        }
      }
    }

    // Fallback to the user's latest message.
    return lastTurn.userMessage?.content || null;
  }, [activeSession]);

  // Derive current streaming state from session data.
  const currentStreamState = useMemo(() => {
    if (!activeSession || !activeSession.dialogTurns || activeSession.dialogTurns.length === 0) {
      return { isStreaming: false, toolName: null, content: null };
    }

    const lastTurn = activeSession.dialogTurns[activeSession.dialogTurns.length - 1];

    const isStreaming =
      lastTurn.status === 'processing' ||
      lastTurn.status === 'finishing' ||
      lastTurn.status === 'image_analyzing';

    if (!isStreaming || !lastTurn.modelRounds || lastTurn.modelRounds.length === 0) {
      return { isStreaming, toolName: null, content: null };
    }

    const lastRound = lastTurn.modelRounds[lastTurn.modelRounds.length - 1];

    let toolName: string | null = null;
    let content: string | null = null;

    for (let i = lastRound.items.length - 1; i >= 0; i--) {
      const item = lastRound.items[i];

      if (item.type === 'tool' && 'toolName' in item) {
        const effectiveItem = projectEffectiveToolItem(item as FlowToolItem);
        toolName = effectiveItem.toolName;
        if (effectiveItem.toolCall?.input && typeof effectiveItem.toolCall.input === 'object') {
          const input = effectiveItem.toolCall.input;
          content = input.path || input.command || input.query || input.content || t('toolCards.toolbar.executing');
        } else {
          content = t('toolCards.toolbar.executing');
        }
        break;
      }

      if (item.type === 'text' && 'content' in item && !toolName) {
        const textContent = (item as any).content as string;
        const lines = textContent.trim().split('\n');
        content = lines[lines.length - 1].trim() || lines[lines.length - 2]?.trim() || textContent.slice(-100);
      }
    }

    return { isStreaming, toolName, content };
  }, [activeSession, t]);

  useEffect(() => {
    if (!isExpanded) {
      setShowHeaderOverflowMenu(false);
    }
  }, [isExpanded]);

  useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (headerOverflowRef.current?.contains(target)) {
        return;
      }
      if (target.closest?.('.openbitfun-toolbar-mode__overflow-trigger')) {
        return;
      }
      setShowHeaderOverflowMenu(false);
    };

    if (showHeaderOverflowMenu) {
      const timer = setTimeout(() => {
        removeOverlayMousedown0 = subscribeOverlayInteraction(headerOverflowRef, 'mousedown', handleClickOutside);
      }, 0);
      return () => {
        clearTimeout(timer);
        removeOverlayMousedown0?.();
      };
    }
  }, [showHeaderOverflowMenu]);

  const handleStartDrag = useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Avoid dragging when interacting with UI controls.
    const isCallHeader = target.closest?.('[data-openbitfun-component="voice-call-panel"] [data-openbitfun-part="header"]');
    if (target.closest?.('button, input') || (!isCallHeader && target.closest?.(
      'button, input, .openbitfun-session-menu, .openbitfun-toolbar-mode__overflow-menu, .openbitfun-toolbar-mode__stream-content, .openbitfun-toolbar-mode__session-surface'
    ))) {
      return;
    }
    try {
      const win = getCurrentWindow();
      await win.startDragging();
    } catch (error) {
      log.error('Failed to start dragging', error);
    }
  }, []);

  const handleExpand = useCallback(async () => {
    if (isVoiceMode) endVoiceCall();
    await disableToolbarMode();
  }, [disableToolbarMode, endVoiceCall, isVoiceMode]);

  const handleToggleExpanded = useCallback(async () => {
    if (isExpanded && isVoiceMode) endVoiceCall();
    await toggleExpanded();
  }, [endVoiceCall, isExpanded, isVoiceMode, toggleExpanded]);

  const handleCancel = useCallback(() => {
    window.dispatchEvent(new CustomEvent('toolbar-cancel-task'));
  }, []);

  const handleConfirm = useCallback(() => {
    if (toolbarState.pendingToolId) {
      window.dispatchEvent(new CustomEvent('toolbar-tool-confirm', {
        detail: { toolId: toolbarState.pendingToolId }
      }));
    }
  }, [toolbarState.pendingToolId]);

  const handleReject = useCallback(() => {
    if (toolbarState.pendingToolId) {
      window.dispatchEvent(new CustomEvent('toolbar-tool-reject', {
        detail: { toolId: toolbarState.pendingToolId }
      }));
    }
  }, [toolbarState.pendingToolId]);

  const toggleHeaderOverflowMenu = useCallback(() => {
    if (!isExpanded) return;
    setShowHeaderOverflowMenu(v => !v);
  }, [isExpanded]);

  const handleSessionMenuOpenChange = useCallback((open: boolean) => {
    if (open) setShowHeaderOverflowMenu(false);
  }, []);

  if (!isToolbarMode) {
    return null;
  }

  const containerClassName = [
    'openbitfun-toolbar-mode',
    isExpanded && 'openbitfun-toolbar-mode--expanded',
    currentStreamState.isStreaming && 'openbitfun-toolbar-mode--processing',
    toolbarState.hasError && 'openbitfun-toolbar-mode--error',
    toolbarState.hasPendingConfirmation && 'openbitfun-toolbar-mode--confirm',
    isMacOS && 'openbitfun-toolbar-mode--macos',
  ].filter(Boolean).join(' ');

  return (
    <div data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="root" data-openbitfun-communication-mode={isExpanded && isVoiceMode ? 'voice' : 'chat'} data-openbitfun-state={[
      isExpanded && 'expanded',
      currentStreamState.isStreaming && 'processing',
      toolbarState.hasError && 'error',
      toolbarState.hasPendingConfirmation && 'confirm',
    ].filter(Boolean).join(' ') || undefined} className={containerClassName} onMouseDown={handleStartDrag}>
      {!(isExpanded && isVoiceMode) && <div className="openbitfun-toolbar-mode__header" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="header">
        <div className="openbitfun-toolbar-mode__header-left" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="headerLeft">
          {isExpanded ? <SessionMenu onOpenChange={handleSessionMenuOpenChange} /> : null}
        </div>

        <div className="openbitfun-toolbar-mode__title-wrapper" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="title">
          <div className="openbitfun-toolbar-mode__title-display" title={surfaceTitle}>
            <OverflowText className="openbitfun-toolbar-mode__title-text">{surfaceTitle}</OverflowText>
          </div>
        </div>

        <div className="openbitfun-toolbar-mode__header-right" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="headerActions">
          <div className="openbitfun-toolbar-mode__header-drag-area" aria-hidden="true" />
          <div className="openbitfun-toolbar-mode__header-overflow">
            {isExpanded ? (
              <>
                <Tooltip content={t('toolCards.toolbar.moreMenu')}>
                  <IconButton
                    ref={headerOverflowTriggerRef}
                    type="button"
                    className="toolbar-btn toolbar-btn--overflow openbitfun-toolbar-mode__overflow-trigger"
                    data-openbitfun-product-component="toolbar-mode"
                    data-openbitfun-product-part="overflowTrigger"
                    data-openbitfun-state={showHeaderOverflowMenu ? 'open' : undefined}
                    onClick={toggleHeaderOverflowMenu}
                    aria-expanded={showHeaderOverflowMenu}
                    aria-haspopup="menu"
                    aria-label={t('toolCards.toolbar.moreMenu')}
                    icon={<MoreVertical size={14} />}
                  />
                </Tooltip>
                {showHeaderOverflowMenu && createOverlayPortal(
                  <Menu
                    ref={headerOverflowRef}
                    className="openbitfun-toolbar-mode__overflow-menu"
                    data-openbitfun-product-component="toolbar-mode"
                    data-openbitfun-product-part="overflowMenu"
                    data-openbitfun-state="open"
                    data-openbitfun-placement={headerOverflowLayout?.placement ?? 'bottom'}
                    style={{
                      top: `${headerOverflowLayout?.top ?? 0}px`,
                      left: `${headerOverflowLayout?.left ?? 0}px`,
                      visibility: headerOverflowLayout ? 'visible' : 'hidden',
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <MenuItem
                      type="button"
                      leading={<PanelTopClose size={14} />}
                      data-openbitfun-product-component="toolbar-mode"
                      data-openbitfun-product-part="overflowItem"
                      onClick={() => {
                        void handleToggleExpanded();
                        setShowHeaderOverflowMenu(false);
                      }}
                    >
                      <span>{t('toolCards.toolbar.collapseChat')}</span>
                    </MenuItem>
                    <MenuItem
                      type="button"
                      leading={<Maximize2 size={14} />}
                      data-openbitfun-product-component="toolbar-mode"
                      data-openbitfun-product-part="overflowItem"
                      onClick={() => {
                        void handleExpand();
                        setShowHeaderOverflowMenu(false);
                      }}
                    >
                      <span>{t('session.restoreMain')}</span>
                    </MenuItem>
                  </Menu>,
                  getAppearanceOverlayHost(),
                )}
              </>
            ) : (
              <div className="openbitfun-toolbar-mode__header-collapsed-actions" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="collapsedActions">
                <Tooltip content={t('toolCards.toolbar.expandChat')}>
                  <IconButton
                    type="button"
                    className="toolbar-btn toolbar-btn--overflow"
                    onClick={() => void handleToggleExpanded()}
                    aria-label={t('toolCards.toolbar.expandChat')}
                    icon={<PanelTopOpen size={14} />}
                  />
                </Tooltip>
                <Tooltip content={t('session.restoreMain')}>
                  <IconButton
                    type="button"
                    className="toolbar-btn toolbar-btn--expand"
                    onClick={() => void handleExpand()}
                    aria-label={t('session.restoreMain')}
                    icon={<Maximize2 size={14} />}
                  />
                </Tooltip>
              </div>
            )}
          </div>
        </div>
      </div>}

      {isExpanded ? (
        /* ConversationModeSurface is also used by the Hello bubble. It owns
           text/voice mode while ChatPane remains the one shared chat surface. */
        <div
          className="openbitfun-toolbar-mode__session-surface"
          data-openbitfun-product-component="toolbar-mode"
          data-openbitfun-product-part="sessionSurface"
        >
          <ConversationModeSurface onCloseVoice={handleToggleExpanded} switchTestId="toolbar-realtime-voice-mode-switch">
            <ChatPane
              width={0}
              isFullscreen={false}
              isSceneActive
              workspacePath={workspacePath}
              showChatInput
            />
          </ConversationModeSurface>
        </div>
      ) : (
        <div className="openbitfun-toolbar-mode__content-row" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="content">
          <div data-overflow-trigger className="openbitfun-toolbar-mode__stream-content" onClick={() => void handleToggleExpanded()} data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="stream" data-openbitfun-content-kind={currentStreamState.toolName ? 'tool' : toolbarState.todoProgress && toolbarState.todoProgress.total > 0 ? 'todo' : 'text'} data-openbitfun-state={currentStreamState.isStreaming ? 'streaming' : undefined}>
            {currentStreamState.toolName ? (
              <div className="openbitfun-toolbar-mode__tool" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="tool">
                <span className="openbitfun-toolbar-mode__tool-name" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="toolName">{currentStreamState.toolName}</span>
                <OverflowText className="openbitfun-toolbar-mode__tool-summary" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="toolSummary">{currentStreamState.content || t('toolCards.toolbar.executing')}</OverflowText>
              </div>
            ) : toolbarState.todoProgress && toolbarState.todoProgress.total > 0 ? (
              <div className="openbitfun-toolbar-mode__todo" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="todo">
                <span className="openbitfun-toolbar-mode__todo-progress" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="todoProgress">
                  {toolbarState.todoProgress.completed}/{toolbarState.todoProgress.total}
                </span>
                <OverflowText className="openbitfun-toolbar-mode__todo-current" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="todoCurrent">
                  {toolbarState.todoProgress.current || currentStreamState.content}
                </OverflowText>
              </div>
            ) : (
              <OverflowText className={`openbitfun-toolbar-mode__text ${currentStreamState.isStreaming ? 'openbitfun-toolbar-mode__text--streaming' : ''}`} data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="streamText">
                {currentStreamState.content || (currentStreamState.isStreaming ? t('toolCards.toolbar.processing') : (lastMessageContent || t('toolCards.toolbar.startNewChat')))}
              </OverflowText>
            )}
          </div>

          <div className="openbitfun-toolbar-mode__controls" data-openbitfun-product-component="toolbar-mode" data-openbitfun-product-part="controls">
            {toolbarState.hasPendingConfirmation && (
              <>
                <Tooltip content={t('toolCards.common.confirm')}>
                  <IconButton className="toolbar-btn toolbar-btn--confirm" onClick={handleConfirm}
                    aria-label={t('toolCards.common.confirm')}
                    icon={<Icon name="check-line" size="md" />}
                  />
                </Tooltip>
                <Tooltip content={t('toolCards.common.cancel')}>
                  <IconButton className="toolbar-btn toolbar-btn--reject" onClick={handleReject}
                    aria-label={t('toolCards.common.cancel')}
                    icon={<Icon name="xmark" size="md" />}
                  />
                </Tooltip>
              </>
            )}

            {currentStreamState.isStreaming && !toolbarState.hasPendingConfirmation && (
              <Tooltip content={t('planner.cancel')}>
                <IconButton className="toolbar-btn toolbar-btn--cancel-compact" onClick={handleCancel}
                  aria-label={t('planner.cancel')}
                  icon={<Square size={12} />}
                />
              </Tooltip>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export interface ToolbarModeProps {
  visible?: boolean;
  onExpandToFull?: () => void;
  className?: string;
}

export default ToolbarMode;
