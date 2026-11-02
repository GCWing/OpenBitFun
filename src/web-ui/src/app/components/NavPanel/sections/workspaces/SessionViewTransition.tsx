import { Component, createRef, type ReactNode, type RefObject } from 'react';
import type { WorkspaceSessionGrouping } from '../../workspaceSessionView';
import './SessionViewTransition.scss';

const MOVE_MS = 240;
const ENTER_MS = 140;
const EXIT_MS = 100;
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const ROW_SELECTOR = '.openbitfun-nav-panel__inline-item[data-session-id]';
const HEADER_SELECTOR = '.openbitfun-nav-panel__workspace-item-card[data-workspace-id]';
const COPY_SELECTOR = '.openbitfun-nav-panel__inline-item-main';

interface Props {
  grouping: WorkspaceSessionGrouping;
  surfaceId: string;
  scrollRootRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

interface Row {
  element: HTMLElement;
  rect: DOMRect;
  session: boolean;
}

interface SnapshotRow extends Row {
  clone?: HTMLElement;
  opacity: string;
  copyInset: number;
}

interface Snapshot {
  motion: boolean;
  rows: Map<string, SnapshotRow>;
  anchors: string[];
  scrollTop: number;
}

function readRows(content: HTMLElement): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const element of content.querySelectorAll<HTMLElement>(`${ROW_SELECTOR}, ${HEADER_SELECTOR}`)) {
    if (element.closest('.is-collapsed, [hidden]')) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const session = element.matches(ROW_SELECTOR);
    rows.set(`${session ? 'session' : 'project'}:${session ? element.dataset.sessionId : element.dataset.workspaceId}`, {
      element, rect, session,
    });
  }
  return rows;
}

function intersects(rect: DOMRect, viewport: DOMRect, margin = 0): boolean {
  return rect.bottom > viewport.top - margin && rect.top < viewport.bottom + margin
    && rect.right > viewport.left && rect.left < viewport.right;
}

function readViewport(root: HTMLElement, scrollRoot?: HTMLElement | null): DOMRect {
  const rect = (scrollRoot ?? root).getBoundingClientRect();
  const header = root.closest('[data-openbitfun-section="sessions"]')
    ?.querySelector('[data-openbitfun-part="stickySectionHeader"]');
  const top = Math.max(rect.top, header?.getBoundingClientRect().bottom ?? rect.top);
  return new DOMRect(rect.left, top, rect.width, Math.max(0, rect.bottom - top));
}

/** Keep ancestor selectors and inherited theme/rail values without copying a live React tree. */
function cloneWithContext(element: HTMLElement, boundary: HTMLElement): HTMLElement {
  let clone = element.cloneNode(true) as HTMLElement;
  for (let parent = element.parentElement; parent && parent !== boundary; parent = parent.parentElement) {
    const context = parent.cloneNode(false) as HTMLElement;
    context.style.display = 'contents';
    context.appendChild(clone);
    clone = context;
  }
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of ['id', 'data-testid', 'data-session-id', 'data-workspace-id', 'aria-controls', 'aria-labelledby', 'aria-describedby']) {
      node.removeAttribute(attribute);
    }
  }
  return clone;
}

function captureRow(row: Row, boundary: HTMLElement, motion = true): SnapshotRow {
  const copy = row.element.querySelector<HTMLElement>(COPY_SELECTOR);
  return {
    ...row,
    clone: motion ? cloneWithContext(row.element, boundary) : undefined,
    opacity: getComputedStyle(row.element).opacity || '1',
    copyInset: copy ? copy.getBoundingClientRect().left - row.rect.left : 0,
  };
}

/**
 * Grouping replaces the session subtree. A pre-mutation snapshot is necessary:
 * effect cleanup runs after some DOM mutations and cannot reliably measure the
 * old layout. Keep data loading in the existing owners; only this decoration
 * survives the commit, and only viewport rows get animations or exit copies.
 */
export default class SessionViewTransition extends Component<Props, object, Snapshot | null> {
  private rootRef = createRef<HTMLDivElement>();
  private contentRef = createRef<HTMLDivElement>();
  private exitsRef = createRef<HTMLDivElement>();
  private animations: Animation[] = [];
  private exits = new Map<string, Row>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private removeListeners: (() => void) | undefined;

  private finish = (): void => {
    clearTimeout(this.timer);
    this.removeListeners?.();
    this.removeListeners = undefined;
    this.animations.forEach(animation => animation.cancel());
    this.animations = [];
    this.exits.clear();
    this.exitsRef.current?.replaceChildren();
    this.rootRef.current?.removeAttribute('data-openbitfun-state');
  };

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const root = this.rootRef.current;
    const content = this.contentRef.current;
    if (previous.grouping === this.props.grouping || previous.surfaceId !== this.props.surfaceId
      || !root || !content) return null;
    const motion = typeof root.animate === 'function'
      && !root.closest('[data-motion="none"]')
      && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const viewport = readViewport(root, this.props.scrollRootRef?.current);
    const rows = new Map<string, SnapshotRow>();
    const anchors: string[] = [];
    for (const [key, row] of readRows(content)) {
      if (!intersects(row.rect, viewport, 40)) continue;
      rows.set(key, captureRow(row, content, motion));
      if (row.session && intersects(row.rect, viewport)) {
        if (row.element.dataset.sessionActive === 'true') anchors.unshift(key);
        else anchors.push(key);
      }
    }
    // Reversing an unfinished switch also picks up headers still fading out.
    for (const [key, row] of this.exits) {
      if (motion && !rows.has(key) && this.exitsRef.current) {
        rows.set(key, captureRow({ ...row, rect: row.element.getBoundingClientRect() }, this.exitsRef.current));
      }
    }
    root.setAttribute('data-openbitfun-state', 'transitioning');
    return { motion, rows, anchors, scrollTop: this.props.scrollRootRef?.current?.scrollTop ?? 0 };
  }

  componentDidUpdate(previous: Props, _state: object, snapshot: Snapshot | null): void {
    if (previous.surfaceId !== this.props.surfaceId || previous.grouping !== this.props.grouping) this.finish();
    if (!snapshot) return;
    const root = this.rootRef.current!;
    const content = this.contentRef.current!;
    const layer = this.exitsRef.current!;
    const scrollRoot = this.props.scrollRootRef?.current;
    let nextRows = readRows(content);

    // At the top, keep the section header and pinned assistant stationary.
    // Further down, retain the first surviving reading anchor, clamped to the
    // target's real scroll range (never add spacer content to force an anchor).
    if (scrollRoot && snapshot.scrollTop > 0) {
      const anchor = snapshot.anchors.find(key => nextRows.has(key));
      if (anchor) {
        const delta = nextRows.get(anchor)!.rect.top - snapshot.rows.get(anchor)!.rect.top;
        scrollRoot.scrollTop = Math.max(0, Math.min(scrollRoot.scrollHeight - scrollRoot.clientHeight, scrollRoot.scrollTop + delta));
        nextRows = readRows(content);
      }
    }
    if (!snapshot.motion) return;

    const viewport = readViewport(root, scrollRoot);
    const rootRect = root.getBoundingClientRect();
    const moving = new Set<string>();
    root.setAttribute('data-openbitfun-state', 'transitioning');
    for (const [key, row] of nextRows) {
      if (!intersects(row.rect, viewport, 40)) continue;
      const before = snapshot.rows.get(key);
      const dx = before ? before.rect.left - row.rect.left : 0;
      const dy = before ? before.rect.top - row.rect.top : 0;
      const canMove = before && Math.abs(dy) <= Math.min(320, viewport.height * 0.65);
      if (canMove) {
        moving.add(key);
        this.animate(row.element, [
          { transform: `translate(${dx}px, ${dy}px)`, opacity: before.opacity },
          { transform: 'translate(0, 0)', opacity: 1 },
        ], MOVE_MS);
        // Indent belongs to the text rail. Translate the copy separately so
        // text stays crisp and the selection surface does not shrink or scale.
        const copy = row.element.querySelector<HTMLElement>(COPY_SELECTOR);
        if (copy) {
          const copyDx = before.copyInset - (copy.getBoundingClientRect().left - row.element.getBoundingClientRect().left);
          if (Math.abs(copyDx) > 0.5) this.animate(copy, [{ transform: `translateX(${copyDx}px)` }, { transform: 'translateX(0)' }], MOVE_MS);
        }
      } else {
        this.animate(row.element, [{ opacity: 0 }, { opacity: 1 }], ENTER_MS);
      }
    }

    for (const [key, before] of snapshot.rows) {
      if (!before.clone || moving.has(key) || !intersects(before.rect, viewport)) continue;
      const clone = before.clone;
      const element = clone.matches('.openbitfun-nav-panel__inline-item, .openbitfun-nav-panel__workspace-item-card')
        ? clone : clone.querySelector<HTMLElement>('.openbitfun-nav-panel__inline-item, .openbitfun-nav-panel__workspace-item-card')!;
      Object.assign(element.style, {
        position: 'absolute', top: `${before.rect.top - rootRect.top}px`, left: `${before.rect.left - rootRect.left}px`,
        width: `${before.rect.width}px`, height: `${before.rect.height}px`, maxWidth: 'none', margin: '0',
        boxSizing: 'border-box', transform: 'none', transition: 'none',
      });
      layer.appendChild(clone);
      const copy = element.querySelector<HTMLElement>(COPY_SELECTOR);
      if (copy) {
        const copyDx = before.copyInset - (copy.getBoundingClientRect().left - element.getBoundingClientRect().left);
        if (Math.abs(copyDx) > 0.5) copy.style.transform = `translateX(${copyDx}px)`;
      }
      this.exits.set(key, { ...before, element });
      this.animate(element, [{ opacity: before.opacity }, { opacity: 0 }], EXIT_MS);
    }

    const scrollTop = scrollRoot?.scrollTop;
    const onScroll = () => { if (scrollRoot?.scrollTop !== scrollTop) this.finish(); };
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (root.getBoundingClientRect().width !== rootRect.width) this.finish();
    });
    resize?.observe(root);
    scrollRoot?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', this.finish);
    media?.addEventListener('change', this.finish);
    this.removeListeners = () => {
      resize?.disconnect();
      scrollRoot?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', this.finish);
      media?.removeEventListener('change', this.finish);
    };
    this.timer = setTimeout(this.finish, MOVE_MS + 40);
  }

  private animate(element: HTMLElement, keyframes: Keyframe[], duration: number): void {
    this.animations.push(element.animate(keyframes, { duration, easing: EASING, fill: 'both' }));
  }

  componentWillUnmount(): void {
    this.finish();
  }

  render(): ReactNode {
    return (
      <div ref={this.rootRef} className="openbitfun-nav-panel__session-view-transition" onPointerDownCapture={this.finish}
        data-openbitfun-component="workspace-list-section" data-openbitfun-part="viewTransition">
        <div ref={this.contentRef} className="openbitfun-nav-panel__session-view-content"
          data-openbitfun-component="workspace-list-section" data-openbitfun-part="viewContent">{this.props.children}</div>
        <div ref={this.exitsRef} className="openbitfun-nav-panel__session-view-exits" aria-hidden="true" {...{ inert: '' }}
          data-openbitfun-component="workspace-list-section" data-openbitfun-part="viewExits" />
      </div>
    );
  }
}
