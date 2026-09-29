import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type HTMLAttributes, type PointerEvent, type ReactNode,
} from 'react';
import { classNames } from '../../internal/classNames';
import styles from './SplitView.module.css';

export type SplitViewMode = 'split' | 'primary' | 'secondary';

export interface SplitViewProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  primary: ReactNode;
  secondary: ReactNode;
  mode?: SplitViewMode;
  secondarySide?: 'left' | 'right';
  /** Physical right slot width. Swapping content never moves the divider. */
  rightSize: number;
  minLeftSize?: number;
  minRightSize?: number;
  maxRightSize?: number;
  defaultRightSize?: number;
  onRightSizeChange: (size: number) => void;
  onResizeStateChange?: (resizing: boolean) => void;
  dividerLabel: string;
  dividerActions?: ReactNode;
  primaryPaneProps?: HTMLAttributes<HTMLDivElement>;
  secondaryPaneProps?: HTMLAttributes<HTMLDivElement>;
}

/** Shrink to the available space without mutating the owner's preferred size. */
function sizeBounds(width: number, dividerWidth: number, minLeft: number, minRight: number, maxRight: number) {
  const available = Math.max(0, width - dividerWidth);
  const max = Math.max(0, Math.min(maxRight, available - Math.min(minLeft, available / 2)));
  return { min: Math.min(minRight, max), max };
}

export function SplitView({
  primary, secondary, mode = 'split', secondarySide = 'right', rightSize,
  minLeftSize = 0, minRightSize = 0, maxRightSize = Number.MAX_SAFE_INTEGER,
  defaultRightSize = rightSize, onRightSizeChange, onResizeStateChange,
  dividerLabel, dividerActions, primaryPaneProps, secondaryPaneProps,
  className, style, onKeyDown, ...rest
}: SplitViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLDivElement>(null);
  const secondaryRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const primaryId = primaryPaneProps?.id ?? `${generatedId}-primary`;
  const secondaryId = secondaryPaneProps?.id ?? `${generatedId}-secondary`;
  const [width, setWidth] = useState<number | null>(null);
  const [dividerWidth, setDividerWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number; target: HTMLDivElement; x: number; size: number; latest: number;
    cursor: string; userSelect: string;
  } | null>(null);
  const callbacks = useRef({ onRightSizeChange, onResizeStateChange });
  callbacks.current = { onRightSizeChange, onResizeStateChange };
  const bounds = width === null ? { min: minRightSize, max: maxRightSize }
    : sizeBounds(width, dividerWidth, minLeftSize, minRightSize, maxRightSize);
  const resolvedSize = Math.min(bounds.max, Math.max(bounds.min, rightSize));
  const resolvedSizeRef = useRef(resolvedSize);
  resolvedSizeRef.current = resolvedSize;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const next = root.getBoundingClientRect().width;
      // A hidden host has no useful dimensions; wait until its next layout.
      if (next > 0) setWidth(previous => previous === next ? previous : next);
      const divider = dividerRef.current?.getBoundingClientRect().width ?? 0;
      if (divider > 0) setDividerWidth(divider);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(root);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [mode]);

  const finishResize = useCallback((commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    document.body.style.cursor = drag.cursor;
    document.body.style.userSelect = drag.userSelect;
    if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    rootRef.current?.style.setProperty('--_split-view-right-size', `${resolvedSizeRef.current}px`);
    if (commit) callbacks.current.onRightSizeChange(drag.latest);
    setResizing(false);
    callbacks.current.onResizeStateChange?.(false);
  }, []);

  useLayoutEffect(() => { finishResize(false); }, [mode, secondarySide, finishResize]);
  useEffect(() => () => { finishResize(false); }, [finishResize]);

  useLayoutEffect(() => {
    const hiddenPane = mode === 'primary' ? secondaryRef.current : mode === 'secondary' ? primaryRef.current : null;
    if (hiddenPane?.contains(document.activeElement) || (mode !== 'split' && dividerRef.current?.contains(document.activeElement))) {
      (mode === 'primary' ? primaryRef : secondaryRef).current?.focus({ preventScroll: true });
    }
  }, [mode]);

  const updateDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const measuredWidth = rootRef.current?.getBoundingClientRect().width ?? 0;
    const currentBounds = measuredWidth > 0
      ? sizeBounds(measuredWidth, dividerWidth, minLeftSize, minRightSize, maxRightSize) : bounds;
    const delta = drag.x - event.clientX;
    drag.latest = Math.min(currentBounds.max, Math.max(currentBounds.min, drag.size + delta));
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (dragRef.current) rootRef.current?.style.setProperty('--_split-view-right-size', `${dragRef.current.latest}px`);
    });
  };

  return (
    <div
      {...rest}
      ref={rootRef}
      className={classNames(styles.root, className)}
      style={{ ...style, '--_split-view-right-size': `${resolvedSize}px` } as CSSProperties}
      data-openbitfun-component="split-view" data-openbitfun-part="root"
      data-mode={mode} data-secondary-side={secondarySide} data-resizing={resizing || undefined}
      onKeyDown={event => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey) return;
        const panes = mode === 'primary' ? [primaryRef.current] : mode === 'secondary' ? [secondaryRef.current]
          : secondarySide === 'left' ? [secondaryRef.current, primaryRef.current] : [primaryRef.current, secondaryRef.current];
        const current = panes.findIndex(pane => pane?.contains(document.activeElement));
        const next = current < 0 ? (event.shiftKey ? panes.length - 1 : 0)
          : (current + (event.shiftKey ? -1 : 1) + panes.length) % panes.length;
        event.preventDefault();
        event.stopPropagation();
        panes[next]?.focus({ preventScroll: true });
      }}
    >
      <div {...primaryPaneProps} ref={primaryRef} id={primaryId} tabIndex={-1}
        className={classNames(styles.pane, styles.primary, primaryPaneProps?.className)}
        data-openbitfun-component="split-view" data-openbitfun-part="primary" hidden={mode === 'secondary'}>
        {primary}
      </div>
      <div ref={dividerRef} className={styles.divider} data-openbitfun-component="split-view" data-openbitfun-part="divider" hidden={mode !== 'split'}>
        <div className={styles.resizeHandle} role="separator" tabIndex={mode === 'split' ? 0 : -1}
          data-openbitfun-component="split-view" data-openbitfun-part="resizeHandle"
          aria-label={dividerLabel} aria-orientation="vertical" aria-controls={secondarySide === 'right' ? secondaryId : primaryId}
          aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={Math.round(resolvedSize)}
          onPointerDown={event => {
            if (event.button !== 0 || dragRef.current) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            dragRef.current = {
              pointerId: event.pointerId, target: event.currentTarget, x: event.clientX,
              size: resolvedSize, latest: resolvedSize,
              cursor: document.body.style.cursor, userSelect: document.body.style.userSelect,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            setResizing(true);
            callbacks.current.onResizeStateChange?.(true);
          }}
          onPointerMove={updateDrag}
          onPointerUp={event => {
            if (dragRef.current?.pointerId !== event.pointerId) return;
            updateDrag(event);
            finishResize(true);
          }}
          onPointerCancel={() => finishResize(false)}
          onLostPointerCapture={() => finishResize(false)}
          onDoubleClick={() => onRightSizeChange(Math.min(bounds.max, Math.max(bounds.min, defaultRightSize)))}
          onKeyDown={event => {
            let next: number;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              next = resolvedSize + (event.key === 'ArrowRight' ? -1 : 1) * (event.shiftKey ? 50 : 10);
            } else if (event.key === 'Escape' && dragRef.current) {
              event.preventDefault();
              event.stopPropagation();
              finishResize(false);
              return;
            } else if (event.key === 'Home') next = bounds.min;
            else if (event.key === 'End') next = bounds.max;
            else return;
            event.preventDefault();
            event.stopPropagation();
            onRightSizeChange(Math.min(bounds.max, Math.max(bounds.min, next)));
          }}
        />
        {dividerActions && <div className={styles.actions} data-openbitfun-component="split-view" data-openbitfun-part="actions">{dividerActions}</div>}
      </div>
      <div {...secondaryPaneProps} ref={secondaryRef} id={secondaryId} tabIndex={-1}
        className={classNames(styles.pane, styles.secondary, secondaryPaneProps?.className)}
        data-openbitfun-component="split-view" data-openbitfun-part="secondary" hidden={mode === 'primary'}>
        {secondary}
      </div>
    </div>
  );
}
