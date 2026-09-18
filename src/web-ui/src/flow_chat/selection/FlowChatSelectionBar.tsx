import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  Button, Card, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading,
  DialogTitle, Icon, ToolbarGroup, ToolbarSeparator, useDismissibleLayer,
} from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { computeFixedPopoverPositionInViewport } from '@/shared/utils/fixedPopoverViewport';
import { flowChatStore } from '../store/FlowChatStore';
import { resolveSessionDriverId } from '../session-drivers/resolve';
import { isAcpFlowSession } from '../utils/acpSession';
import { captureFlowChatSelection, type CapturedFlowChatSelection } from './flowChatSelection';
import { requestExcerptAction } from './excerptActions';
import { ConversationExcerptEditor } from './ConversationExcerptEditor';
import './ConversationExcerpt.scss';
import { highlightExcerptRange } from './locateConversationExcerpt';
import { contextMenuRegistry } from '@/shared/context-menu-system/core/ContextMenuRegistry';
import { useContextMenuStore } from '@/shared/context-menu-system/store/ContextMenuStore';
import { notificationService } from '@/shared/notification-system';

export function FlowChatSelectionBar({ rootRef, sessionId, parentSessionId, active = true, onSelectionIntent }: {
  rootRef: RefObject<HTMLElement | null>;
  sessionId?: string;
  parentSessionId?: string;
  active?: boolean;
  onSelectionIntent?: () => void;
}) {
  const { t } = useI18n('flow-chat');
  const peer = usePeerDeviceModeOptional();
  const menuId = useId();
  const popupRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const [selection, setSelection] = useState<CapturedFlowChatSelection | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const intentRef = useRef(onSelectionIntent);
  intentRef.current = onSelectionIntent;
  const clear = useCallback(() => {
    const focused = rootRef.current?.ownerDocument.activeElement;
    if (popupRef.current?.contains(focused ?? null) || editorRef.current?.contains(focused ?? null)) {
      rootRef.current?.focus({ preventScroll: true });
    }
    setSelection(null); setEditing(false); setComment('');
  }, [rootRef]);
  const scope = getActiveSurfaceScope();
  const sourceSession = sessionId ? flowChatStore.getState().sessions.get(sessionId) : undefined;
  const child = sourceSession?.sessionKind === 'btw';
  const canAsk = Boolean(sourceSession?.workspacePath && !isAcpFlowSession(sourceSession)
    && resolveSessionDriverId(sourceSession.sessionId, sourceSession) !== 'dispatch'
    && (peer?.peerMode.active ? peer.currentPeerCapabilities?.hostKind === 'desktop' : isTauriRuntime())
    && (!parentSessionId || child));

  useDismissibleLayer({ enabled: !!selection && active && !editing, layerRef: popupRef, onDismiss: clear });

  useEffect(() => {
    clear();
    const root = rootRef.current;
    if (!active || !sessionId || !root) return;
    const owner = root.ownerDocument;
    let frame = 0;
    let pressed = false;
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
      if (pressed || editingRef.current || useContextMenuStore.getState().visible
        || popupRef.current?.contains(owner.activeElement)) return;
      const next = readSelection();
      setSelection(next);
      setPosition(null);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(capture); };
    const selectionChanged = () => {
      if (editingRef.current) return;
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
      if (popupRef.current?.contains(event.target as Node)) return;
      pressed = event.button === 0;
      claimedSelection = false;
    };
    const pointerUp = () => { pressed = false; if (!editingRef.current) schedule(); };
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
      if (!editingRef.current && !popupRef.current?.contains(event.target as Node)) clear();
    };
    const closeOnResize = () => { if (!editingRef.current) clear(); };
    contextMenuRegistry.register({
      id: menuId, name: t('selection.actions'), priority: 110,
      matcher: context => root.contains(context.targetElement) && !!readSelection(),
      menuBuilder: () => {
        const next = readSelection();
        if (!next) return [];
        clear();
        return [
          { id: `${menuId}-annotate`, label: t(parentSessionId ? 'selection.addToMain' : 'selection.annotate'),
            icon: 'Pencil', onClick: () => {
              if (!scope.isCurrent()) return;
              setSelection(next); setEditing(true); setPosition(null);
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
    owner.addEventListener('pointerup', pointerUp);
    owner.addEventListener('pointercancel', pointerUp);
    owner.addEventListener('keydown', keyDown, true);
    owner.addEventListener('scroll', closeOnScroll, true);
    owner.defaultView?.addEventListener('resize', closeOnResize);
    root.dataset.flowchatExcerptReady = sessionId;
    return () => {
      delete root.dataset.flowchatExcerptReady;
      cancelAnimationFrame(frame);
      contextMenuRegistry.unregister(menuId);
      owner.removeEventListener('selectionchange', selectionChanged);
      owner.removeEventListener('pointerdown', pointerDown);
      owner.removeEventListener('pointerup', pointerUp);
      owner.removeEventListener('pointercancel', pointerUp);
      owner.removeEventListener('keydown', keyDown, true);
      owner.removeEventListener('scroll', closeOnScroll, true);
      owner.defaultView?.removeEventListener('resize', closeOnResize);
    };
  }, [active, sessionId, scope, rootRef, clear, t, parentSessionId, canAsk, child, menuId]);

  useLayoutEffect(() => {
    if (!selection || editing || !popupRef.current) return;
    const popup = popupRef.current;
    const update = () => {
      if (!selection.range.startContainer.isConnected) return clear();
      const rects = selection.range.getClientRects();
      const anchor = rects[rects.length - 1] ?? selection.range.getBoundingClientRect();
      const rect = popup.getBoundingClientRect();
      setPosition(computeFixedPopoverPositionInViewport(anchor, rect.width, rect.height,
        { width: window.innerWidth, height: window.innerHeight }, { preferredPlacement: 'top', gap: 8 }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(popup);
    return () => observer.disconnect();
  }, [selection, editing, clear]);

  useEffect(() => {
    if (!editing || !selection) return;
    return highlightExcerptRange(selection.range);
  }, [editing, selection]);

  useEffect(() => {
    if (!editing || !active) return;
    // Context menus restore their own focus when closing. Focus the visible
    // editor after that commit as well as Dialog's initial focus placement.
    const frame = requestAnimationFrame(() => commentRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [editing, active]);

  const submit = (action: 'annotate' | 'ask') => {
    if (!selection || !scope.isCurrent() || !sessionId) return;
    requestExcerptAction({ ...selection.excerpt, comment: comment.trim() || undefined },
      parentSessionId || sessionId, action);
    rootRef.current?.ownerDocument.getSelection()?.removeAllRanges();
    clear();
  };

  return (
    <>
      {selection && active && !editing && createPortal(
        <Card appearance="raised" radius="lg" data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="root"
          ref={popupRef} className="conversation-excerpt__popover" data-flowchat-selection-ignore="true" data-openbitfun-native-webview-occlusion
          style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}>
          <ToolbarGroup data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="toolbar" className="conversation-excerpt__toolbar"
            role="group" aria-label={t('selection.actions')}>
            <Button size="sm" variant="text" className="conversation-excerpt__action"
              data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="action"
              leadingIcon={<Icon name="edit" />} onClick={() => setEditing(true)} aria-haspopup="dialog">
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
        </Card>, getAppearanceOverlayHost(),
      )}
      <Dialog ref={editorRef} open={!!selection && editing && active} onOpenChange={clear} size="sm" className="conversation-excerpt__dialog"
        initialFocusRef={commentRef} restoreFocus={false} data-flowchat-selection-ignore="true"
        data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="dialog"
        onKeyDown={event => event.stopPropagation()}>
        <DialogHeader>
          <DialogHeading><DialogTitle>{t('selection.annotate')}</DialogTitle></DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
          <div className="conversation-excerpt__editor"
            data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="editor">
            {selection && <ConversationExcerptEditor excerpt={selection.excerpt} comment={comment}
              onCommentChange={setComment} inputRef={commentRef} onSubmit={() => submit('annotate')} />}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="fill" onClick={clear}>{t('selection.cancel')}</Button>
          <Button variant="primary" onClick={() => submit('annotate')}>{t(parentSessionId ? 'selection.addToMain' : 'selection.addToSession')}</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
