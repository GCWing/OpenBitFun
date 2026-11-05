import { $, browser } from '@wdio/globals';

export interface ScrollFrame {
  time: number;
  top: number;
  height: number;
  rows: number;
  reverse: number;
  blank: boolean;
  uncoveredPx: number;
  readingAnchor?: { key?: string; top: number; height: number };
  anchor?: Array<{ key: string | undefined; top: number; height: number }>;
}
export interface ScrollProbe {
  frames: ScrollFrame[];
  rectReads: number;
  scans: number;
  wheelEvents: number;
  wheelTimes?: number[];
  writes: Array<{ time: number; before: number; after: number; value: number; stack: string | undefined }>;
  slowLayoutReads?: Array<{ time: number; durationMs: number; property: string; node: string; stack?: string }>;
  implicitScrollChanges?: Array<{ time: number; before: number; after: number; property: string; stack?: string; layout?: unknown }>;
  mutations?: Array<{ time: number; changes: unknown[] }>;
}

/** Production transcript, driven through the embedded driver's wheel actions. */
export class FlowChatScrollPage {
  async measureSessionOpen(id: string) {
    await browser.execute((id: string) => {
      let clickedAt: number | undefined;
      const milestones: Record<string, number> = {};
      let paintFrame: number | undefined;
      const sample = () => {
        if (clickedAt === undefined) return;
        const root = document.querySelector<HTMLElement>(`[data-testid="flowchat-container"][data-session-id="${id}"]`);
        if (!root) return;
        const at = performance.now() - clickedAt;
        milestones.attachedMs ??= at;
        if (root.querySelector('.flow-text-block, .user-message-content')) milestones.textDomMs ??= at;
        if (root.querySelector('[data-open-viewport-settled="true"]')) milestones.viewportReadyMs ??= at;
        if (milestones.viewportReadyMs !== undefined && !root.querySelector('.history-session-loading:not([data-history-loading-phase="idle"])')) {
          milestones.interactiveMs ??= at;
          if (paintFrame === undefined && milestones.presentedMs === undefined) paintFrame = requestAnimationFrame(() => {
            paintFrame = requestAnimationFrame(() => { milestones.presentedMs = performance.now() - clickedAt!; paintFrame = undefined; });
          });
        }
      };
      const clicked = (event: Event) => {
        if (!(event.target instanceof Element) || !event.target.closest(`[data-testid="nav-session-item"][data-session-id="${id}"]`)) return;
        clickedAt = performance.now();
      };
      const observer = new MutationObserver(sample);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-session-id', 'data-open-viewport-settled', 'data-history-loading-phase'] });
      document.addEventListener('click', clicked, true);
      (window as any).__flowchatOpenMeasurement = () => {
        sample(); observer.disconnect(); document.removeEventListener('click', clicked, true);
        if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
        return { sessionId: id, ...milestones };
      };
    }, id);
    try {
      await this.openSession(id);
      // Two presentation opportunities, not the separate 24-frame scroll settle.
      await browser.executeAsync((done: () => void) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    } finally {
      const result = await browser.execute(() => {
        const result = (window as any).__flowchatOpenMeasurement();
        delete (window as any).__flowchatOpenMeasurement; return result;
      });
      this.lastOpenMeasurement = result;
    }
    return this.lastOpenMeasurement as { sessionId: string; attachedMs: number; textDomMs: number;
      viewportReadyMs: number; interactiveMs: number; presentedMs: number };
  }
  private lastOpenMeasurement: unknown;

  async openSession(id: string) {
    const row = $(`[data-testid="nav-session-item"][data-session-id="${id}"]`);
    await row.waitForExist({ timeout: 30000 });
    await row.click();
    await browser.waitUntil(async () => (await $('[data-testid="flowchat-message-list"]').getAttribute('data-open-viewport-settled')) === 'true', { timeout: 30000 });
    // Viewport placement precedes the skeleton/text handoff. Its interaction
    // shield otherwise consumes the first wheel actions in a cold open.
    await browser.waitUntil(() => browser.execute(() =>
      !document.querySelector('.history-session-loading:not([data-history-loading-phase="idle"])'),
    ), { timeout: 30000 });
  }

  async settle() {
    await browser.executeAsync((done: () => void) => {
      let frames = 24;
      const tick = () => --frames ? requestAnimationFrame(tick) : done();
      requestAnimationFrame(tick);
    });
  }

  async startProbe(direction: number) {
    await browser.execute((direction: number, diagnostics: boolean) => {
      const scroller = document.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      const probe: ScrollProbe = { frames: [], rectReads: 0, scans: 0, wheelEvents: 0, writes: [] };
      const rect = Element.prototype.getBoundingClientRect;
      const query = Element.prototype.querySelectorAll;
      const restoreReads: Array<() => void> = [];
      let trackNativeShift = (_property: string) => {};
      const traceRead = (element: Element, property: string, start: number) => {
        trackNativeShift(property);
        const durationMs = performance.now() - start;
        if (durationMs >= 4) (probe.slowLayoutReads ??= []).push({ time: start, durationMs, property, node: element.className, stack: new Error().stack });
      };
      if (diagnostics) for (const [prototype, properties] of [
        [Element.prototype, ['scrollHeight', 'clientHeight', 'clientWidth']],
        [HTMLElement.prototype, ['offsetHeight', 'offsetWidth']],
      ] as const) for (const property of properties) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
        if (!descriptor?.get || !descriptor.configurable) continue;
        Object.defineProperty(prototype, property, { ...descriptor, get(this: Element) {
          const start = performance.now();
          const result = descriptor.get!.call(this);
          traceRead(this, property, start);
          return result;
        } });
        restoreReads.push(() => Object.defineProperty(prototype, property, descriptor));
      }
      let sampling = false, frame = 0, previous: HTMLElement | undefined, previousTop = 0;
      let prototype: object | null = scroller;
      let scrollDescriptor: PropertyDescriptor | undefined;
      while (prototype && !scrollDescriptor) { scrollDescriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop'); prototype = Object.getPrototypeOf(prototype); }
      let lastNativeTop = scroller.scrollTop;
      let readingNativeShift = false;
      if (diagnostics && scrollDescriptor?.get) trackNativeShift = property => {
        if (readingNativeShift) return;
        readingNativeShift = true;
        const after = scrollDescriptor!.get!.call(scroller) as number;
        if (Math.abs(after - lastNativeTop) > 1) (probe.implicitScrollChanges ??= []).push({
          time: performance.now(), before: lastNativeTop, after, property, stack: new Error().stack,
          layout: { height: scroller.scrollHeight, viewport: scroller.clientHeight, header: scroller.querySelector('.message-list-header-block')?.getBoundingClientRect().height,
            padding: scroller.querySelector<HTMLElement>('.virtual-message-list__items')?.style.paddingTop,
            rows: [...query.call(scroller, '.virtual-item-wrapper')].map(node => ({ key: (node as HTMLElement).dataset.virtualItemKey,
              top: rect.call(node).top, height: rect.call(node).height })) },
        });
        lastNativeTop = after;
        readingNativeShift = false;
      };
      if (diagnostics && scrollDescriptor?.get && scrollDescriptor?.set) Object.defineProperty(scroller, 'scrollTop', {
        configurable: true, get() { return scrollDescriptor!.get!.call(this); },
        set(value: number) {
          const before = scrollDescriptor!.get!.call(this);
          scrollDescriptor!.set!.call(this, value);
          const after = scrollDescriptor!.get!.call(this);
          lastNativeTop = after;
          if (Math.abs(after - before) > 1) probe.writes.push({ time: performance.now(), before, after, value, stack: new Error().stack });
        },
      });
      Element.prototype.getBoundingClientRect = function () {
        if (!sampling && (this === scroller || this.classList.contains('virtual-item-wrapper'))) probe.rectReads++;
        const start = diagnostics ? performance.now() : 0;
        const result = rect.call(this);
        if (diagnostics) traceRead(this, 'getBoundingClientRect', start);
        return result;
      };
      Element.prototype.querySelectorAll = function (this: Element, selector: string) {
        if (!sampling && this === scroller) probe.scans++;
        return query.call(this, selector);
      } as typeof query;
      const onWheel = () => { probe.wheelEvents++; (probe.wheelTimes ??= []).push(performance.now()); };
      scroller.addEventListener('wheel', onWheel, { passive: true });
      const mutations = diagnostics ? new MutationObserver(records => {
        (probe.mutations ??= []).push({ time: performance.now(), changes: records.map(record => ({
          kind: record.type, attribute: record.attributeName, old: record.oldValue,
          value: record.attributeName ? (record.target as Element).getAttribute(record.attributeName) : undefined,
          node: (record.target as Element).className,
          key: (record.target as HTMLElement).dataset?.virtualItemKey,
          added: record.addedNodes.length, removed: record.removedNodes.length,
        })) });
      }) : undefined;
      mutations?.observe(scroller, { subtree: true, childList: true, attributes: true, attributeOldValue: true,
        attributeFilter: ['style', 'class', 'data-virtual-index'] });
      const tick = (time: number) => {
        sampling = true;
        const bounds = rect.call(scroller);
        const rows = [...query.call(scroller, '.virtual-item-wrapper')] as HTMLElement[];
        const visible = rows.filter(row => { const r = rect.call(row); return r.bottom > bounds.top && r.top < bounds.bottom && r.height > 0; });
        const reverse = previous?.isConnected ? Math.max(0, (rect.call(previous).top - previousTop) * direction) : 0;
        // Native history can add leading Turn padding to a surviving first
        // wrapper. Its top moves while the text and following rows stay put.
        // Judge reversal from painted content, not that newly reserved space.
        previous = visible.map(row => (row.firstElementChild ?? row) as HTMLElement).find(node => {
          const r = rect.call(node); return r.bottom > bounds.top && r.top < bounds.bottom;
        });
        previousTop = previous ? rect.call(previous).top : 0;
        // Measure holes in the virtual window, excluding intentional trailing
        // reservation. Geometry cannot detect a compositor-only paint defect.
        const footer = scroller.querySelector('.virtual-message-list__footer-block');
        const bottom = Math.min(bounds.bottom, footer ? rect.call(footer).top : bounds.bottom);
        let coveredTo = bounds.top, uncoveredPx = 0;
        for (const row of visible) {
          const r = rect.call(row);
          if (r.top > coveredTo) uncoveredPx += Math.max(0, Math.min(r.top, bottom) - coveredTo);
          coveredTo = Math.max(coveredTo, r.bottom);
        }
        uncoveredPx += Math.max(0, bottom - coveredTo);
        probe.frames.push({ time, top: scroller.scrollTop, height: scroller.scrollHeight, rows: rows.length, reverse, blank: visible.length === 0, uncoveredPx,
          readingAnchor: previous ? { key: previous.closest<HTMLElement>('.virtual-item-wrapper')?.dataset.virtualItemKey,
            top: rect.call(previous).top - bounds.top, height: rect.call(previous).height } : undefined,
          anchor: diagnostics ? rows.map(row => ({ key: row.dataset.virtualItemKey, top: rect.call(row).top - bounds.top, height: rect.call(row).height })) : undefined });
        sampling = false;
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      (window as any).__flowchatScrollProbe = () => {
        cancelAnimationFrame(frame);
        mutations?.disconnect();
        Element.prototype.getBoundingClientRect = rect;
        Element.prototype.querySelectorAll = query;
        restoreReads.forEach(restore => restore());
        scroller.removeEventListener('wheel', onWheel);
        if (diagnostics) delete (scroller as any).scrollTop;
        return probe;
      };
    }, direction, process.env.OPENBITFUN_SCROLL_DIAGNOSTICS === '1');
  }

  async wheel(delta: number, count = 72) {
    const position = await browser.execute(() => {
      const r = document.querySelector('[data-flowchat-scroller]')!.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 3) };
    });
    await browser.performActions([{ type: 'wheel', id: 'history-wheel', actions: Array.from({ length: count }, () => ({
      type: 'scroll', origin: 'viewport', ...position, deltaX: 0, deltaY: delta, duration: 24,
    })) }]);
    await browser.releaseActions();
  }

  async stopProbe(): Promise<ScrollProbe> {
    return browser.execute(() => {
      const probe = (window as any).__flowchatScrollProbe();
      delete (window as any).__flowchatScrollProbe;
      return probe;
    });
  }

  async disposeProbe() {
    await browser.execute(() => {
      (window as any).__flowchatScrollProbe?.();
      delete (window as any).__flowchatScrollProbe;
    });
  }

  async enterDraft(text: string) {
    const editor = $('[data-testid="chat-input-container"] .rich-text-input[contenteditable="true"]');
    await editor.waitForExist();
    await editor.click();
    await browser.keys(text);
  }

  async draftText() {
    return $('[data-testid="chat-input-container"] .rich-text-input[contenteditable="true"]').getText();
  }

  async findFirstResult(query: string) {
    await $('[data-testid="flowchat-header-search"]').click();
    await $('[data-testid="flowchat-header-search-bar"] input').setValue(query);
    // Trajectory search is debounced. Wait for results before navigating them.
    await browser.waitUntil(async () => /\/\s*[1-9]\d*/.test(
      await $('.flowchat-header__search-status').getText(),
    ), { timeout: 15000 });
    await browser.keys('Enter');
    await browser.waitUntil(() => browser.execute(() => {
      const line = document.querySelector<HTMLElement>('.flowchat-search-line:not([hidden])');
      const scroller = document.querySelector<HTMLElement>('[data-flowchat-scroller]');
      if (!line || !scroller) return false;
      const a = line.getBoundingClientRect(), b = scroller.getBoundingClientRect();
      return a.bottom > b.top && a.top < b.bottom;
    }), { timeout: 15000 });
  }

  async closeSearch() {
    await browser.keys('Escape');
  }

  async anchor() {
    return browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      const top = scroller.getBoundingClientRect().top;
      const row = [...scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper')].find(row => {
        const rect = row.getBoundingClientRect(); return rect.bottom > top && rect.top < top + scroller.clientHeight && rect.height > 0;
      });
      return { key: row?.dataset.virtualItemKey, offset: row ? row.getBoundingClientRect().top - top : 0, top: scroller.scrollTop };
    });
  }

  async memory() {
    return browser.execute(() => {
      // The embedded driver's registry owns strong DOM references. A detached
      // element is already a stale WebDriver handle; retaining it would keep an
      // old React tree alive and measure the harness instead of the product.
      // Never clear application caches or force GC during residency sampling.
      const registry = (window as unknown as { __openbitfunWdElements?: Record<string, Node> }).__openbitfunWdElements;
      let releasedStaleHandles = 0;
      for (const [id, node] of Object.entries(registry ?? {})) {
        if (!node.isConnected) { delete registry![id]; releasedStaleHandles++; }
      }
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
      const resources = (window as unknown as { __OPENBITFUN_RESOURCE_BUDGET__?: { snapshot: () => Array<{ bytes: number; kind: string; protectedReason?: string }> } }).__OPENBITFUN_RESOURCE_BUDGET__?.snapshot();
      const highlights = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights;
      const diagnostics = window as unknown as { __flowchatWeakRoots?: { seen: WeakSet<Element>; roots: Array<WeakRef<Element>> } };
      const roots = diagnostics.__flowchatWeakRoots ??= { seen: new WeakSet(), roots: [] };
      const currentRoot = document.querySelector('[data-testid="flowchat-message-list"]');
      if (currentRoot && !roots.seen.has(currentRoot)) {
        roots.seen.add(currentRoot); roots.roots.push(new WeakRef(currentRoot));
      }
      const detachedRootsAlive = roots.roots.filter(ref => { const node = ref.deref(); return node && !node.isConnected; }).length;
      return { domNodes: document.querySelectorAll('*').length,
        driverHandles: Object.keys(registry ?? {}).length, releasedStaleHandles,
        mountedRows: document.querySelectorAll('.virtual-item-wrapper').length,
        resources: resources ? { entries: resources.length, bytes: resources.reduce((sum, item) => sum + item.bytes, 0),
          derivedBytes: resources.filter(item => item.kind === 'derived').reduce((sum, item) => sum + item.bytes, 0),
          protectedEntries: resources.filter(item => item.protectedReason).length } : null,
        highlightRanges: highlights ? [...highlights.values()].reduce((sum, value) => sum + value.size, 0) : null,
        observedTranscriptRoots: roots.roots.length, detachedTranscriptRootsAlive: detachedRootsAlive,
        usedHeapMiB: memory ? memory.usedJSHeapSize / 1048576 : null,
        allocatedHeapMiB: memory ? memory.totalJSHeapSize / 1048576 : null };
    });
  }

  async visibleTool(name: string) {
    return browser.execute((name: string) => {
      const scroller = document.querySelector('[data-flowchat-scroller]')!;
      const bounds = scroller.getBoundingClientRect();
      for (const card of scroller.querySelectorAll<HTMLElement>('.flow-tool-card-wrapper[data-tool-name]')) {
        if (card.dataset.toolName !== name) continue;
        const header = card.querySelector<HTMLElement>('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"]');
        if (!header) continue;
        const rect = header.getBoundingClientRect();
        if (rect.top > bounds.top + 24 && rect.bottom < bounds.bottom - 180) return {
          id: card.dataset.toolCardId!, x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2),
        };
      }
      return null;
    }, name);
  }

  async visibleCollapsedGroup() {
    return browser.execute(() => {
      const bounds = document.querySelector('[data-flowchat-scroller]')!.getBoundingClientRect();
      for (const header of document.querySelectorAll<HTMLElement>('[data-testid="chat-explore-group"] [aria-expanded="false"], [data-testid="chat-file-edit-group"] [aria-expanded="false"]')) {
        const rect = header.getBoundingClientRect();
        if (rect.top > bounds.top + 24 && rect.bottom < bounds.bottom - 180) return {
          x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2),
        };
      }
      return null;
    });
  }

  async clickPoint(point: { x: number; y: number }) {
    await browser.performActions([{ type: 'pointer', id: 'flowchat-disclosure', parameters: { pointerType: 'mouse' }, actions: [
      { type: 'pointerMove', origin: 'viewport', x: point.x, y: point.y, duration: 0 },
      { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
    ] }]);
    await browser.releaseActions();
  }
}
