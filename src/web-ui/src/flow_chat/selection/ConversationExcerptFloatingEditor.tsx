import { useCallback, useLayoutEffect, useRef, useState, useId, type PointerEvent, type KeyboardEvent, type RefObject } from 'react';
import { GripVertical } from 'lucide-react';
import { Button, Card, Icon, IconButton, createOverlayPortal } from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';
import { computeFixedPopoverPositionInViewport } from '@/shared/utils/fixedPopoverViewport';
import type { CapturedFlowChatSelection } from './flowChatSelection';
import { computeSelectionBarPosition, measureExcerptEditorGeometry, type SelectionBarGeometry } from './flowChatSelectionPosition';
import { ConversationExcerptEditor } from './ConversationExcerptEditor';

interface EditorRect { left: number; top: number; width: number; height: number }
type ResizeEdge = 'right' | 'bottom' | 'corner';
interface Gesture { pointerId: number; x: number; y: number; rect: EditorRect; mode: 'move' | ResizeEdge }
const RESIZE_EDGES: readonly ResizeEdge[] = ['right', 'bottom', 'corner'];

const PADDING = 8;
const MIN_WIDTH = 260;
const MIN_HEIGHT = 220;

function viewport(view: Window) {
  const visual = view.visualViewport;
  return {
    left: (visual?.offsetLeft ?? 0) + PADDING,
    top: (visual?.offsetTop ?? 0) + PADDING,
    right: (visual?.offsetLeft ?? 0) + (visual?.width ?? view.innerWidth) - PADDING,
    bottom: (visual?.offsetTop ?? 0) + (visual?.height ?? view.innerHeight) - PADDING,
  };
}

function constrain(rect: EditorRect, view: Window): EditorRect {
  const bounds = viewport(view);
  const width = Math.min(rect.width, Math.max(0, bounds.right - bounds.left));
  const height = Math.min(rect.height, Math.max(0, bounds.bottom - bounds.top));
  return { width, height,
    left: Math.max(bounds.left, Math.min(rect.left, bounds.right - width)),
    top: Math.max(bounds.top, Math.min(rect.top, bounds.bottom - height)),
  };
}

/** A nonmodal draft stays available while the transcript scrolls or virtualizes. */
export function ConversationExcerptFloatingEditor({ rootRef, selection, initialGeometry, comment, onCommentChange, onClose, onSubmit, parentSessionId }: {
  rootRef: RefObject<HTMLElement | null>;
  selection: CapturedFlowChatSelection;
  initialGeometry: SelectionBarGeometry | null;
  comment: string;
  onCommentChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  parentSessionId?: string;
}) {
  const { t } = useI18n('flow-chat');
  const titleId = useId();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const moveFrame = useRef<{ view: Window; id: number } | null>(null);
  const pendingMove = useRef<{ gesture: Gesture; x: number; y: number } | null>(null);
  const [rect, setRect] = useState<EditorRect | null>(null);
  const cancelMove = useCallback(() => {
    if (moveFrame.current) moveFrame.current.view.cancelAnimationFrame(moveFrame.current.id);
    moveFrame.current = null;
    pendingMove.current = null;
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const view = root?.ownerDocument.defaultView;
    if (!root || !view) return;
    const size = constrain({ left: 0, top: 0, width: 360, height: 280 }, view);
    const geometry = initialGeometry ?? measureExcerptEditorGeometry(root, selection);
    const bounds = viewport(view);
    const pane = root.getBoundingClientRect();
    const anchor = geometry?.anchor ?? {
      x: (Math.max(pane.left, bounds.left) + Math.min(pane.right, bounds.right)) / 2,
      top: Math.max(pane.top, bounds.top), bottom: Math.max(pane.top, bounds.top),
    };
    const position = geometry && (computeSelectionBarPosition(geometry, size)
      ?? computeSelectionBarPosition({ ...geometry, bounds: {
        left: bounds.left - PADDING, top: bounds.top - PADDING,
        right: bounds.right + PADDING, bottom: bounds.bottom + PADDING,
      } }, size));
    const fallback = computeFixedPopoverPositionInViewport({ left: anchor.x - size.width / 2, top: anchor.top, bottom: anchor.bottom },
      size.width, size.height, { width: bounds.right + PADDING, height: bounds.bottom + PADDING }, { gap: 8 });
    setRect(constrain({ ...size, ...(position || fallback) }, view));
    // Context menus may restore focus in their closing commit.
    const frame = view.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    const resize = () => {
      cancelMove();
      gesture.current = null;
      setRect(current => current && constrain(current, view));
    };
    view.addEventListener('resize', resize);
    view.visualViewport?.addEventListener('resize', resize);
    view.visualViewport?.addEventListener('scroll', resize);
    return () => {
      cancelMove();
      gesture.current = null;
      view.cancelAnimationFrame(frame);
      view.removeEventListener('resize', resize);
      view.visualViewport?.removeEventListener('resize', resize);
      view.visualViewport?.removeEventListener('scroll', resize);
    };
  }, [rootRef, selection, initialGeometry, cancelMove]);

  const close = () => {
    const surface = surfaceRef.current;
    if (surface?.contains(surface.ownerDocument.activeElement)) rootRef.current?.focus({ preventScroll: true });
    onClose();
  };
  const start = (event: PointerEvent<HTMLButtonElement>, mode: Gesture['mode']) => {
    if (event.button !== 0 || !rect) return;
    cancelMove();
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, mode };
  };
  const change = (dx: number, dy: number, mode: Gesture['mode'], startRect?: EditorRect) => {
    const view = surfaceRef.current?.ownerDocument.defaultView;
    if (!view) return;
    const bounds = viewport(view);
    setRect(current => {
      const original = startRect ?? current;
      if (!original) return current;
      return mode === 'move'
        ? constrain({ ...original, left: original.left + dx, top: original.top + dy }, view)
        : { ...original,
          width: mode === 'bottom' ? original.width
            : Math.min(Math.max(MIN_WIDTH, original.width + dx), bounds.right - original.left),
          height: mode === 'right' ? original.height
            : Math.min(Math.max(MIN_HEIGHT, original.height + dy), bounds.bottom - original.top),
        };
    });
  };
  const flushMove = () => {
    const pending = pendingMove.current;
    cancelMove();
    if (pending) change(pending.x - pending.gesture.x, pending.y - pending.gesture.y, pending.gesture.mode, pending.gesture.rect);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    const view = surfaceRef.current?.ownerDocument.defaultView;
    if (current?.pointerId !== event.pointerId || !view) return;
    // Keep only the latest sample until paint; release flushes any final sample.
    pendingMove.current = { gesture: current, x: event.clientX, y: event.clientY };
    if (!moveFrame.current) moveFrame.current = { view, id: view.requestAnimationFrame(flushMove) };
  };
  const end = (event: PointerEvent<HTMLButtonElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    flushMove();
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>, mode: Gesture['mode']) => {
    if (!rect || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    if (mode === 'right' && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return;
    if (mode === 'bottom' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 8;
    flushMove();
    change(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
      event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, mode);
  };

  return createOverlayPortal(
    <Card ref={surfaceRef} role="dialog" aria-modal="false" aria-labelledby={titleId} data-state="open"
      appearance="raised" radius="lg" className="conversation-excerpt__floating-editor"
      data-flowchat-selection-ignore="true" data-openbitfun-native-webview-occlusion
      data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="dialog"
      style={{ left: rect?.left ?? 0, top: rect?.top ?? 0, width: rect?.width, height: rect?.height,
        visibility: rect ? 'visible' : 'hidden' }}
      onKeyDown={event => { if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation(); }}>
      <div className="conversation-excerpt__floating-header">
        <button type="button" className="conversation-excerpt__drag" aria-label={t('selection.moveEditor')}
          title={t('selection.moveEditor')} onPointerDown={event => start(event, 'move')} onPointerMove={move}
          onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
          onKeyDown={event => key(event, 'move')}>
          <GripVertical size={16} aria-hidden="true" />
          <span id={titleId}>{t('selection.annotate')}</span>
        </button>
        <IconButton size="sm" aria-label={t('selection.cancel')} title={t('selection.cancel')} icon={<Icon name="xmark" />} onClick={close} />
      </div>
      <div className="conversation-excerpt__editor conversation-excerpt__floating-body"
        data-openbitfun-product-component="conversation-excerpt" data-openbitfun-product-part="editor">
        <ConversationExcerptEditor excerpt={selection.excerpt} comment={comment} onCommentChange={onCommentChange}
          inputRef={inputRef} onSubmit={onSubmit} fill />
      </div>
      <div className="conversation-excerpt__floating-footer">
        <Button variant="fill" size="sm" onClick={close}>{t('selection.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={onSubmit}>{t(parentSessionId ? 'selection.addToMain' : 'selection.addToSession')}</Button>
      </div>
      {RESIZE_EDGES.map(edge => <button key={edge} type="button" className="conversation-excerpt__resize"
        data-resize-edge={edge} aria-label={t('selection.resizeEditor')}
        onPointerDown={event => start(event, edge)} onPointerMove={move}
        onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onKeyDown={event => key(event, edge)} />)}
    </Card>, getAppearanceOverlayHost(), undefined,
    { ownerRef: rootRef, surfaceRef, onDismiss: close, dismissOnPointerOutside: false },
  );
}
