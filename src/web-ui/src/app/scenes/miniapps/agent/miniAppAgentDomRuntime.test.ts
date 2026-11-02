/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canReadSurfaceDocument,
  clickNode,
  findNodes,
  inspectDocument,
  pressKey,
  readNode,
  scrollSurface,
  typeIntoNode,
  type MiniAppAgentDomSurface,
} from './miniAppAgentDomRuntime';
import { MINIAPP_AGENT_MAX_NODES, MiniAppAgentSurfaceError } from './miniAppAgentProtocol';

const TOOLBAR_HTML = `
  <header>
    <h1>Pomodoro</h1>
    <button data-testid="start-button" aria-label="Start timer" type="button">Start</button>
    <button id="stop" disabled>Stop</button>
    <input id="label" aria-label="Session label" value="focus" />
    <div style="display:none"><button>Hidden</button></div>
    <script>void 0;</script>
  </header>
`;

function createSurface(html = TOOLBAR_HTML): MiniAppAgentDomSurface {
  const doc = document.implementation.createHTMLDocument('Pomodoro');
  doc.body.innerHTML = html;
  const iframe = { contentDocument: doc } as unknown as HTMLIFrameElement;
  return { appId: 'demo', iframe };
}

function unreadableSurface(): MiniAppAgentDomSurface {
  const getter = () => {
    throw new Error('Blocked a frame with origin from accessing a cross-origin frame');
  };
  const iframe = Object.defineProperty({}, 'contentDocument', { get: getter }) as unknown as HTMLIFrameElement;
  return { appId: 'opaque', iframe };
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MiniAppAgentSurfaceError);
    return (error as MiniAppAgentSurfaceError).code;
  }
  throw new Error('expected a typed surface error');
}

function flatNodes(nodes: ReturnType<typeof inspectDocument>['tree']): { role?: string; name?: string }[] {
  return nodes.flatMap((node) => [node, ...flatNodes(node.children ?? [])]);
}

describe('MiniApp agent DOM runtime', () => {
  it('keeps old handles stale after the entire Web UI runtime reloads', async () => {
    vi.resetModules();
    const before = await import('./miniAppAgentDomRuntime');
    const first = createSurface();
    const oldKey = before.findNodes(first, { testId: 'start-button' })[0].nodeKey!;
    vi.resetModules();
    const after = await import('./miniAppAgentDomRuntime');
    const second = createSurface();
    const newKey = after.findNodes(second, { testId: 'start-button' })[0].nodeKey!;
    const click = vi.fn();
    second.iframe.contentDocument!.querySelector('button')!.addEventListener('click', click);
    expect(newKey).not.toBe(oldKey);
    expect(() => after.clickNode(second, oldKey)).toThrow('STALE_TARGET');
    expect(click).not.toHaveBeenCalled();
  });

  afterEach(() => document.body.replaceChildren());

  it('preserves form whitespace and never exposes password values', () => {
    const surface = createSurface('<textarea></textarea><input type="password" aria-label="Secret" />');
    const text = '  first\n\tsecond  ';
    const textarea = surface.iframe.contentDocument!.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = text;
    const password = surface.iframe.contentDocument!.querySelector('input') as HTMLInputElement;
    password.value = 'hidden-secret';
    const textNode = findNodes(surface, { selector: 'textarea' })[0];
    const passwordNode = findNodes(surface, { selector: 'input' })[0];
    expect(readNode(surface, textNode.nodeKey!).value).toBe(text);
    expect(readNode(surface, passwordNode.nodeKey!).value).toBeUndefined();
    expect(JSON.stringify(inspectDocument(surface))).not.toContain('hidden-secret');
  });

  it('rejects readonly and hidden targets before dispatching input', () => {
    const surface = createSurface('<input readonly value="locked" /><button>Delete</button>');
    const input = findNodes(surface, { selector: 'input' })[0];
    expect(() => typeIntoNode(surface, input.nodeKey!, 'changed')).toThrow('read-only');
    const button = surface.iframe.contentDocument!.querySelector('button')!;
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    const buttonNode = findNodes(surface, { selector: 'button' })[0];
    button.hidden = true;
    expect(() => clickNode(surface, buttonNode.nodeKey!)).toThrow('no longer visible');
    expect(clicked).not.toHaveBeenCalled();
  });

  it('uses the native setter for each editable field type', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    iframe.contentDocument!.body.innerHTML = '<input/><textarea></textarea><select><option value="b">B</option></select>';
    const surface = { appId: 'fields', iframe };
    for (const tag of ['input', 'textarea', 'select']) {
      const node = findNodes(surface, { selector: tag })[0];
      const text = tag === 'textarea' ? '  first\nsecond  ' : 'b';
      typeIntoNode(surface, node.nodeKey!, text);
      expect((iframe.contentDocument!.querySelector(tag) as HTMLInputElement).value).toBe(text);
    }
  });

  it('never reuses handles after the frame or its document is replaced', () => {
    const original = createSurface('<button>Original</button>');
    const key = findNodes(original, { role: 'button' })[0].nodeKey!;
    const replacement = createSurface('<button>Delete</button>');
    const nextKey = findNodes(replacement, { role: 'button' })[0].nodeKey!;
    expect(nextKey).not.toBe(key);
    expect(errorCode(() => clickNode(replacement, key))).toBe('STALE_TARGET');

    // The old Document still has connected nodes. Connectivity alone must not
    // allow actions against the document that the frame no longer presents.
    Object.defineProperty(original.iframe, 'contentDocument', { value: replacement.iframe.contentDocument });
    expect(errorCode(() => clickNode(original, key))).toBe('STALE_TARGET');
  });

  it('inspects a bounded, accessibility-shaped tree with node handles', () => {
    const surface = createSurface();
    const result = inspectDocument(surface);
    const nodes = flatNodes(result.tree);

    expect(result.title).toBe('Pomodoro');
    expect(result.truncated).toBe(false);
    expect(nodes.some((node) => node.role === 'button' && node.name === 'Start timer')).toBe(true);
    expect(nodes.some((node) => node.role === 'heading' && node.name === 'Pomodoro')).toBe(true);
    // Hidden containers, scripts, and bare structural wrappers stay out.
    expect(nodes.some((node) => node.name === 'Hidden')).toBe(false);
    expect(nodes.every((node) => typeof (node as { nodeKey?: string }).nodeKey === 'string')).toBe(true);
  });

  it('reuses node handles across observations and finds by priority axes', () => {
    const surface = createSurface();
    const first = inspectDocument(surface);
    const second = inspectDocument(surface);
    expect(JSON.stringify(second.tree)).toBe(JSON.stringify(first.tree));

    const byTestId = findNodes(surface, { testId: 'start-button' });
    expect(byTestId).toHaveLength(1);
    expect(byTestId[0].name).toBe('Start timer');

    const byRole = findNodes(surface, { role: 'button', name: 'Start timer', exact: true });
    expect(byRole).toHaveLength(1);
    expect(byRole[0].testId).toBe('start-button');

    const byText = findNodes(surface, { text: 'Stop' });
    expect(byText).toHaveLength(1);

    const bySelector = findNodes(surface, { selector: '#label' });
    expect(bySelector).toHaveLength(1);
    expect(bySelector[0].role).toBe('textbox');
  });

  it('reports a typed error for an invalid selector instead of throwing raw', () => {
    const surface = createSurface();
    expect(errorCode(() => findNodes(surface, { selector: 'button[' }))).toBe('INVALID_PARAMS');
  });

  it('reads, types, clicks, and presses keys through real DOM events', async () => {
    const surface = createSurface();
    const seen: string[] = [];
    const doc = surface.iframe.contentDocument as Document;
    doc.addEventListener('click', () => seen.push('click'));
    doc.addEventListener('input', () => seen.push('input'));

    const start = findNodes(surface, { testId: 'start-button' })[0];
    const field = findNodes(surface, { selector: '#label' })[0];

    expect(clickNode(surface, start.nodeKey!).detail.role).toBe('button');
    const typed = typeIntoNode(surface, field.nodeKey!, 'deep work', true);
    expect(typed.detail.value).toBe('deep work');
    const read = readNode(surface, field.nodeKey!);
    expect(read.value).toBe('deep work');
    expect(read.attributes['aria-label']).toBe('Session label');

    await pressKey(surface, 'Enter');
    expect(seen).toEqual(expect.arrayContaining(['click', 'input']));
  });

  it('maps game keys to DOM code values and holds them before release', async () => {
    const surface = createSurface('<canvas id="game" width="320" height="240"></canvas>');
    const doc = surface.iframe.contentDocument as Document;
    const events: { type: string; key: string; code: string; at: number }[] = [];
    const started = Date.now();
    for (const type of ['keydown', 'keyup']) {
      doc.addEventListener(type, (event) => {
        const keyboard = event as KeyboardEvent;
        events.push({ type, key: keyboard.key, code: keyboard.code, at: Date.now() - started });
      });
    }

    await pressKey(surface, ' ', { holdMs: 40 });
    await pressKey(surface, 'Left');

    expect(events.map((event) => event.type)).toEqual(['keydown', 'keyup', 'keydown', 'keyup']);
    // A game reads `code` on its own frame; the DOM name alone is not enough.
    expect(events[0]).toMatchObject({ key: ' ', code: 'Space' });
    expect(events[2]).toMatchObject({ key: 'ArrowLeft', code: 'ArrowLeft' });
    // The key has to stay down long enough for a held-input game loop to see it.
    expect(events[1].at - events[0].at).toBeGreaterThanOrEqual(30);
    expect(events[3].at - events[2].at).toBeLessThan(30);
  });

  it('delivers normalized positions as frame-local mouse coordinates, including SVG descendants', () => {
    const surface = createSurface('<svg id="board"><circle id="stone" /></svg>');
    const doc = surface.iframe.contentDocument!;
    const board = doc.querySelector('svg')!;
    const stone = doc.querySelector('circle')!;
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({ left: 80, top: 40, width: 400, height: 200 } as DOMRect);
    const hitTest = vi.fn(() => stone);
    Object.defineProperty(doc, 'elementFromPoint', { configurable: true, value: hitTest });
    const events: MouseEvent[] = [];
    for (const type of ['mousedown', 'mouseup', 'click']) board.addEventListener(type, event => events.push(event as MouseEvent));
    const target = findNodes(surface, { selector: '#board' })[0].nodeKey!;

    clickNode(surface, target, { x: 0.25, y: 0.75 });
    expect(hitTest).toHaveBeenCalledWith(180, 190);
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.clientX).toBe(180);
      expect(event.clientY).toBe(190);
      expect(event.target).toBe(stone);
    }
    events.length = 0;
    clickNode(surface, target);
    expect(events[2]).toMatchObject({ clientX: 280, clientY: 140 });
  });

  it('rejects invalid or obscured positions before sending any input', () => {
    const surface = createSurface('<canvas id="game"></canvas><button id="other">Other</button>');
    const doc = surface.iframe.contentDocument!;
    const canvas = doc.querySelector('canvas')!;
    const input = vi.fn();
    canvas.addEventListener('mousedown', input);
    canvas.addEventListener('click', input);
    const target = findNodes(surface, { selector: '#game' })[0].nodeKey!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 30, width: 200, height: 100 } as DOMRect);
    for (const invalid of [null, {}, { x: '0.5', y: 0.5 }, { x: NaN, y: 0.5 }, { x: -0.1, y: 0 }, { x: 0.5, y: 1 }]) {
      expect(errorCode(() => clickNode(surface, target, invalid))).toBe('INVALID_PARAMS');
    }
    Object.defineProperty(doc, 'elementFromPoint', { configurable: true, value: () => doc.querySelector('#other') });
    expect(errorCode(() => clickNode(surface, target, { x: 0.5, y: 0.5 }))).toBe('INVALID_PARAMS');
    vi.mocked(canvas.getBoundingClientRect).mockReturnValue({ left: 0, top: 0, width: 0, height: 0 } as DOMRect);
    expect(errorCode(() => clickNode(surface, target, { x: 0.5, y: 0.5 }))).toBe('INVALID_PARAMS');
    expect(input).not.toHaveBeenCalled();
  });

  it('refuses disabled targets and unknown handles with typed errors', () => {
    const surface = createSurface();
    const stop = findNodes(surface, { selector: '#stop' })[0];
    expect(errorCode(() => clickNode(surface, stop.nodeKey!))).toBe('INVALID_PARAMS');
    const unknown = stop.nodeKey!.replace(/\d+$/, '999999');
    expect(errorCode(() => clickNode(surface, unknown))).toBe('UNKNOWN_TARGET');
  });

  it('invalidates handles once the document is replaced', () => {
    const surface = createSurface();
    const start = findNodes(surface, { testId: 'start-button' })[0];
    (surface.iframe.contentDocument as Document).body.innerHTML = '<button>Restart</button>';
    expect(errorCode(() => clickNode(surface, start.nodeKey!))).toBe('STALE_TARGET');
  });

  it('scrolls the document and reports the applied offset', () => {
    const surface = createSurface();
    const result = scrollSurface(surface, undefined, 0, 240) as { scrollTop: number; deltaY: number };
    expect(result.deltaY).toBe(240);
    expect(result.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it('truncates the observation at the contract budget', () => {
    const rows = Array.from({ length: MINIAPP_AGENT_MAX_NODES + 40 }, (_, index) => `<button>Row ${index}</button>`).join('');
    const surface = createSurface(`<main>${rows}</main>`);
    const result = inspectDocument(surface);
    expect(result.truncated).toBe(true);
    expect(flatNodes(result.tree).length).toBeLessThanOrEqual(MINIAPP_AGENT_MAX_NODES);
  });

  it('reports an unreadable frame as a surface capability gap', () => {
    const surface = unreadableSurface();
    expect(canReadSurfaceDocument(surface)).toBe(false);
    expect(errorCode(() => inspectDocument(surface))).toBe('SURFACE_UNAVAILABLE');
  });
});
