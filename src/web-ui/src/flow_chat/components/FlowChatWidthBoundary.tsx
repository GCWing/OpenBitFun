import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import { tokens } from '@openbitfun/design-tokens';
import { useI18n } from '@/infrastructure/i18n';
import { DEFAULT_FLOW_CHAT_WIDTH, flowChatWidthStore, MIN_FLOW_CHAT_WIDTH } from '@/infrastructure/appearance/preferences/flowChatWidthStore';
import './FlowChatWidthBoundary.scss';

const WIDTH_TOKEN = '--openbitfun-control-flow-chat-transcript-max-width';
const clamp = (width: number, max: number) => Math.min(max, Math.max(Math.min(MIN_FLOW_CHAT_WIDTH, max), Math.round(width)));

interface Drag {
  pointerId: number;
  target: HTMLDivElement;
  startX: number;
  startWidth: number;
  width: number;
  direction: number;
  restore: () => void;
}

/** Owns only column geometry. Scrolling and row measurement stay with FlowChat. */
export function FlowChatWidthBoundary({
  paneRef,
  active,
  onResizingChange,
}: {
  paneRef: RefObject<HTMLDivElement>;
  active: boolean;
  onResizingChange: (resizing: boolean) => void;
}) {
  const { t } = useI18n('flow-chat');
  const preferredWidth = useStore(flowChatWidthStore, state => state.preferredWidth);
  const [maxWidth, setMaxWidth] = useState(0);
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const width = clamp(draftWidth ?? preferredWidth, maxWidth);

  const finish = useCallback((commit = false) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    current.restore();
    if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    setDraftWidth(null);
    onResizingChange(false);
    if (commit && current.width !== current.startWidth) flowChatWidthStore.getState().setPreferredWidth(current.width);
  }, [onResizingChange]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const previous = pane.style.getPropertyValue(WIDTH_TOKEN);
    const priority = pane.style.getPropertyPriority(WIDTH_TOKEN);
    return () => {
      if (previous) pane.style.setProperty(WIDTH_TOKEN, previous, priority);
      else pane.style.removeProperty(WIDTH_TOKEN);
    };
  }, [paneRef]);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (pane && maxWidth > 0) pane.style.setProperty(WIDTH_TOKEN, `${width}px`);
  }, [paneRef, maxWidth, width]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = () => {
      const style = getComputedStyle(pane);
      const px = (name: 'control.flowChat.turnRailOffset' | 'control.flowChat.turnRailWidth' | 'space.2', variable: string) => (
        Number.parseFloat(style.getPropertyValue(variable)) || Number.parseFloat(String(tokens[name]))
      );
      // Reserve a rail lane plus breathing room on BOTH sides of the centred
      // column. This also covers the native scrollbar and the handle hit area.
      const gap = px('control.flowChat.turnRailOffset', '--openbitfun-control-flow-chat-turn-rail-offset')
        + px('control.flowChat.turnRailWidth', '--openbitfun-control-flow-chat-turn-rail-width')
        + px('space.2', '--openbitfun-space-2');
      const next = Math.max(0, Math.floor(pane.clientWidth - 2 * gap));
      setMaxWidth(previous => previous === next ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [paneRef]);

  // A disappearing/resized pane, an external setting change, or focus loss
  // cancels the preview without replacing the user's saved preference.
  useEffect(() => { finish(); }, [active, preferredWidth, maxWidth, finish]);
  useEffect(() => {
    const cancel = () => finish();
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('blur', cancel); finish(); };
  }, [finish]);

  return (
    <div className="flow-chat-width-boundary"
      data-openbitfun-component="chat-pane" data-openbitfun-part="widthBoundary"
      data-resizing={draftWidth !== null || undefined}
      style={{ width }} hidden={!active || maxWidth <= MIN_FLOW_CHAT_WIDTH}>
      {(['left', 'right'] as const).map(side => (
        <div key={side} className={`flow-chat-width-boundary__handle flow-chat-width-boundary__handle--${side}`}
          data-openbitfun-component="chat-pane" data-openbitfun-part="widthHandle"
          role="separator" aria-orientation="vertical" tabIndex={0}
          aria-label={t(side === 'left' ? 'contentWidth.resizeLeft' : 'contentWidth.resizeRight')}
          aria-valuemin={Math.min(MIN_FLOW_CHAT_WIDTH, maxWidth)} aria-valuemax={maxWidth} aria-valuenow={width}
          onPointerDown={event => {
            if (event.button !== 0 || drag.current) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            const { cursor, userSelect } = document.body.style;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            drag.current = {
              pointerId: event.pointerId, target: event.currentTarget,
              startX: event.clientX, startWidth: width, width,
              direction: side === 'left' ? -1 : 1,
              restore: () => { document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; },
            };
            setDraftWidth(width);
            onResizingChange(true);
          }}
          onPointerMove={event => {
            const current = drag.current;
            if (!current || current.pointerId !== event.pointerId) return;
            // Both edges move equally around the existing panel axis.
            current.width = clamp(current.startWidth + 2 * current.direction * (event.clientX - current.startX), maxWidth);
            if (frame.current === null) frame.current = requestAnimationFrame(() => {
              frame.current = null;
              if (drag.current) setDraftWidth(drag.current.width);
            });
          }}
          onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finish(true); }}
          onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finish(); }}
          onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finish(); }}
          onDoubleClick={() => {
            finish();
            // The settings reset and this gesture use the same default.
            flowChatWidthStore.getState().setPreferredWidth(DEFAULT_FLOW_CHAT_WIDTH);
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              if (drag.current) { event.preventDefault(); event.stopPropagation(); finish(); }
              return;
            }
            const step = event.shiftKey ? 50 : 10;
            const direction = side === 'left' ? -1 : 1;
            const next = event.key === 'Home' ? MIN_FLOW_CHAT_WIDTH : event.key === 'End' ? maxWidth
              : event.key === 'ArrowLeft' ? width - direction * step
                : event.key === 'ArrowRight' ? width + direction * step : null;
            if (next === null || drag.current) return;
            event.preventDefault();
            event.stopPropagation();
            flowChatWidthStore.getState().setPreferredWidth(clamp(next, maxWidth));
          }}
        />
      ))}
    </div>
  );
}
