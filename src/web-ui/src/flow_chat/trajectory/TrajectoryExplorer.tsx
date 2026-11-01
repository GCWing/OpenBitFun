import type React from 'react';
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Stack, StatusPill, Tooltip } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import type { Session } from '../types/flow-chat';
import { useTrajectory } from './useTrajectory';
import { trajectoryNodeKey, type TrajectoryNode } from './trajectoryModel';
import { resolveTrajectoryRange, summarizeTrajectoryRange, type TrajectoryRange, type TrajectoryRangeSummary } from './trajectoryRange';
import { trajectoryStatus } from './trajectoryPresentation';
import './Trajectory.scss';

const NODE_WIDTH = 12;
const OVERSCAN = 8;
const lanes = ['user', 'model', 'tool'] as const;

export interface TrajectorySelection { node: TrajectoryNode; query: string }
export interface TrajectorySearchState { count: number; current: number }
export interface TrajectoryExplorerRef { next(): void; previous(): void }
interface TrajectoryExplorerProps {
  session: Session; searchInput: string; onQueryChange: (value: string) => void;
  onSearchStateChange?: (state: TrajectorySearchState) => void;
  onSelect: (selection: TrajectorySelection) => Promise<boolean>; onClose: () => void;
  selectedNodeKey?: string;
  onClearSelection?: () => void;
  onRangeChange: (range: TrajectoryRangeSummary | null, activate: boolean) => void;
}
export const TrajectoryExplorer = forwardRef<TrajectoryExplorerRef, TrajectoryExplorerProps>(function TrajectoryExplorer({
  session, searchInput, onQueryChange, onSearchStateChange, onSelect, onClose, onRangeChange, selectedNodeKey, onClearSelection,
}, ref) {
  const { t, formatNumber } = useI18n(['flow-chat', 'shared']);
  const railId = useId();
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<TrajectoryRange | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const clearRange = useCallback(() => {
    if (!rangeRef.current) return;
    rangeRef.current = null;
    setRange(null);
    onRangeChange(null, false);
  }, [onRangeChange]);
  const drag = useRef<{ anchor: string; focus: string; moved: boolean; pointerId: number } | null>(null);
  const suppressClick = useRef(false);
  const [selected, setSelected] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const [keyboardPreview, setKeyboardPreview] = useState(false);
  const [railFocused, setRailFocused] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const clearNodeSelection = useCallback(() => {
    generation.current++;
    setSelected(undefined);
    setFocused(undefined);
    setKeyboardPreview(false);
    setBusy(false);
    setFailed(false);
    onClearSelection?.();
  }, [onClearSelection]);
  const rail = useRef<HTMLDivElement>(null);
  const referenceLine = useRef<HTMLDivElement>(null);
  const referenceNode = useRef<HTMLElement | null>(null);
  const hoverPointer = useRef<{ x: number; y: number } | null>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 800 });
  const { nodes, loading, complete, error, supported, retry } = useTrajectory(session, query);
  const highlightReferenceNode = useCallback((node: HTMLElement | null) => {
    if (referenceNode.current === node) return;
    referenceNode.current?.removeAttribute('data-reference-hit');
    referenceNode.current = node;
    node?.setAttribute('data-reference-hit', 'true');
  }, []);
  const hideReferenceLine = useCallback(() => {
    hoverPointer.current = null;
    if (referenceLine.current) referenceLine.current.hidden = true;
    highlightReferenceNode(null);
  }, [highlightReferenceNode]);
  const positionReferenceLine = useCallback(() => {
    const element = rail.current;
    const line = referenceLine.current;
    const pointer = hoverPointer.current;
    if (!element || !line || !pointer) return;
    const rect = element.getBoundingClientRect();
    const x = pointer.x - rect.left + element.scrollLeft;
    line.hidden = !nodes.length || pointer.x < rect.left || pointer.x >= rect.right
      || pointer.y < rect.top || pointer.y >= rect.top + element.clientHeight
      || x < 0 || x >= nodes.length * NODE_WIDTH;
    // Only the overlay and the two affected mounted nodes change on pointer motion.
    if (!line.hidden) line.style.transform = `translateX(${x}px)`;
    highlightReferenceNode(line.hidden ? null : element.querySelector<HTMLElement>(
      `[data-trajectory-index="${Math.floor(x / NODE_WIDTH)}"]`,
    ));
  }, [nodes.length, highlightReferenceNode]);
  const previewPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') { hideReferenceLine(); return; }
    hoverPointer.current = { x: event.clientX, y: event.clientY };
    positionReferenceLine();
  };
  useEffect(() => { if (!nodes.length) hideReferenceLine(); }, [nodes.length, hideReferenceLine]);
  // A horizontal scroll can mount the hit node after the scroll handler runs.
  useLayoutEffect(() => { positionReferenceLine(); }, [viewport, nodes, positionReferenceLine]);
  const hasRange = !!range;
  const hasSelection = !!selected;
  useEffect(() => {
    if (!hasRange && !hasSelection && !busy) return;
    const element = rail.current;
    const document = element?.ownerDocument;
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || element?.contains(event.target)) return;
      if (event.target.closest('[role="search"]')) return;
      clearRange();
      if (!event.target.closest('button, a, input, textarea, select, label, [role="button"], [role="tab"], [role="menuitem"], [role="slider"], [contenteditable="true"]')) {
        clearNodeSelection();
      }
    };
    // Let endpoint buttons finish their click before range details are replaced.
    document?.addEventListener('click', dismiss);
    return () => document?.removeEventListener('click', dismiss);
  }, [hasRange, hasSelection, busy, clearRange, clearNodeSelection]);
  const bounds = useMemo(() => resolveTrajectoryRange(nodes, range), [nodes, range]);
  const matches = useMemo(() => nodes.filter((node, index) => node.matched
    && (!bounds || index >= bounds[0] && index <= bounds[1])), [nodes, bounds]);
  useEffect(() => {
    if (range && !bounds && !loading) { setRange(null); onRangeChange(null, false); }
    if (bounds) onRangeChange(summarizeTrajectoryRange(nodes, bounds), false);
  }, [nodes, bounds, onRangeChange, range, loading]);
  const commitRange = (anchor: number, focus: number) => {
    if (!nodes[anchor] || !nodes[focus]) return;
    setRange({ anchor: trajectoryNodeKey(nodes[anchor]), focus: trajectoryNodeKey(nodes[focus]) });
    onRangeChange(summarizeTrajectoryRange(nodes, [Math.min(anchor, focus), Math.max(anchor, focus)]), true);
  };
  const pointerIndex = (clientX: number) => Math.max(0, Math.min(nodes.length - 1,
    Math.floor((clientX - (rail.current?.getBoundingClientRect().left ?? 0) + (rail.current?.scrollLeft ?? 0)) / NODE_WIDTH)));
  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    previewPointer(event);
    setKeyboardPreview(false);
    if (event.button !== 0 || !nodes.length || event.shiftKey) return;
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-range-edge]')?.dataset.rangeEdge;
    const index = pointerIndex(event.clientX);
    const anchor = handle && bounds ? (handle === 'start' ? bounds[1] : bounds[0]) : index;
    drag.current = { anchor: trajectoryNodeKey(nodes[anchor]), focus: trajectoryNodeKey(nodes[index]), moved: !!handle, pointerId: event.pointerId };
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const matchIndex = matches.findIndex(node => trajectoryNodeKey(node) === selected);
  useEffect(() => {
    onSearchStateChange?.({ count: matches.length, current: matchIndex + 1 });
  }, [matches.length, matchIndex, onSearchStateChange]);
  useEffect(() => { setSelected(selectedNodeKey); }, [selectedNodeKey]);
  const selectedIndex = nodes.findIndex(node => trajectoryNodeKey(node) === selected);
  const focusedIndex = Math.max(0, nodes.findIndex(node => trajectoryNodeKey(node) === focused));
  const revealIndex = railFocused ? focusedIndex : selectedIndex;
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(searchInput); onQueryChange(searchInput); }, 200);
    return () => clearTimeout(timer);
  }, [searchInput, onQueryChange]);
  useEffect(() => () => { generation.current++; }, []);
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element) return;
    const update = () => {
      hideReferenceLine();
      setViewport({ left: element.scrollLeft, width: element.clientWidth });
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, [hideReferenceLine]);
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element || revealIndex < 0) return;
    const left = revealIndex * NODE_WIDTH;
    if (left < element.scrollLeft || left + NODE_WIDTH > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = Math.max(0, left - element.clientWidth / 2);
      setViewport({ left: element.scrollLeft, width: element.clientWidth });
    }
  }, [revealIndex]);
  const select = async (node: TrajectoryNode, keepRange = false) => {
    if (!keepRange) clearRange();
    const request = ++generation.current;
    setFocused(trajectoryNodeKey(node)); setFailed(false); setBusy(true);
    try {
      const located = await onSelect({ node, query });
      if (request === generation.current) {
        setFailed(!located);
        if (located) setSelected(trajectoryNodeKey(node));
      }
    } catch { if (request === generation.current) setFailed(true); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const advance = (direction: number) => {
    if (!matches.length) return;
    const index = matchIndex < 0 ? (direction > 0 ? 0 : matches.length - 1)
      : (matchIndex + direction + matches.length) % matches.length;
    void select(matches[index], true);
  };
  useImperativeHandle(ref, () => ({ next: () => advance(1), previous: () => advance(-1) }));
  const start = Math.max(0, Math.floor(viewport.left / NODE_WIDTH) - OVERSCAN);
  const end = Math.min(nodes.length, Math.ceil((viewport.left + viewport.width) / NODE_WIDTH) + OVERSCAN);
  const mounted = nodes.slice(start, end);
  const kindLabel = (node: TrajectoryNode) => node.kind === 'tool' ? t('trajectory.tool')
    : node.kind === 'model' ? t('trajectory.model') : t('trajectory.user');
  const status = failed ? t('trajectory.locateFailed') : error ? t('trajectory.loadFailed')
    : loading ? t('trajectory.loading') : !supported || !complete ? t('trajectory.partial') : null;
  return <section className="trajectory" aria-label={t('trajectory.title')}
    data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="root"
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    }}>
    <div className="trajectory__body" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="body">
      <div className="trajectory__labels"><span>{t('trajectory.user')}</span><span>{t('trajectory.model')}</span><span>{t('trajectory.tool')}</span></div>
      <div ref={rail} className="trajectory__rail" role="listbox" aria-label={t('trajectory.title')}
        aria-busy={busy} tabIndex={0} data-keyboard-preview={railFocused && keyboardPreview}
        aria-activedescendant={railFocused && nodes.length ? `${railId}-${focusedIndex}` : undefined}
        onFocus={event => { if (event.target === event.currentTarget) setRailFocused(true); }}
        onBlur={() => setRailFocused(false)} data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="rail"
        onPointerDown={beginDrag}
        onPointerEnter={previewPointer}
        onPointerLeave={hideReferenceLine}
        onPointerMove={event => {
          previewPointer(event);
          const active = drag.current;
          if (!active || active.pointerId !== event.pointerId) return;
          const element = event.currentTarget;
          const rect = element.getBoundingClientRect();
          if (event.clientX < rect.left + NODE_WIDTH) element.scrollLeft -= NODE_WIDTH;
          if (event.clientX > rect.right - NODE_WIDTH) element.scrollLeft += NODE_WIDTH;
          positionReferenceLine();
          const index = pointerIndex(event.clientX);
          const key = trajectoryNodeKey(nodes[index]);
          active.moved ||= key !== active.anchor;
          active.focus = key;
          if (active.moved) setRange({ anchor: active.anchor, focus: key });
        }}
        onPointerUp={event => {
          const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
          drag.current = null; suppressClick.current = active.moved;
          const anchor = nodes.findIndex(node => trajectoryNodeKey(node) === active.anchor);
          const focus = nodes.findIndex(node => trajectoryNodeKey(node) === active.focus);
          const x = event.clientX - event.currentTarget.getBoundingClientRect().left + event.currentTarget.scrollLeft;
          if (active.moved) commitRange(anchor, focus);
          else if (x < 0 || x >= nodes.length * NODE_WIDTH) {
            suppressClick.current = true; clearRange(); clearNodeSelection();
          }
          else if (nodes[focus]) { suppressClick.current = true; void select(nodes[focus]); }
          event.currentTarget.focus({ preventScroll: true });
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { drag.current = null; suppressClick.current = true; hideReferenceLine(); }}
        onScroll={event => {
          positionReferenceLine();
          setViewport({ left: event.currentTarget.scrollLeft, width: event.currentTarget.clientWidth });
        }}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key) || !nodes.length) return;
          hideReferenceLine();
          event.preventDefault(); event.stopPropagation(); setKeyboardPreview(true);
          if (event.key === 'Enter' || event.key === ' ') { void select(nodes[focusedIndex]); return; }
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1
            : Math.min(nodes.length - 1, Math.max(0, focusedIndex + (event.key === 'ArrowLeft' ? -1 : 1)));
          if (event.shiftKey) commitRange(bounds?.[0] ?? focusedIndex, index);
          setFocused(trajectoryNodeKey(nodes[index]));
        }}>
        <div className="trajectory__track" style={{ width: nodes.length * NODE_WIDTH }}>
          <div ref={referenceLine} hidden aria-hidden="true" className="trajectory__reference-line"
            data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="referenceLine" />
          {bounds && <div className="trajectory__range" style={{ left: bounds[0] * NODE_WIDTH, width: (bounds[1] - bounds[0] + 1) * NODE_WIDTH }}
            data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="range">
            {(['start', 'end'] as const).map(edge => <div key={edge} className={`trajectory__range-handle trajectory__range-handle--${edge}`}
              role="slider" tabIndex={0} data-range-edge={edge} aria-label={edge === 'start' ? t('trajectory.rangeStart') : t('trajectory.rangeEnd')}
              aria-valuemin={1} aria-valuemax={nodes.length} aria-valuenow={(edge === 'start' ? bounds[0] : bounds[1]) + 1}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                const current = edge === 'start' ? bounds[0] : bounds[1];
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1
                  : Math.max(0, Math.min(nodes.length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1)));
                commitRange(edge === 'start' ? bounds[1] : bounds[0], next);
              }} />)}
          </div>}
          {mounted.map((node, index) => {
            const key = trajectoryNodeKey(node);
            const label = t('trajectory.node', { turn: node.turnOrdinal + 1, name: node.label || kindLabel(node) });
            const nodeStatus = trajectoryStatus(node.status, t);
            return <Tooltip key={key} placement="bottom" active={railFocused && focused !== undefined && start + index === focusedIndex} content={
              <Stack gap="2" className="trajectory__tooltip" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="tooltip">
                <strong>{node.label || kindLabel(node)}</strong>
                <Stack direction="horizontal" align="center" gap="2" wrap>
                  <span>{kindLabel(node)} · {t('trajectory.turn', { turn: node.turnOrdinal + 1 })}</span>
                  <StatusPill tone={nodeStatus.tone}>{nodeStatus.label}</StatusPill>
                </Stack>
                {node.kind !== 'user' && <span>{t('trajectory.duration')}: {node.durationMs == null ? t('trajectory.notRecorded')
                  : formatNumber(node.durationMs / 1000, { style: 'unit', unit: 'second', maximumFractionDigits: 3 })}</span>}
                {node.preview && <span>{node.preview}</span>}
              </Stack>}>

              <button id={`${railId}-${start + index}`} type="button" role="option" aria-selected={key === selected} aria-label={label} tabIndex={-1}
                aria-posinset={start + index + 1} aria-setsize={nodes.length}
                className="trajectory__node" data-focused={railFocused && focused !== undefined && start + index === focusedIndex} data-kind={node.kind} data-status={node.status}
                data-trajectory-index={start + index}
                data-muted={(!!query.trim() && !node.matched) || !!bounds && (start + index < bounds[0] || start + index > bounds[1])} data-selected={key === selected}
                data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="node"
                style={{ width: NODE_WIDTH, left: (start + index) * NODE_WIDTH, top: lanes.indexOf(node.kind) * 20 }}
                onClick={event => {
                  if (suppressClick.current) { suppressClick.current = false; return; }
                  if (event.shiftKey) { commitRange(Math.max(0, selectedIndex), start + index); return; }
                  void select(node);
                }}><span /></button>
            </Tooltip>;
          })}
        </div>
      </div>
    </div>
    {status && <div className="trajectory__status" role="status" data-openbitfun-product-component="session-trajectory" data-openbitfun-product-part="status">
      {status}{error && <Button size="xs" variant="text" onClick={retry}>{t('trajectory.retry')}</Button>}
    </div>}
  </section>;
});
