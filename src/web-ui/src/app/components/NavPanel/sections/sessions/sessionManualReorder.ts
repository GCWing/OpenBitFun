import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type * as React from 'react';
import {
  manualOrderScopeKey,
  moveSessionInOrder,
  orderSessionsManually,
  reconcileManualOrder,
  type ManualOrderScopeKey,
} from '@/flow_chat/utils/sessionManualOrder';
import { readManualOrder, useWorkspaceSessionViewStore, writeManualOrder } from '../../workspaceSessionView';

/**
 * Manual (drag-and-drop) ordering for the session nav list.
 *
 * The order itself lives in localStorage behind the session-view preference
 * module; this module owns everything the rows need on top of it:
 *
 *  - the drag payload, the drop geometry and the order arithmetic (pure),
 *  - a revision store so a written order re-renders every session list,
 *  - `useSessionManualReorder`, the drag state machine a section wires to its rows.
 *
 * Two independent notions of "group" keep a drop honest:
 *
 *  - the *scope* (`workspace:<id>` or `all`) decides where an order is stored.
 *    A drag never crosses scopes: the payload carries its scope and a row that
 *    belongs to another scope refuses the drop before `preventDefault`, so the
 *    browser keeps showing "no drop" and no stored order is touched.
 *  - the *sibling group* keeps a top-level row among top-level rows and a child
 *    row among its own siblings, so a drop can never move a row out of the
 *    parent block it is rendered inside.
 */

export const SESSION_ROW_DRAG_MIME_TYPE = 'application/x-openbitfun-session';
const SESSION_ROW_DRAG_PLAIN_MIME_TYPE = 'text/plain';
export const SESSION_ROW_DROP_SETTLE_MS = 160;
const SESSION_ROW_DROP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** Top-level rows of one scope share a single sibling group. */
export const SESSION_TOP_LEVEL_GROUP_KEY = 'top';
const SESSION_CHILD_GROUP_PREFIX = 'child:';
/**
 * A committed drop does not produce a click in the browsers we ship on. This
 * window keeps the row's open handler honest if one ever does.
 */
const SESSION_DRAG_CLICK_GUARD_MS = 150;

export type SessionDropPosition = 'before' | 'after';

export interface SessionDragPayload {
  sessionId: string;
  scopeKey: ManualOrderScopeKey;
  groupKey: string;
}

/** The minimum a row has to expose to be reorderable. */
export interface SessionReorderNode {
  sessionId: string;
}

interface SessionRowIdentity extends SessionReorderNode {
  groupKey: string;
}

/**
 * `workspace:<workspaceId>` for a workspace group row and `all` for the flat
 * "all sessions" projection (which renders without a workspace id).
 */
export const sessionManualOrderScopeKey = (workspaceId?: string | null): ManualOrderScopeKey =>
  manualOrderScopeKey({ workspaceId });

/** Reorders one group's items by the stored order; `item => item.sessionId` is the row identity. */
export function orderSessionsForManualView<T extends SessionReorderNode>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  return orderSessionsManually(items, order, item => item.sessionId);
}

export function isSameSessionOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Insertion above or below the row is the pointer against the row's vertical midline. */
export function resolveSessionDropPosition(
  clientY: number,
  rectTop: number,
  rectHeight: number,
): SessionDropPosition {
  return clientY >= rectTop + rectHeight / 2 ? 'after' : 'before';
}

/**
 * The order a drop produces. `sequence` is the scope's rows in display order and
 * the dragged row is re-inserted next to the target row — the target index is
 * resolved on the sequence *without* the dragged row, which makes the result
 * independent of which side the row came from. Children stay with their parent
 * block: only the relative order of rows inside one group changes.
 */
export function resolveSessionDropOrder(input: {
  sequence: readonly string[];
  sessionId: string;
  targetId: string;
  position: SessionDropPosition;
}): string[] {
  const { sequence, sessionId, targetId, position } = input;
  const withoutDragged = sequence.filter(id => id !== sessionId);
  const targetIndex = withoutDragged.indexOf(targetId);
  if (targetIndex < 0) return [...sequence];
  return moveSessionInOrder(
    withoutDragged,
    sessionId,
    position === 'after' ? targetIndex + 1 : targetIndex,
  );
}

/**
 * Rewrites `sequence` so the rows of `groupIds` follow `orderedGroupIds`, keeping
 * every other id in its slot.
 */
export function applyGroupSequence(
  sequence: readonly string[],
  groupIds: readonly string[],
  orderedGroupIds: readonly string[],
): string[] {
  const inGroup = new Set(groupIds);
  const remaining = [...orderedGroupIds];
  return sequence.map(id => (inGroup.has(id) ? remaining.shift() ?? id : id));
}

/**
 * Persists a new order for the rows the caller knows about while keeping the
 * slots of everything else (rows of the scope that this list has not loaded
 * yet), so a drag can never drop the manual order of the sessions behind a
 * metadata page boundary.
 */
export function writeSessionScopeOrder(
  scopeKey: ManualOrderScopeKey,
  sequence: readonly string[],
  nextSequence: readonly string[],
): void {
  const stored = readManualOrder(scopeKey);
  const known = new Set(stored);
  const fullOrder = [...stored, ...sequence.filter(id => !known.has(id))];
  writeManualOrder(scopeKey, applyGroupSequence(fullOrder, sequence, nextSequence));
  notifyManualOrderWrite();
}

/** Rewrites the stored order without the ids that were just removed from the list. */
export function pruneSessionScopeOrder(
  scopeKey: ManualOrderScopeKey,
  removedIds: readonly string[],
): void {
  const stored = readManualOrder(scopeKey);
  if (stored.length === 0) return;
  const removed = new Set(removedIds);
  const kept = stored.filter(id => !removed.has(id));
  if (kept.length === stored.length) return;
  // `reconcileManualOrder` bounds the stored order: ids that are no longer in
  // the list are dropped, ids that are still there keep their relative order.
  writeManualOrder(scopeKey, reconcileManualOrder(stored, kept));
  notifyManualOrderWrite();
}

let manualOrderRevision = 0;
const manualOrderRevisionListeners = new Set<() => void>();

function subscribeManualOrderRevision(listener: () => void): () => void {
  manualOrderRevisionListeners.add(listener);
  return () => {
    manualOrderRevisionListeners.delete(listener);
  };
}

const getManualOrderRevisionSnapshot = (): number => manualOrderRevision;

function notifyManualOrderWrite(): void {
  manualOrderRevision += 1;
  for (const listener of [...manualOrderRevisionListeners]) listener();
}

/**
 * The stored order of one scope, re-read whenever any list writes it. Listing a
 * scope is enough to keep its own rows in sync after another section reordered it.
 */
export function useSessionManualOrder(scopeKey: ManualOrderScopeKey): string[] {
  const revision = useSyncExternalStore(
    subscribeManualOrderRevision,
    getManualOrderRevisionSnapshot,
    getManualOrderRevisionSnapshot,
  );
  return useMemo(() => {
    // The stored order lives outside React, so the revision is the only signal
    // that another list wrote this scope's order and this one has to re-read it.
    void revision;
    return readManualOrder(scopeKey);
  }, [revision, scopeKey]);
}

/**
 * Hand a committed reorder over to the manual ordering mode, so the order the
 * user just arranged is the one the list shows. Silent on purpose: dragging is a
 * frequent gesture and a toast per drop is noise. Switching only when the mode
 * actually differs keeps a repeat reorder from touching the view preferences.
 */
export function switchSessionViewToManualOrdering(): void {
  const view = useWorkspaceSessionViewStore.getState();
  if (view.ordering === 'manual') return;
  view.setOrdering('manual');
}

export interface SessionRowDragProps {
  draggable: boolean;
  'aria-grabbed'?: boolean;
  onDragStart: React.DragEventHandler<HTMLDivElement>;
  onDragOver: React.DragEventHandler<HTMLDivElement>;
  onDragLeave: React.DragEventHandler<HTMLDivElement>;
  onDrop: React.DragEventHandler<HTMLDivElement>;
  onDragEnd: React.DragEventHandler<HTMLDivElement>;
}

export interface SessionManualReorderHandle {
  scopeKey: ManualOrderScopeKey;
  /** The row currently being dragged, for the row state and `aria-grabbed`. */
  isDragging(sessionId: string): boolean;
  /** Where the drop line is drawn for this row, or null when it is not the target. */
  dropPositionFor(sessionId: string): SessionDropPosition | null;
  /** Drag state plus the handlers a row wires; `draggable` is false for a row that cannot reorder. */
  rowDragProps(sessionId: string): SessionRowDragProps;
  /** A click emitted by the drop gesture itself must not open the row. */
  isRowClickSuppressed(): boolean;
}

export interface SessionManualReorderOptions {
  scopeKey: ManualOrderScopeKey;
  /** False outside the workspace view preferences (assistant sections): rows stay static. */
  enabled: boolean;
  /** The scope's top-level rows in display order. */
  topLevelSessions: readonly SessionReorderNode[];
  /** Each parent's child rows in display order; children reorder among siblings only. */
  childrenByParent: ReadonlyMap<string, readonly SessionReorderNode[]>;
  /**
   * Ids the list actually renders right now. Only these can take part in a
   * reorder: the loaded rows behind a metadata page boundary, a display limit or
   * an active filter are ordered by the same stored order, but moving a row
   * against one of them would change nothing on screen.
   */
  renderedIds: ReadonlySet<string>;
  /** The list element that owns the rows, used for the drop's FLIP settle. */
  listRef: React.RefObject<HTMLDivElement | null>;
  /** Called once a committed reorder needs the manual ordering mode to be visible. */
  onManualOrderCommit?: () => void;
}

export function useSessionManualReorder(
  options: SessionManualReorderOptions,
): SessionManualReorderHandle {
  const {
    scopeKey,
    enabled,
    topLevelSessions,
    childrenByParent,
    renderedIds,
    listRef,
    onManualOrderCommit,
  } = options;

  const rows = useMemo<SessionRowIdentity[]>(() => {
    const identity: SessionRowIdentity[] = [];
    for (const parent of topLevelSessions) {
      identity.push({ sessionId: parent.sessionId, groupKey: SESSION_TOP_LEVEL_GROUP_KEY });
      for (const child of childrenByParent.get(parent.sessionId) ?? []) {
        identity.push({
          sessionId: child.sessionId,
          groupKey: `${SESSION_CHILD_GROUP_PREFIX}${parent.sessionId}`,
        });
      }
    }
    return identity;
  }, [childrenByParent, topLevelSessions]);

  const sequence = useMemo(() => rows.map(row => row.sessionId), [rows]);
  const groupKeyBySessionId = useMemo(
    () => new Map(rows.map(row => [row.sessionId, row.groupKey])),
    [rows],
  );
  const groupIdsOf = useCallback(
    (sessionId: string): string[] => {
      const groupKey = groupKeyBySessionId.get(sessionId);
      if (groupKey === undefined) return [];
      return rows
        .filter(row => row.groupKey === groupKey && renderedIds.has(row.sessionId))
        .map(row => row.sessionId);
    },
    [groupKeyBySessionId, renderedIds, rows],
  );

  const sequenceRef = useRef(sequence);
  useEffect(() => {
    sequenceRef.current = [...sequence];
  }, [sequence]);
  const commitRef = useRef(onManualOrderCommit);
  useEffect(() => {
    commitRef.current = onManualOrderCommit;
  }, [onManualOrderCommit]);

  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ sessionId: string; position: SessionDropPosition } | null>(null);
  const draggingRef = useRef<SessionDragPayload | null>(null);
  const dropTargetRef = useRef<{ sessionId: string; position: SessionDropPosition } | null>(null);
  const pendingRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const animationsRef = useRef<Map<string, Animation>>(new Map());
  const lastDropAtRef = useRef(0);

  // Rows the list has already shown. Only ids observed to disappear are pruned
  // from the stored order: a metadata page boundary is not a removal.
  const seenIdsRef = useRef<{ scopeKey: ManualOrderScopeKey; ids: Set<string> }>({
    scopeKey,
    ids: new Set<string>(),
  });
  useEffect(() => {
    if (seenIdsRef.current.scopeKey !== scopeKey) {
      seenIdsRef.current = { scopeKey, ids: new Set<string>() };
    }
    const seen = seenIdsRef.current.ids;
    const present = new Set(sequence);
    const removed: string[] = [];
    for (const id of seen) {
      if (!present.has(id)) removed.push(id);
    }
    for (const id of present) seen.add(id);
    if (removed.length > 0) pruneSessionScopeOrder(scopeKey, removed);
  }, [scopeKey, sequence]);

  useEffect(() => () => {
    animationsRef.current.forEach(animation => animation.cancel());
    animationsRef.current.clear();
  }, []);

  // FLIP settle: rows that swapped places start from their previous slot.
  useLayoutEffect(() => {
    const previousRects = pendingRectsRef.current;
    if (!previousRects) return;
    pendingRectsRef.current = null;
    if (typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const list = listRef.current;
    if (!list) return;

    for (const element of list.querySelectorAll<HTMLElement>('[data-session-id]')) {
      const sessionId = element.dataset.sessionId;
      if (!sessionId || typeof element.animate !== 'function') continue;
      const previousRect = previousRects.get(sessionId);
      if (!previousRect) continue;
      const deltaY = previousRect.top - element.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 0.5) continue;

      animationsRef.current.get(sessionId)?.cancel();
      const animation = element.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: 'translateY(0)' },
        ],
        { duration: SESSION_ROW_DROP_SETTLE_MS, easing: SESSION_ROW_DROP_EASING },
      );
      animationsRef.current.set(sessionId, animation);
      animation.addEventListener('finish', () => {
        if (animationsRef.current.get(sessionId) === animation) {
          animationsRef.current.delete(sessionId);
        }
      }, { once: true });
    }
  }, [listRef, sequence]);

  const commitOrder = useCallback((current: readonly string[], next: readonly string[]) => {
    if (isSameSessionOrder(current, next)) {
      // Dropped where it already was: nothing moved, so no settle either.
      pendingRectsRef.current = null;
      return;
    }
    writeSessionScopeOrder(scopeKey, current, next);
    commitRef.current?.();
  }, [scopeKey]);

  const handleDragStart = useCallback(
    (sessionId: string) => (event: React.DragEvent<HTMLDivElement>) => {
      const groupKey = groupKeyBySessionId.get(sessionId);
      if (!enabled || groupKey === undefined || groupIdsOf(sessionId).length < 2) return;

      const payload: SessionDragPayload = { sessionId, scopeKey, groupKey };
      const serializedPayload = JSON.stringify(payload);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(SESSION_ROW_DRAG_MIME_TYPE, serializedPayload);
      event.dataTransfer.setData(SESSION_ROW_DRAG_PLAIN_MIME_TYPE, serializedPayload);
      draggingRef.current = payload;
      setDraggingSessionId(sessionId);
    },
    [enabled, groupIdsOf, groupKeyBySessionId, scopeKey],
  );

  const handleDragEnd = useCallback(() => {
    draggingRef.current = null;
    dropTargetRef.current = null;
    setDraggingSessionId(null);
    setDropTarget(null);
  }, []);

  const handleDragOver = useCallback(
    (sessionId: string) => (event: React.DragEvent<HTMLDivElement>) => {
      const dragged = draggingRef.current;
      const groupKey = groupKeyBySessionId.get(sessionId);
      // Browsers hide dataTransfer data during dragover, but `types` stays readable.
      const isSessionDrag = event.dataTransfer.types.includes(SESSION_ROW_DRAG_MIME_TYPE);
      // Another scope, another sibling group or the dragged row itself: refuse the
      // drop here and now, so nothing downstream can move or corrupt an order.
      if (
        !dragged
        || !isSessionDrag
        || dragged.scopeKey !== scopeKey
        || dragged.groupKey !== groupKey
        || dragged.sessionId === sessionId
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';

      const rect = event.currentTarget.getBoundingClientRect();
      const position = resolveSessionDropPosition(event.clientY, rect.top, rect.height);
      setDropTarget(current => {
        if (current?.sessionId === sessionId && current.position === position) return current;
        const next = { sessionId, position };
        dropTargetRef.current = next;
        return next;
      });
    },
    [groupKeyBySessionId, scopeKey],
  );

  const handleDragLeave = useCallback(
    (sessionId: string) => (event: React.DragEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropTarget(current => {
        if (current?.sessionId !== sessionId) return current;
        dropTargetRef.current = null;
        return null;
      });
    },
    [],
  );

  const handleDrop = useCallback(
    (sessionId: string) => (event: React.DragEvent<HTMLDivElement>) => {
      // Reading dataTransfer data is allowed on drop.
      const payloadText = event.dataTransfer.getData(SESSION_ROW_DRAG_MIME_TYPE)
        || event.dataTransfer.getData(SESSION_ROW_DRAG_PLAIN_MIME_TYPE);
      if (!payloadText) return;

      let payload: SessionDragPayload;
      try {
        payload = JSON.parse(payloadText) as SessionDragPayload;
      } catch {
        return;
      }

      const groupKey = groupKeyBySessionId.get(sessionId);
      const isSameScope = payload?.scopeKey === scopeKey;
      if (
        !payload?.sessionId
        || !isSameScope
        || groupKey === undefined
        || payload.groupKey !== groupKey
        || payload.sessionId === sessionId
      ) {
        // Dropped from another scope or onto another group: leave every order as it was.
        handleDragEnd();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      // Read the insertion side off this event: a fast drop can land without a
      // dragover, and a dragleave may already have cleared the target. The tracked
      // target is only a fallback for a row that reports no height at all.
      const rect = event.currentTarget.getBoundingClientRect();
      const position = rect.height > 0
        ? resolveSessionDropPosition(event.clientY, rect.top, rect.height)
        : dropTargetRef.current?.sessionId === sessionId
          ? dropTargetRef.current.position
          : 'after';
      const current = sequenceRef.current;
      const next = resolveSessionDropOrder({
        sequence: current,
        sessionId: payload.sessionId,
        targetId: sessionId,
        position,
      });
      const list = listRef.current;
      pendingRectsRef.current = list
        ? new Map(Array.from(
            list.querySelectorAll<HTMLElement>('[data-session-id]'),
            element => [element.dataset.sessionId ?? '', element.getBoundingClientRect()] as const,
          ))
        : null;

      lastDropAtRef.current = Date.now();
      handleDragEnd();
      commitOrder(current, next);
    },
    [commitOrder, groupKeyBySessionId, handleDragEnd, listRef, scopeKey],
  );

  const canReorderSession = useCallback(
    (sessionId: string): boolean => {
      if (!enabled) return false;
      // The row itself has to be on screen, next to at least one rendered sibling:
      // dragging against a row behind the render boundary would move nothing the
      // user can see, so those rows never become drag sources or drop targets.
      const groupIds = groupIdsOf(sessionId);
      return groupIds.includes(sessionId) && groupIds.length > 1;
    },
    [enabled, groupIdsOf],
  );

  const isRowClickSuppressed = useCallback(
    () => Date.now() - lastDropAtRef.current < SESSION_DRAG_CLICK_GUARD_MS,
    [],
  );

  const rowDragProps = useCallback(
    (sessionId: string): SessionRowDragProps => ({
      draggable: canReorderSession(sessionId),
      'aria-grabbed': draggingSessionId === sessionId ? true : undefined,
      onDragStart: handleDragStart(sessionId),
      onDragOver: handleDragOver(sessionId),
      onDragLeave: handleDragLeave(sessionId),
      onDrop: handleDrop(sessionId),
      onDragEnd: handleDragEnd,
    }),
    [
      canReorderSession,
      draggingSessionId,
      handleDragEnd,
      handleDragLeave,
      handleDragOver,
      handleDragStart,
      handleDrop,
    ],
  );

  return useMemo<SessionManualReorderHandle>(() => ({
    scopeKey,
    isDragging: sessionId => draggingSessionId === sessionId,
    dropPositionFor: sessionId => (dropTarget?.sessionId === sessionId ? dropTarget.position : null),
    rowDragProps,
    isRowClickSuppressed,
  }), [
    draggingSessionId,
    dropTarget,
    isRowClickSuppressed,
    rowDragProps,
    scopeKey,
  ]);
}
