// @vitest-environment jsdom

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import React, { act, useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notificationService } from '@/shared/notification-system';
import { useWorkspaceSessionViewStore, readManualOrder } from '../../workspaceSessionView';
import {
  SESSION_ROW_DRAG_MIME_TYPE,
  SESSION_ROW_DROP_SETTLE_MS,
  SESSION_TOP_LEVEL_GROUP_KEY,
  applyGroupSequence,
  isSameSessionOrder,
  orderSessionsForManualView,
  resolveSessionDropOrder,
  resolveSessionDropPosition,
  sessionManualOrderScopeKey,
  switchSessionViewToManualOrdering,
  useSessionManualOrder,
  useSessionManualReorder,
  type SessionManualReorderHandle,
} from './sessionManualReorder';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW_HEIGHT = 26;

interface FakeDataTransfer {
  effectAllowed: string;
  dropEffect: string;
  readonly types: string[];
  setData(type: string, value: string): void;
  getData(type: string): string;
}

function createDataTransfer(): FakeDataTransfer {
  const data: Record<string, string> = {};
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() {
      return Object.keys(data);
    },
    setData(type: string, value: string) {
      data[type] = value;
    },
    getData(type: string) {
      return data[type] ?? '';
    },
  };
}

function fireDrag(
  element: HTMLElement,
  type: 'dragstart' | 'dragover' | 'dragleave' | 'drop' | 'dragend',
  options: { dataTransfer: FakeDataTransfer; clientY?: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: options.dataTransfer });
  Object.defineProperty(event, 'clientY', { value: options.clientY ?? 0 });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

interface TestListProps {
  scopeKey: string;
  /** Loaded rows of the scope, in display order. */
  parents: string[];
  /** The subset of loaded rows the list actually renders; defaults to all of them. */
  rendered?: string[];
  children?: Record<string, string[]>;
  enabled?: boolean;
  onCommit?: () => void;
  onHandle?: (handle: SessionManualReorderHandle) => void;
}

/**
 * The smallest faithful copy of the section's own projection: the rows the hook
 * sees are the rows in their current (manual) display order, exactly like
 * `allTopLevelSessions`/`childrenByParent` are in `SessionsSection`, while
 * `rendered` stands in for `visibleSessionIds` (display limit / active filters).
 */
const TestList: React.FC<TestListProps> = ({
  scopeKey,
  parents,
  rendered,
  children,
  enabled = true,
  onCommit,
  onHandle,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const manualOrder = useSessionManualOrder(scopeKey);
  const orderedParents = useMemo(
    () => orderSessionsForManualView(parents.map(sessionId => ({ sessionId })), manualOrder),
    [manualOrder, parents],
  );
  const orderedChildren = useMemo(
    () => new Map(Object.entries(children ?? {}).map(([parentId, ids]) => [
      parentId,
      orderSessionsForManualView(ids.map(sessionId => ({ sessionId })), manualOrder),
    ] as const)),
    [children, manualOrder],
  );
  const renderedIds = useMemo(() => {
    if (rendered) return new Set(rendered);
    const all = new Set(parents);
    for (const childIds of Object.values(children ?? {})) {
      for (const childId of childIds) all.add(childId);
    }
    return all;
  }, [children, parents, rendered]);
  // The switch the section wires to a commit runs here too, so a test can see the
  // ordering mode it produces next to whatever the caller wanted to observe.
  const commit = useCallback(() => {
    onCommit?.();
    switchSessionViewToManualOrdering();
  }, [onCommit]);
  const handle = useSessionManualReorder({
    scopeKey,
    enabled,
    topLevelSessions: orderedParents,
    childrenByParent: orderedChildren,
    renderedIds,
    listRef,
    onManualOrderCommit: commit,
  });
  useEffect(() => {
    onHandle?.(handle);
  });

  const renderRow = (sessionId: string) => {
    const position = handle.dropPositionFor(sessionId);
    return (
      <div
        key={sessionId}
        data-session-id={sessionId}
        data-testid={`row-${sessionId}`}
        className={[
          'openbitfun-nav-panel__inline-item',
          handle.isDragging(sessionId) && 'is-manual-dragging',
          position && `is-manual-drop-${position}`,
        ].filter(Boolean).join(' ')}
        {...handle.rowDragProps(sessionId)}
      >
        {position ? (
          <span className="openbitfun-nav-panel__inline-item-manual-drop-line" aria-hidden="true" />
        ) : null}
      </div>
    );
  };

  return (
    <div
      className="openbitfun-nav-panel__inline-list"
      data-testid={`list-${scopeKey}`}
      ref={listRef}
    >
      {orderedParents
        .filter(parent => renderedIds.has(parent.sessionId))
        .map(parent => (
          <React.Fragment key={parent.sessionId}>
            {renderRow(parent.sessionId)}
            {(orderedChildren.get(parent.sessionId) ?? [])
              .filter(child => renderedIds.has(child.sessionId))
              .map(child => renderRow(child.sessionId))}
          </React.Fragment>
        ))}
    </div>
  );
};

describe('session manual reorder helpers', () => {
  it('picks the insertion side from the pointer against the row midline', () => {
    expect(resolveSessionDropPosition(10, 0, 26)).toBe('before');
    expect(resolveSessionDropPosition(12, 0, 26)).toBe('before');
    expect(resolveSessionDropPosition(13, 0, 26)).toBe('after');
    expect(resolveSessionDropPosition(26, 0, 26)).toBe('after');
  });

  it('re-inserts a dragged top-level row on either side of its target', () => {
    const sequence = ['p1', 'c1', 'p2', 'c2', 'p3'];

    expect(resolveSessionDropOrder({
      sequence, sessionId: 'p1', targetId: 'p3', position: 'after',
    })).toEqual(['c1', 'p2', 'c2', 'p3', 'p1']);

    expect(resolveSessionDropOrder({
      sequence, sessionId: 'p3', targetId: 'p2', position: 'before',
    })).toEqual(['p1', 'c1', 'p3', 'p2', 'c2']);

    // Dropping a row back onto itself is the identity.
    expect(isSameSessionOrder(
      resolveSessionDropOrder({ sequence, sessionId: 'p2', targetId: 'p2', position: 'after' }),
      sequence,
    )).toBe(true);
  });

  it('keeps a child inside its own parent block', () => {
    const sequence = ['p1', 'c1', 'c2', 'c3', 'p2'];
    const moved = resolveSessionDropOrder({
      sequence, sessionId: 'c1', targetId: 'c3', position: 'after',
    });

    expect(moved).toEqual(['p1', 'c2', 'c3', 'c1', 'p2']);
    // A child move never reorders the parents.
    expect(moved.filter(id => id.startsWith('p'))).toEqual(['p1', 'p2']);
  });

  it('rewrites only the slots the moved group occupies', () => {
    expect(applyGroupSequence(['a', 'b', 'c', 'd'], ['b', 'd'], ['d', 'b']))
      .toEqual(['a', 'd', 'c', 'b']);
  });

  it('applies the stored order through the shared session identity', () => {
    const items = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }];
    expect(orderSessionsForManualView(items, ['c', 'b', 'a']).map(item => item.sessionId))
      .toEqual(['c', 'b', 'a']);
  });

  it('keys a scope per workspace and keeps the flat list on the shared scope', () => {
    expect(sessionManualOrderScopeKey('workspace-1')).toBe('workspace:workspace-1');
    expect(sessionManualOrderScopeKey(undefined)).toBe('all');
    expect(SESSION_TOP_LEVEL_GROUP_KEY).toBe('top');
  });
});

describe('SessionsSection manual drag reorder', () => {
  let container: HTMLDivElement;
  let root: Root;
  let handle: SessionManualReorderHandle | null;
  let commitSpy: ReturnType<typeof vi.fn>;
  let animateSpy: ReturnType<typeof vi.fn>;
  let noticeSpies: ReturnType<typeof vi.spyOn>[];

  const captureHandle = (next: SessionManualReorderHandle) => {
    handle = next;
  };

  /** A reorder is silent: the mode control shows the switch, no toast announces it. */
  const expectNoNotice = () => {
    for (const spy of noticeSpies) expect(spy).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    localStorage.clear();
    // The view store outlives a test file; start every case without a drag order
    // and on the default ordering, so the switch under test is not a no-op.
    useWorkspaceSessionViewStore.setState({ manualOrder: {}, ordering: 'updated' });
    handle = null;
    commitSpy = vi.fn();
    animateSpy = vi.fn(() => ({
      cancel: () => {},
      addEventListener: () => {},
    }));
    noticeSpies = [
      vi.spyOn(notificationService, 'info'),
      vi.spyOn(notificationService, 'success'),
      vi.spyOn(notificationService, 'warning'),
      vi.spyOn(notificationService, 'error'),
    ];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // jsdom has no layout: stack rows by their index so the drop geometry and the
    // FLIP settle measure something real.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      const parent = this.parentElement;
      const index = parent ? Array.prototype.indexOf.call(parent.children, this) : 0;
      const top = index * ROW_HEIGHT;
      return {
        top,
        bottom: top + ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = animateSpy;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const renderLists = (lists: TestListProps[]) => {
    act(() => {
      root.render(
        <>
          {lists.map(list => (
            <TestList key={list.scopeKey} onHandle={captureHandle} onCommit={commitSpy} {...list} />
          ))}
        </>,
      );
    });
  };

  const rowOf = (sessionId: string): HTMLElement =>
    document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`)!;

  const renderedOrder = (scopeKey: string): string[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(`[data-testid="list-${scopeKey}"] [data-session-id]`),
      element => element.dataset.sessionId ?? '',
    );

  it('reorders the rows of one scope and settles them with the FLIP animation', () => {
    renderLists([{ scopeKey: 'workspace:one', parents: ['a', 'b', 'c'] }]);

    expect(renderedOrder('workspace:one')).toEqual(['a', 'b', 'c']);
    expect(rowOf('a').getAttribute('draggable')).toBe('true');

    const transfer = createDataTransfer();
    fireDrag(rowOf('a'), 'dragstart', { dataTransfer: transfer });
    expect(transfer.getData(SESSION_ROW_DRAG_MIME_TYPE)).toContain('"sessionId":"a"');
    expect(rowOf('a').getAttribute('aria-grabbed')).toBe('true');

    // Below the target's midline: the dragged row lands after it.
    const dragOver = fireDrag(rowOf('c'), 'dragover', { dataTransfer: transfer, clientY: 70 });
    expect(dragOver.defaultPrevented).toBe(true);
    expect(rowOf('c').className).toContain('is-manual-drop-after');
    expect(container.querySelector('.openbitfun-nav-panel__inline-item-manual-drop-line')).not.toBeNull();

    const dropped = fireDrag(rowOf('c'), 'drop', { dataTransfer: transfer, clientY: 70 });
    expect(dropped.defaultPrevented).toBe(true);
    expect(readManualOrder('workspace:one')).toEqual(['b', 'c', 'a']);
    expect(renderedOrder('workspace:one')).toEqual(['b', 'c', 'a']);
    expect(commitSpy).toHaveBeenCalledTimes(1);
    // The commit hands the view over to the manual order it just wrote, quietly.
    expect(useWorkspaceSessionViewStore.getState().ordering).toBe('manual');
    expectNoNotice();
    expect(handle!.isDragging('a')).toBe(false);
    expect(handle!.dropPositionFor('c')).toBeNull();
    // The drop gesture must not reach the row's open handler.
    expect(handle!.isRowClickSuppressed()).toBe(true);

    // Rows that changed slot start from their previous position for ~160ms.
    expect(animateSpy).toHaveBeenCalled();
    expect(animateSpy.mock.calls[0][1]).toMatchObject({ duration: SESSION_ROW_DROP_SETTLE_MS });

    fireDrag(rowOf('a'), 'dragend', { dataTransfer: transfer });
    expect(handle!.isDragging('a')).toBe(false);
  });

  it('drops above the row when the pointer is over its upper half', () => {
    renderLists([{ scopeKey: 'workspace:one', parents: ['a', 'b', 'c'] }]);

    const transfer = createDataTransfer();
    fireDrag(rowOf('c'), 'dragstart', { dataTransfer: transfer });
    fireDrag(rowOf('a'), 'dragover', { dataTransfer: transfer, clientY: 0 });
    expect(rowOf('a').className).toContain('is-manual-drop-before');

    fireDrag(rowOf('a'), 'drop', { dataTransfer: transfer, clientY: 0 });
    expect(readManualOrder('workspace:one')).toEqual(['c', 'a', 'b']);
    expect(renderedOrder('workspace:one')).toEqual(['c', 'a', 'b']);
  });

  it('drops above the row even when the row never saw a dragover', () => {
    renderLists([{ scopeKey: 'workspace:one', parents: ['a', 'b', 'c'] }]);

    // The drop event alone decides the side: no dragover, so no tracked target
    // and no drop line to fall back on.
    expect(handle!.dropPositionFor('b')).toBeNull();
    const transfer = createDataTransfer();
    fireDrag(rowOf('c'), 'dragstart', { dataTransfer: transfer });
    fireDrag(rowOf('b'), 'drop', { dataTransfer: transfer, clientY: 30 });

    // 'b' spans 26-52, so 30 is its upper half: 'c' lands above it.
    expect(readManualOrder('workspace:one')).toEqual(['a', 'c', 'b']);
    expect(renderedOrder('workspace:one')).toEqual(['a', 'c', 'b']);
  });

  it('refuses a drop from another scope and leaves both orders untouched', () => {
    renderLists([
      { scopeKey: 'workspace:one', parents: ['one-a', 'one-b'] },
      { scopeKey: 'workspace:two', parents: ['two-a', 'two-b'] },
    ]);

    const transfer = createDataTransfer();
    fireDrag(rowOf('one-a'), 'dragstart', { dataTransfer: transfer });

    const dragOver = fireDrag(rowOf('two-b'), 'dragover', { dataTransfer: transfer, clientY: 70 });
    // No preventDefault: the browser keeps showing "no drop" over the foreign row.
    expect(dragOver.defaultPrevented).toBe(false);
    expect(rowOf('two-b').className).not.toContain('is-manual-drop');

    fireDrag(rowOf('two-b'), 'drop', { dataTransfer: transfer, clientY: 70 });
    expect(readManualOrder('workspace:two')).toEqual([]);
    expect(readManualOrder('workspace:one')).toEqual([]);
    expect(renderedOrder('workspace:two')).toEqual(['two-a', 'two-b']);
    expect(renderedOrder('workspace:one')).toEqual(['one-a', 'one-b']);
  });

  it('reorders a child among its own siblings only', () => {
    renderLists([{
      scopeKey: 'workspace:one',
      parents: ['p1', 'p2'],
      children: { p1: ['c1', 'c2'], p2: ['d1'] },
    }]);

    const transfer = createDataTransfer();
    fireDrag(rowOf('c1'), 'dragstart', { dataTransfer: transfer });

    // A child of another parent is not a sibling: no drop.
    expect(fireDrag(rowOf('d1'), 'dragover', { dataTransfer: transfer, clientY: 70 }).defaultPrevented).toBe(false);

    expect(fireDrag(rowOf('c2'), 'dragover', { dataTransfer: transfer, clientY: 70 }).defaultPrevented).toBe(true);

    fireDrag(rowOf('c2'), 'drop', { dataTransfer: transfer, clientY: 70 });
    expect(renderedOrder('workspace:one')).toEqual(['p1', 'c2', 'c1', 'p2', 'd1']);
    expect(readManualOrder('workspace:one')).toEqual(['p1', 'c2', 'c1', 'p2', 'd1']);
  });

  it('keeps the stored order bounded when a session leaves the list', () => {
    renderLists([{ scopeKey: 'workspace:one', parents: ['a', 'b', 'c'] }]);

    const transfer = createDataTransfer();
    fireDrag(rowOf('c'), 'dragstart', { dataTransfer: transfer });
    fireDrag(rowOf('a'), 'drop', { dataTransfer: transfer, clientY: 0 });
    expect(readManualOrder('workspace:one')).toEqual(['c', 'a', 'b']);

    renderLists([{ scopeKey: 'workspace:one', parents: ['a', 'c'] }]);

    expect(readManualOrder('workspace:one')).toEqual(['c', 'a']);
    expect(renderedOrder('workspace:one')).toEqual(['c', 'a']);
  });

  it('keeps a drag inside the rendered rows and off a loaded-but-hidden sibling', () => {
    // Five rows are rendered (the default expansion is 5), while the prefetch keeps
    // eight loaded. The three hidden rows are ordered by the same stored order, but
    // they can neither start nor receive a drag, and their slots survive one.
    const loaded = ['r1', 'r2', 'r3', 'r4', 'r5', 'b0', 'b1', 'b2'];
    const rendered = loaded.slice(0, 5);
    renderLists([{ scopeKey: 'workspace:one', parents: loaded, rendered }]);

    expect(renderedOrder('workspace:one')).toEqual(rendered);
    // A row behind the render boundary is not a drag source and has no target.
    expect(handle!.rowDragProps('b0').draggable).toBe(false);
    expect(handle!.rowDragProps('r5').draggable).toBe(true);
    expect(container.querySelector('[data-session-id="b0"]')).toBeNull();
    expect(handle!.dropPositionFor('b0')).toBeNull();

    // A drop between two rendered rows still works...
    const transfer = createDataTransfer();
    fireDrag(rowOf('r1'), 'dragstart', { dataTransfer: transfer });
    fireDrag(rowOf('r3'), 'drop', { dataTransfer: transfer, clientY: 70 });

    expect(renderedOrder('workspace:one')).toEqual(['r2', 'r3', 'r1', 'r4', 'r5']);
    // ...and leaves the slots of the loaded-but-hidden rows exactly where they were.
    expect(readManualOrder('workspace:one')).toEqual(['r2', 'r3', 'r1', 'r4', 'r5', 'b0', 'b1', 'b2']);
    // The last rendered row can only move to a rendered position: it never passes
    // the hidden siblings, so the stored order keeps them behind it.
    const secondTransfer = createDataTransfer();
    fireDrag(rowOf('r5'), 'dragstart', { dataTransfer: secondTransfer });
    fireDrag(rowOf('r4'), 'drop', { dataTransfer: secondTransfer, clientY: 70 });
    expect(renderedOrder('workspace:one')).toEqual(['r2', 'r3', 'r1', 'r5', 'r4']);
    expect(readManualOrder('workspace:one')).toEqual(['r2', 'r3', 'r1', 'r5', 'r4', 'b0', 'b1', 'b2']);
  });

  it('leaves rows static outside the workspace view preferences', () => {
    renderLists([{ scopeKey: 'workspace:one', parents: ['a', 'b'], enabled: false }]);

    expect(rowOf('a').getAttribute('draggable')).toBe('false');
    expect(handle!.rowDragProps('a').draggable).toBe(false);

    // A row that cannot reorder never starts a drag, so the sibling refuses it too.
    const transfer = createDataTransfer();
    fireDrag(rowOf('a'), 'dragstart', { dataTransfer: transfer });
    expect(transfer.getData(SESSION_ROW_DRAG_MIME_TYPE)).toBe('');
    expect(fireDrag(rowOf('b'), 'dragover', { dataTransfer: transfer, clientY: 70 }).defaultPrevented).toBe(false);

    expect(readManualOrder('workspace:one')).toEqual([]);
    expect(renderedOrder('workspace:one')).toEqual(['a', 'b']);
  });
});

describe('SessionsSection manual reorder wiring', () => {
  // jsdom turns `import.meta.url` into an http URL, so the section source is read
  // from disk by walking up from the vitest working directory instead.
  const source = (): string => {
    const relativePath = 'src/app/components/NavPanel/sections/sessions/SessionsSection.tsx';
    let directory = process.cwd();
    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = join(directory, relativePath);
      if (existsSync(candidate)) {
        return readFileSync(candidate, 'utf8').replace(/\r\n/g, '\n');
      }
      directory = dirname(directory);
    }
    throw new Error(`SessionsSection.tsx not found from ${process.cwd()}`);
  };

  it('orders the visible list by the stored manual order of its scope', () => {
    const text = source();
    expect(text).toContain("} from './sessionManualReorder';");
    expect(text).toContain('useSessionManualOrder(manualSessionOrderScopeKey)');
    expect(text).toContain("const isManualOrdering = sessionOrdering === 'manual';");
    expect(text).toContain('? orderSessionsForManualView(list, manualSessionOrder)');
    expect(text).toContain(': [...list].sort(compareForCurrentView);');
    expect(text).toContain('topLevelSessions: orderForCurrentView(parents),');
  });

  it('wires the row drag handlers, the drop line and the click guard', () => {
    const text = source();
    expect(text).toContain('{...sessionReorder.rowDragProps(session.sessionId)}');
    expect(text).toContain('is-manual-drop-${dropPosition}');
    expect(text).toContain('openbitfun-nav-panel__inline-item-manual-drop-line');
    expect(text).toContain('sessionReorder.isRowClickSuppressed()');
    expect(text).toContain('sessionReorder.isDragging(session.sessionId)');
    // The inline title editor keeps the text selection drag.
    expect(text).toContain('enabled: useWorkspaceViewPreferences && editingSessionId === null,');
  });

  it('switches the session view to manual ordering when a reorder commits, without a notice', () => {
    const text = source();
    expect(text).toContain('onManualOrderCommit: switchSessionViewToManualOrdering,');
    // The drag is the only way to reorder: no row-menu move items, no toast.
    expect(text).not.toContain('nav-session-menu-move-');
    expect(text).not.toContain('moveByOffset');
    expect(text).not.toContain('notificationService.info(');
    expect(text).not.toContain('manualOrderSwitched');
  });
});
