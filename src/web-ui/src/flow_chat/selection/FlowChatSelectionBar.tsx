import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createOverlayPortal,
  Button, Card, Icon, ToolbarGroup, ToolbarSeparator, useDismissibleLayer,
} from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isTauriRuntime } from '@/infrastructure/runtime';
import type { FixedPopoverPlacement } from '@/shared/utils/fixedPopoverViewport';
import { flowChatStore } from '../store/FlowChatStore';
import { resolveSessionDriverId } from '../session-drivers/resolve';
import { isAcpFlowSession } from '../utils/acpSession';
import { captureFlowChatSelection, type CapturedFlowChatSelection } from './flowChatSelection';
import {
  computeSelectionBarPosition, measureExcerptEditorGeometry, measureSelectionBarGeometry,
  sameFlowChatSelection, sameSelectionBarAnchor, type SelectionBarGeometry,
} from './flowChatSelectionPosition';
import { requestExcerptAction } from './excerptActions';
import { ConversationExcerptFloatingEditor } from './ConversationExcerptFloatingEditor';
import './ConversationExcerpt.scss';
import { highlightExcerptRange } from './locateConversationExcerpt';
import { contextMenuRegistry } from '@/shared/context-menu-system/core/ContextMenuRegistry';
import { useContextMenuStore } from '@/shared/context-menu-system/store/ContextMenuStore';
import { notificationService } from '@/shared/notification-system';
import { useSelectionToolbarPreference } from '@/infrastructure/config/hooks/useSelectionToolbarPreference';

export function FlowChatSelectionBar({ rootRef, sessionId, parentSessionId, active = true, onSelectionIntent }: {
  rootRef: RefObject<HTMLElement | null>;
  sessionId?: string;
  parentSessionId?: string;
  active?: boolean;
  onSelectionIntent?: () => void;
}) {
  const { t } = useI18n('flow-chat');
  const peer = usePeerDeviceModeOptional();
  const { enabled: autoShowToolbar } = useSelectionToolbarPreference();
  const autoShowToolbarRef = useRef(autoShowToolbar);
  autoShowToolbarRef.current = autoShowToolbar;
  const menuId = useId();
  const popupRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<CapturedFlowChatSelection | null>(null);
  const [editing, setEditing] = useState(false);
  const [editorGeometry, setEditorGeometry] = useState<SelectionBarGeometry | null>(null);
  const toolbarGeometryRef = useRef<SelectionBarGeometry | null>(null);
  const [comment, setComment] = useState('');
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const lastCapturedRef = useRef<CapturedFlowChatSelection | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const intentRef = useRef(onSelectionIntent);
  intentRef.current = onSelectionIntent;
  const beginEditing = useCallback((captured: CapturedFlowChatSelection, geometry: SelectionBarGeometry | null) => {
    const root = rootRef.current;
    // Snapshot coordinates before focus or menu dismissal can replace the source DOM.
    setEditorGeometry(geometry ?? (root && measureExcerptEditorGeometry(root, captured)));
    // The transient selection toolbar unmounts when the editor opens.
    rootRef.current?.focus({ preventScroll: true });
    setEditing(true);
  }, [rootRef]);
  const clear = useCallback(() => {
    const focused = rootRef.current?.ownerDocument.activeElement;
    if (!editingRef.current && popupRef.current?.contains(focused ?? null)) {
      rootRef.current?.focus({ preventScroll: true });
    }
    setSelection(null); setPosition(null); setEditing(false); setComment(''); setEditorGeometry(null);
    toolbarGeometryRef.current = null;
  }, [rootRef]);
  const scope = getActiveSurfaceScope();
  const sourceSession = sessionId ? flowChatStore.getState().sessions.get(sessionId) : undefined;
  const child = sourceSession?.sessionKind === 'btw';
  const canAsk = Boolean(sourceSession?.workspacePath && !isAcpFlowSession(sourceSession)
    && resolveSessionDriverId(sourceSession.sessionId, sourceSession) !== 'dispatch'
    && (peer?.peerMode.active ? peer.currentPeerCapabilities?.hostKind === 'desktop' : isTauriRuntime())
    && (!parentSessionId || child));

  useDismissibleLayer({ enabled: !!selection && active && !editing && autoShowToolbar === true, layerRef: popupRef, onDismiss: clear });

  useEffect(() => {
    if (autoShowToolbar !== true && !editingRef.current) clear();
  }, [autoShowToolbar, clear]);

  useEffect(() => {
    clear();
    lastCapturedRef.current = null;
    const root = rootRef.current;
    if (!active || !sessionId || !root) return;
    const owner = root.ownerDocument;
    let frame = 0;
    let pressed = false;
    let startedInRoot = false;
    let changedDuringPress = false;
    let claimedSelection = false;
    const readSelection = () => {
      const session = flowChatStore.getState().sessions.get(sessionId);
      if (!session || !scope.isCurrent()) return null;
      return captureFlowChatSelection(root, owner.getSelection(), {
        surfaceId: scope.surfaceId, sessionId, sessionName: session.title || t('session.untitled'),
        workspaceId: session.workspaceId, workspacePath: session.workspacePath,
        remoteConnectionId: session.remoteConnectionId, remoteSshHost: session.remoteSshHost,
      });
    };
    const capture = () => {
      frame = 0;
      if (autoShowToolbarRef.current !== true || pressed || editingRef.current || useContextMenuStore.getState().visible
        || popupRef.current?.contains(owner.activeElement)) return;
      if (sameFlowChatSelection(lastCapturedRef.current, owner.getSelection())) return;
      const next = readSelection();
      lastCapturedRef.current = next;
      setSelection(next);
      setPosition(null);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(capture); };
    const selectionChanged = () => {
      if (editingRef.current) return;
      if (pressed) changedDuringPress = true;
      const nativeSelection = owner.getSelection();
      if (!claimedSelection && nativeSelection && !nativeSelection.isCollapsed
        && root.contains(nativeSelection.anchorNode) && !popupRef.current?.contains(owner.activeElement)
        && readSelection()) {
        claimedSelection = true;
        intentRef.current?.();
      }
      schedule();
    };
    const pointerDown = (event: PointerEvent) => {
      if (editingRef.current || popupRef.current?.contains(event.target as Node)) return;
      pressed = event.button === 0;
      startedInRoot = pressed && root.contains(event.target as Node);
      changedDuringPress = false;
      claimedSelection = false;
      if (startedInRoot) clear();
    };
    const pointerUp = () => {
      const captureGesture = pressed && startedInRoot;
      pressed = false;
      startedInRoot = false;
      if (!captureGesture || editingRef.current) return;
      // A deliberate reselection can have the same endpoints as the previous quote.
      if (changedDuringPress) lastCapturedRef.current = null;
      schedule();
    };
    const pointerCancel = () => {
      const cancelGesture = pressed && startedInRoot;
      pressed = false; startedInRoot = false;
      if (!cancelGesture || editingRef.current) return;
      cancelAnimationFrame(frame); frame = 0;
      lastCapturedRef.current = readSelection();
      clear();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing || editingRef.current) return;
      const next = readSelection();
      if (!next) return;
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (canAsk) {
          requestExcerptAction(next.excerpt, parentSessionId || sessionId, 'ask');
          owner.getSelection()?.removeAllRanges();
          clear();
        } else notificationService.warning(t('selection.sideUnsupported'));
      } else if (event.key === 'Tab' && !event.shiftKey && !popupRef.current?.contains(owner.activeElement)) {
        const firstAction = popupRef.current?.querySelector<HTMLButtonElement>('button');
        if (firstAction) { event.preventDefault(); firstAction.focus(); }
      }
    };
    const closeOnScroll = (event: Event) => {
      if (editingRef.current) return;
      const target = event.target;
      const captured = lastCapturedRef.current;
      if (target === owner || (target instanceof Element
        && (target.contains(root) || (captured && (target.contains(captured.focusNode) || target.contains(captured.anchorNode)))))) {
        cancelAnimationFrame(frame); frame = 0;
        clear();
      }
    };
    const closeOnResize = () => {
      if (editingRef.current) return;
      cancelAnimationFrame(frame); frame = 0;
      clear();
    };
    contextMenuRegistry.register({
      id: menuId, name: t('selection.actions'), priority: 110,
      matcher: context => root.contains(context.targetElement) && !!readSelection(),
      menuBuilder: () => {
        const next = readSelection();
        if (!next) return [];
        const geometry = measureExcerptEditorGeometry(root, next);
        clear();
        return [
          { id: `${menuId}-annotate`, label: t(parentSessionId ? 'selection.addToMain' : 'selection.annotate'),
            icon: 'Pencil', onClick: () => {
              if (!scope.isCurrent()) return;
              setSelection(next); beginEditing(next, geometry); setPosition(null);
            } },
          { id: `${menuId}-ask`, label: t(child ? 'selection.askHere' : 'selection.askSide'),
            icon: 'MessageSquarePlus', disabled: !canAsk,
            onClick: () => {
              if (!scope.isCurrent()) return;
              requestExcerptAction(next.excerpt, parentSessionId || sessionId, 'ask');
              owner.getSelection()?.removeAllRanges();
            } },
        ];
      },
    });
    owner.addEventListener('selectionchange', selectionChanged);
    owner.addEventListener('pointerdown', pointerDown);
    // A text-selection drag still belongs to this transcript when released in
    // its gutters or over another element that stops bubbling pointer events.
    owner.addEventListener('pointerup', pointerUp, true);
    owner.addEventListener('pointercancel', pointerCancel, true);
    owner.addEventListener('keydown', keyDown, true);
    owner.addEventListener('scroll', closeOnScroll, true);
    owner.defaultView?.addEventListener('resize', closeOnResize);
    owner.defaultView?.visualViewport?.addEventListener('resize', closeOnResize);
    owner.defaultView?.visualViewport?.addEventListener('scroll', closeOnResize);
    root.dataset.flowchatExcerptReady = sessionId;
    return () => {
      delete root.dataset.flowchatExcerptReady;
      cancelAnimationFrame(frame);
      contextMenuRegistry.unregister(menuId);
      owner.removeEventListener('selectionchange', selectionChanged);
      owner.removeEventListener('pointerdown', pointerDown);
      owner.removeEventListener('pointerup', pointerUp, true);
      owner.removeEventListener('pointercancel', pointerCancel, true);
      owner.removeEventListener('keydown', keyDown, true);
      owner.removeEventListener('scroll', closeOnScroll, true);
      owner.defaultView?.removeEventListener('resize', closeOnResize);
      owner.defaultView?.visualViewport?.removeEventListener('resize', closeOnResize);
      owner.defaultView?.visualViewport?.removeEventListener('scroll', closeOnResize);
    };
  }, [active, sessionId, scope, rootRef, clear, beginEditing, t, parentSessionId, canAsk, child, menuId]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (autoShowToolbar !== true || !selection || editing || !popupRef.current || !root) return;
    const popup = popupRef.current;
    const initial = measureSelectionBarGeometry(root, selection);
    if (!initial) { clear(); return; }
    const selectedText = selection.range.toString();
    let placement: FixedPopoverPlacement | undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const geometry = measureSelectionBarGeometry(root, selection);
      if (!geometry || !sameSelectionBarAnchor(initial, geometry) || selection.range.toString() !== selectedText) return clear();
      const next = computeSelectionBarPosition(geometry, popup.getBoundingClientRect(), placement);
      if (!next) return clear();
      toolbarGeometryRef.current = geometry;
      placement = next.placement;
      setPosition(previous => previous?.left === next.left && previous.top === next.top ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(popup);
    for (const node of [selection.anchorNode, selection.focusNode]) {
      for (let element = node instanceof Element ? node : node.parentElement; element; element = element.parentElement) {
        observer.observe(element);
        if (element === root) break;
      }
    }
    const mutation = new MutationObserver(schedule);
    mutation.observe(root, { childList: true, characterData: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-openbitfun-viewport-inset-bottom'] });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); mutation.disconnect(); };
  }, [selection, editing, autoShowToolbar, clear, rootRef]);

  useEffect(() => {
    if (!editing || !selection) return;
    return highlightExcerptRange(selection.range);
  }, [editing, selection]);

  const submit = (action: 'annotate' | 'ask') => {
    if (!selection || !scope.isCurrent() || !sessionId) return;
    requestExcerptAction({ ...selection.excerpt, comment: comment.trim() || undefined },
      parentSessionId || sessionId, action);
    if (editing) rootRef.current?.focus({ preventScroll: true });
    rootRef.current?.ownerDocument.getSelection()?.removeAllRanges();
    clear();
  };

  return (
    <>
      {selection && active && !editing && autoShowToolbar === true && createOverlayPortal(
        <Card appearance="raised" radius="lg" data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="root"
          ref={popupRef} className="conversation-excerpt__popover" data-flowchat-selection-ignore="true" data-openbitfun-native-webview-occlusion
          style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}>
          <div data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="toolbar">
            <ToolbarGroup className="conversation-excerpt__toolbar" role="group" aria-label={t('selection.actions')}>
              <Button size="sm" variant="text" className="conversation-excerpt__action"
                data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="action"
                leadingIcon={<Icon name="edit" />} onClick={() => beginEditing(selection, toolbarGeometryRef.current)} aria-haspopup="dialog">
                {t('selection.annotate')}
              </Button>
              <ToolbarSeparator />
              <Button size="sm" variant="text" className="conversation-excerpt__action"
                data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="action"
                leadingIcon={<Icon name="side-chat" />} disabled={!canAsk}
                title={!canAsk ? t('selection.sideUnsupported') : undefined} onClick={() => submit('ask')}>
                {t(child ? 'selection.askHere' : 'selection.askSide')}
              </Button>
            </ToolbarGroup>
          </div>
        </Card>, getAppearanceOverlayHost(), undefined, { ownerRef: rootRef },
      )}
      {selection && editing && active && <ConversationExcerptFloatingEditor rootRef={rootRef} selection={selection}
        initialGeometry={editorGeometry}
        comment={comment} onCommentChange={setComment} onClose={clear} onSubmit={() => submit('annotate')}
        parentSessionId={parentSessionId} />}
    </>
  );
}
