/**
 * DOM runtime for the Agent-controlled MiniApp surface.
 *
 * The MiniApp lives in an iframe owned by this window, so only the Web UI can
 * read its document and dispatch input. Everything here is framework-free and
 * takes an explicit surface, which keeps the transport (bridge/router) and the
 * React lifecycle (registry/hook) independent of DOM details.
 *
 * Two invariants:
 * - a node handle is only valid while its element is still connected, so a
 *   reload turns into `STALE_TARGET` instead of acting on a lookalike node;
 * - every failure is a typed error, never a silent no-op.
 */

import keyContract from '../../../../../../shared/miniapp-agent/keys.json';

import {
  MINIAPP_AGENT_MAX_DEPTH,
  MINIAPP_AGENT_MAX_KEY_HOLD_MS,
  MINIAPP_AGENT_MAX_MATCHES,
  MINIAPP_AGENT_MAX_NAME_CHARS,
  MINIAPP_AGENT_MAX_NODES,
  MINIAPP_AGENT_MAX_TEXT_CHARS,
  surfaceError,
  createMiniAppDocumentId,
  type MiniAppAgentLocator,
  type MiniAppAgentNode,
} from './miniAppAgentProtocol';

export interface MiniAppAgentDomSurface {
  appId: string;
  iframe: HTMLIFrameElement;
}

const IGNORED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'meta',
  'link',
  'head',
  'title',
  'base',
]);

const INTERACTIVE_TAGS = new Set([
  'a',
  'area',
  'button',
  'details',
  'dialog',
  'embed',
  'iframe',
  'input',
  'label',
  'option',
  'output',
  'progress',
  'select',
  'summary',
  'textarea',
]);

const STRUCTURAL_ROLES: Record<string, string> = {
  a: 'link',
  article: 'article',
  aside: 'complementary',
  body: 'document',
  button: 'button',
  dialog: 'dialog',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  header: 'banner',
  img: 'img',
  input: 'textbox',
  li: 'listitem',
  main: 'main',
  nav: 'navigation',
  ol: 'list',
  option: 'option',
  p: 'paragraph',
  select: 'combobox',
  table: 'table',
  td: 'cell',
  textarea: 'textbox',
  th: 'columnheader',
  tr: 'row',
  ul: 'list',
};

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  checkbox: 'checkbox',
  color: 'button',
  date: 'textbox',
  email: 'textbox',
  file: 'button',
  image: 'button',
  number: 'spinbutton',
  password: 'textbox',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  search: 'searchbox',
  submit: 'button',
  tel: 'textbox',
  text: 'textbox',
  time: 'textbox',
  url: 'textbox',
};

const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-openbitfun-testid'];
const READ_ATTRIBUTES = ['id', 'name', 'type', 'placeholder', 'aria-label', 'title', 'href', 'role'];

/** Node handles never alias another frame or document, even after a reload. */
class SurfaceNodeIndex {
  private readonly keys = new WeakMap<Element, string>();
  private readonly elements = new Map<string, Element>();
  private next = 1;
  private readonly prefix = `node-${createMiniAppDocumentId()}-`;

  constructor(readonly document: Document) {}

  keyOf(element: Element): string {
    const existing = this.keys.get(element);
    if (existing) return existing;
    const key = `${this.prefix}${this.next}`;
    this.next += 1;
    this.keys.set(element, key);
    this.elements.set(key, element);
    return key;
  }

  resolve(nodeKey: string): Element {
    if (!nodeKey.startsWith(this.prefix)) {
      throw surfaceError('STALE_TARGET', 'The node belongs to another MiniApp document; run inspect again.');
    }
    const element = this.elements.get(nodeKey);
    if (!element) {
      throw surfaceError('UNKNOWN_TARGET', 'The node handle is unknown; run inspect again.');
    }
    if (!element.isConnected || element.ownerDocument !== this.document) {
      throw surfaceError(
        'STALE_TARGET',
        'The MiniApp document changed after this node handle was observed; run inspect again.',
      );
    }
    return element;
  }
}

const nodeIndexes = new WeakMap<HTMLIFrameElement, SurfaceNodeIndex>();

function nodeIndex(surface: MiniAppAgentDomSurface): SurfaceNodeIndex {
  const doc = requireSurfaceDocument(surface);
  const existing = nodeIndexes.get(surface.iframe);
  if (existing?.document === doc) return existing;
  const created = new SurfaceNodeIndex(doc);
  nodeIndexes.set(surface.iframe, created);
  return created;
}

/** Whether this surface exposes a readable document at all. */
export function canReadSurfaceDocument(surface: MiniAppAgentDomSurface): boolean {
  try {
    const doc = surface.iframe.contentDocument;
    return Boolean(doc?.documentElement);
  } catch {
    return false;
  }
}

/**
 * The surface document, or a typed `SURFACE_UNAVAILABLE`.
 *
 * Exported because any read of a MiniApp surface starts here, including pixel
 * capture, which lives in its own module precisely so it does not need the rest
 * of this one.
 */
export function requireSurfaceDocument(surface: MiniAppAgentDomSurface): Document {
  let doc: Document | null = null;
  try {
    doc = surface.iframe.contentDocument;
  } catch {
    doc = null;
  }
  if (!doc?.documentElement) {
    throw surfaceError(
      'SURFACE_UNAVAILABLE',
      'The MiniApp frame document is not readable from this surface: it runs with an opaque origin or is not mounted yet.',
    );
  }
  return doc;
}

function boundText(value: string | null | undefined, limit: number): string | undefined {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function isElementVisible(element: Element): boolean {
  if (element.hasAttribute('hidden')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  const style = (element as HTMLElement).style;
  if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  if (element.tagName.toLowerCase() === 'input' && element.getAttribute('type') === 'hidden') {
    return false;
  }
  return true;
}

function implicitRole(element: Element): string | undefined {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    return INPUT_ROLES[type] ?? 'textbox';
  }
  if (tag === 'a') return element.hasAttribute('href') ? 'link' : undefined;
  return STRUCTURAL_ROLES[tag];
}

function nodeRole(element: Element): string {
  const explicit = element.getAttribute('role')?.trim();
  if (explicit) return explicit.split(/\s+/)[0].toLowerCase();
  return implicitRole(element) ?? element.tagName.toLowerCase();
}

function nodeTestId(element: Element): string | undefined {
  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = element.getAttribute(attribute)?.trim();
    if (value) return value;
  }
  return undefined;
}

function labelledByText(element: Element): string | undefined {
  const ids = element.getAttribute('aria-labelledby')?.trim();
  if (!ids) return undefined;
  const doc = element.ownerDocument;
  const text = ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
  return text || undefined;
}

function labelsText(element: Element): string | undefined {
  const labels = (element as HTMLInputElement).labels;
  if (!labels || typeof labels.length !== 'number') return undefined;
  const text = Array.from(labels as unknown as Element[])
    .map((label) => label.textContent ?? '')
    .join(' ')
    .trim();
  return text || undefined;
}

/** Accessible name, in the order a user would read it. */
function nodeName(element: Element): string | undefined {
  return (
    boundText(element.getAttribute('aria-label'), MINIAPP_AGENT_MAX_NAME_CHARS)
    ?? boundText(labelledByText(element), MINIAPP_AGENT_MAX_NAME_CHARS)
    ?? boundText(labelsText(element), MINIAPP_AGENT_MAX_NAME_CHARS)
    ?? boundText(element.getAttribute('alt'), MINIAPP_AGENT_MAX_NAME_CHARS)
    ?? boundText(element.getAttribute('title'), MINIAPP_AGENT_MAX_NAME_CHARS)
    ?? boundText(element.getAttribute('placeholder'), MINIAPP_AGENT_MAX_NAME_CHARS)
    ?? boundText(element.textContent, MINIAPP_AGENT_MAX_NAME_CHARS)
  );
}

function nodeValue(element: Element): string | undefined {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (tag === 'input' && (element.getAttribute('type') ?? 'text').toLowerCase() === 'password') {
      return undefined;
    }
    const raw = (element as HTMLInputElement).value;
    return raw.length > MINIAPP_AGENT_MAX_TEXT_CHARS
      ? `${Array.from(raw).slice(0, MINIAPP_AGENT_MAX_TEXT_CHARS).join('')}…`
      : raw;
  }
  if ((element as HTMLElement).isContentEditable) {
    const raw = element.textContent ?? '';
    return raw.length > MINIAPP_AGENT_MAX_TEXT_CHARS
      ? `${Array.from(raw).slice(0, MINIAPP_AGENT_MAX_TEXT_CHARS).join('')}…`
      : raw;
  }
  return undefined;
}

function nodeChecked(element: Element): boolean | undefined {
  const tag = element.tagName.toLowerCase();
  if (tag !== 'input') return undefined;
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  if (type !== 'checkbox' && type !== 'radio') return undefined;
  return (element as HTMLInputElement).checked;
}

function nodeEnabled(element: Element): boolean | undefined {
  if (element.getAttribute('aria-disabled') === 'true') return false;
  const disabled = (element as HTMLButtonElement).disabled;
  if (typeof disabled === 'boolean' && (INTERACTIVE_TAGS.has(element.tagName.toLowerCase())
    || element.hasAttribute('contenteditable'))) {
    return !disabled;
  }
  return undefined;
}

/** Whether a node carries information worth reporting to the model. */
function isDescribable(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (element.hasAttribute('role') || element.hasAttribute('aria-label')) return true;
  if (nodeTestId(element)) return true;
  if (element.hasAttribute('contenteditable')) return true;
  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return true;
  if (tag === 'img') return Boolean(element.getAttribute('alt'));
  const text = boundText(element.textContent, MINIAPP_AGENT_MAX_TEXT_CHARS);
  return Boolean(text) && element.children.length === 0;
}

function describeNode(element: Element): MiniAppAgentNode {
  const text = boundText(element.textContent, MINIAPP_AGENT_MAX_TEXT_CHARS);
  const value = nodeValue(element);
  return {
    role: nodeRole(element),
    name: nodeName(element),
    tag: element.tagName.toLowerCase().slice(0, 32),
    testId: nodeTestId(element),
    value,
    text,
    enabled: nodeEnabled(element),
    checked: nodeChecked(element),
    children: [],
  };
}

export interface InspectOptions {
  maxNodes?: number;
  maxDepth?: number;
}

export interface InspectResult {
  url?: string;
  title?: string;
  nodeCount: number;
  truncated: boolean;
  tree: MiniAppAgentNode[];
}

/** Bounded, a11y-shaped observation of the MiniApp document. */
export function inspectDocument(
  surface: MiniAppAgentDomSurface,
  options: InspectOptions = {},
): InspectResult {
  const doc = requireSurfaceDocument(surface);
  const index = nodeIndex(surface);
  const maxNodes = Math.max(1, options.maxNodes ?? MINIAPP_AGENT_MAX_NODES);
  const maxDepth = Math.max(1, options.maxDepth ?? MINIAPP_AGENT_MAX_DEPTH);
  const budget = { remaining: maxNodes, truncated: false };
  const root = doc.body ?? doc.documentElement;
  const tree: MiniAppAgentNode[] = [];

  const walk = (parent: Element, depth: number, out: MiniAppAgentNode[]) => {
    if (depth > maxDepth) {
      budget.truncated = true;
      return;
    }
    for (const child of Array.from(parent.children)) {
      const tag = child.tagName.toLowerCase();
      if (IGNORED_TAGS.has(tag) || !isElementVisible(child)) continue;
      if (!isDescribable(child)) {
        walk(child, depth, out);
        continue;
      }
      if (budget.remaining <= 0) {
        budget.truncated = true;
        return;
      }
      budget.remaining -= 1;
      const node = describeNode(child);
      node.nodeKey = index.keyOf(child);
      const children: MiniAppAgentNode[] = [];
      walk(child, depth + 1, children);
      if (children.length > 0) node.children = children;
      out.push(node);
      if (budget.truncated) return;
    }
  };

  walk(root, 1, tree);
  const href = doc.defaultView?.location?.href;
  return {
    url: href && href !== 'about:blank' ? href : undefined,
    title: boundText(doc.title, MINIAPP_AGENT_MAX_NAME_CHARS),
    nodeCount: maxNodes - budget.remaining,
    truncated: budget.truncated,
    tree,
  };
}

function matchesLocator(element: Element, locator: MiniAppAgentLocator): boolean {
  const exact = locator.exact === true;
  if (locator.testId && nodeTestId(element) !== locator.testId) return false;
  if (locator.role && nodeRole(element) !== locator.role.toLowerCase()) return false;
  if (locator.name) {
    const name = nodeName(element);
    if (!name) return false;
    if (exact ? name !== locator.name : !name.includes(locator.name)) return false;
  }
  if (locator.text) {
    const text = boundText(element.textContent, MINIAPP_AGENT_MAX_TEXT_CHARS);
    if (!text) return false;
    if (exact ? text !== locator.text : !text.includes(locator.text)) return false;
  }
  return true;
}

/** Flat list of matching nodes, highest-priority axis first. */
export function findNodes(
  surface: MiniAppAgentDomSurface,
  locator: MiniAppAgentLocator,
): MiniAppAgentNode[] {
  const doc = requireSurfaceDocument(surface);
  const index = nodeIndex(surface);
  let candidates: Element[];
  if (locator.selector) {
    try {
      candidates = Array.from(doc.querySelectorAll(locator.selector));
    } catch {
      throw surfaceError('INVALID_PARAMS', `The CSS selector is not valid in this document: ${locator.selector}`);
    }
  } else {
    const body = doc.body ?? doc.documentElement;
    candidates = Array.from(body.querySelectorAll('*'));
  }

  const semanticMatch = Boolean(locator.text || locator.name);
  const matched: Element[] = [];
  for (const element of candidates) {
    if (IGNORED_TAGS.has(element.tagName.toLowerCase())) continue;
    if (!isElementVisible(element)) continue;
    if (!matchesLocator(element, locator)) continue;
    matched.push(element);
  }

  // A name/text match also hits every ancestor that contains the label, so keep
  // the most specific node and drop the containers around it.
  const specific = semanticMatch
    ? matched.filter((element) => !matched.some(
      (other) => other !== element && element.contains(other),
    ))
    : matched;

  const matches: MiniAppAgentNode[] = [];
  for (const element of specific) {
    const node = describeNode(element);
    node.nodeKey = index.keyOf(element);
    matches.push(node);
    if (matches.length >= MINIAPP_AGENT_MAX_MATCHES) break;
  }
  return matches;
}

function resolveElement(surface: MiniAppAgentDomSurface, nodeKey: string): Element {
  requireSurfaceDocument(surface);
  return nodeIndex(surface).resolve(nodeKey);
}

export interface ReadResult {
  text?: string;
  value?: string;
  attributes: Record<string, string>;
}

export function readNode(
  surface: MiniAppAgentDomSurface,
  nodeKey: string,
  attribute?: string,
): ReadResult {
  const element = resolveElement(surface, nodeKey);
  const attributes: Record<string, string> = {};
  if (attribute) {
    const value = element.getAttribute(attribute);
    if (value !== null) attributes[attribute] = boundText(value, MINIAPP_AGENT_MAX_TEXT_CHARS) ?? '';
  } else {
    for (const name of READ_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value) attributes[name] = boundText(value, MINIAPP_AGENT_MAX_TEXT_CHARS) ?? '';
    }
  }
  return {
    text: boundText(element.textContent, MINIAPP_AGENT_MAX_TEXT_CHARS),
    value: nodeValue(element),
    attributes,
  };
}

function assertActionable(element: Element, action: string): void {
  if (!isElementVisible(element)) {
    throw surfaceError('INVALID_PARAMS', `${action}: the target is no longer visible; inspect the current MiniApp before retrying.`);
  }
  if (element.getAttribute('aria-disabled') === 'true' || (element as HTMLButtonElement).disabled === true) {
    throw surfaceError(
      'INVALID_PARAMS',
      `${action}: the target is disabled and cannot receive input.`,
    );
  }
  const tag = element.tagName.toLowerCase();
  if (action === 'type' && (tag === 'input' || tag === 'textarea')
    && ((element as HTMLInputElement).readOnly || element.getAttribute('aria-readonly') === 'true')) {
    throw surfaceError('INVALID_PARAMS', `${action}: the target is read-only and cannot receive input.`);
  }
}

function scrollIntoView(element: Element): void {
  const scrollIntoViewFn = (element as HTMLElement).scrollIntoView;
  if (typeof scrollIntoViewFn === 'function') {
    try {
      scrollIntoViewFn.call(element, { block: 'center', inline: 'center' });
    } catch {
      // Scrolling is best-effort; dispatch still proceeds.
    }
  }
}

function createEvent<T extends Event>(
  doc: Document,
  name: string,
  init: Record<string, unknown>,
  ctor: 'MouseEvent' | 'PointerEvent' | 'KeyboardEvent' | 'Event',
): T {
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  const EventCtor = (view?.[ctor] ?? (globalThis as unknown as Record<string, unknown>)[ctor]) as
    | (new (type: string, init: Record<string, unknown>) => T)
    | undefined;
  if (EventCtor) return new EventCtor(name, init);
  return new Event(name, init as EventInit) as T;
}

export interface InputResult {
  target: string;
  detail: Record<string, unknown>;
}

export interface ClickPosition {
  /** Fractions of the target's rendered bounding box, in [0, 1). */
  x: number;
  y: number;
}

export function clickNode(surface: MiniAppAgentDomSurface, nodeKey: string, position?: unknown): InputResult {
  const element = resolveElement(surface, nodeKey);
  assertActionable(element, 'click');
  let point: ClickPosition | undefined;
  if (position !== undefined) {
    const candidate = position as ClickPosition | null;
    if (!candidate || typeof candidate !== 'object'
      || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)
      || candidate.x < 0 || candidate.x >= 1 || candidate.y < 0 || candidate.y >= 1) {
      throw surfaceError('INVALID_PARAMS', 'click: position requires finite x and y fractions in [0, 1).');
    }
    point = candidate;
  }
  const doc = element.ownerDocument;
  scrollIntoView(element);
  const rect = element.getBoundingClientRect();
  if (point && (!isElementVisible(element) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
    || rect.width <= 0 || rect.height <= 0)) {
    throw surfaceError('INVALID_PARAMS', 'click: the target has no visible area; inspect the current MiniApp before retrying.');
  }
  const clientX = rect.left + rect.width * (point?.x ?? 0.5);
  const clientY = rect.top + rect.height * (point?.y ?? 0.5);
  // Hit testing stays inside this MiniApp document. Never redirect to a sibling
  // element or another frame when a layout change covers the selected target.
  const hit = point && typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(clientX, clientY) : undefined;
  if (point && typeof doc.elementFromPoint === 'function' && (!hit || !element.contains(hit))) {
    throw surfaceError('INVALID_PARAMS', 'click: the selected position is outside the visible target or is covered; inspect again.');
  }
  const dispatchTarget = hit ?? element;
  const focusable = element as HTMLElement;
  if (typeof focusable.focus === 'function') {
    try {
      focusable.focus({ preventScroll: true });
    } catch {
      // Focus is best-effort for non-focusable nodes.
    }
  }
  const init = { bubbles: true, cancelable: true, composed: true, view: doc.defaultView, button: 0, clientX, clientY };
  dispatchTarget.dispatchEvent(createEvent(doc, 'pointerdown', { ...init, buttons: 1, isPrimary: true, pointerType: 'mouse' }, 'PointerEvent'));
  dispatchTarget.dispatchEvent(createEvent(doc, 'mousedown', { ...init, buttons: 1 }, 'MouseEvent'));
  dispatchTarget.dispatchEvent(createEvent(doc, 'pointerup', { ...init, isPrimary: true, pointerType: 'mouse' }, 'PointerEvent'));
  dispatchTarget.dispatchEvent(createEvent(doc, 'mouseup', init, 'MouseEvent'));
  dispatchTarget.dispatchEvent(createEvent(doc, 'click', init, 'MouseEvent'));
  return {
    target: nodeKey,
    detail: { role: nodeRole(element), name: nodeName(element) ?? null, clientX, clientY },
  };
}

function setInputValue(element: Element, text: string, clear: boolean): void {
  const field = element as HTMLInputElement;
  const previous = typeof field.value === 'string' ? field.value : '';
  const next = clear ? text : `${previous}${text}`;
  const view = element.ownerDocument.defaultView as (Window & typeof globalThis) | null;
  const tag = element.tagName.toLowerCase();
  const constructor = tag === 'textarea' ? view?.HTMLTextAreaElement
    : tag === 'select' ? view?.HTMLSelectElement : view?.HTMLInputElement;
  const setter = constructor
    ? Object.getOwnPropertyDescriptor(constructor.prototype, 'value')?.set
    : undefined;
  if (setter) {
    setter.call(element, next);
  } else {
    field.value = next;
  }
}

export function typeIntoNode(
  surface: MiniAppAgentDomSurface,
  nodeKey: string,
  text: string,
  clear = true,
): InputResult {
  const element = resolveElement(surface, nodeKey);
  assertActionable(element, 'type');
  const doc = element.ownerDocument;
  scrollIntoView(element);
  const editable = element as HTMLElement;
  if (typeof editable.focus === 'function') {
    try {
      editable.focus({ preventScroll: true });
    } catch {
      // Typing into a non-focusable node still updates its value below.
    }
  }

  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    setInputValue(element, text, clear);
  } else if (editable.isContentEditable) {
    editable.textContent = clear ? text : `${editable.textContent ?? ''}${text}`;
  } else {
    throw surfaceError(
      'INVALID_PARAMS',
      'type: the target is not an editable field. Use a textbox, textarea, select, or contenteditable node.',
    );
  }

  element.dispatchEvent(createEvent(doc, 'input', { bubbles: true, composed: true, inputType: 'insertText', data: text }, 'Event'));
  element.dispatchEvent(createEvent(doc, 'change', { bubbles: true, composed: true }, 'Event'));
  return { target: nodeKey, detail: { value: nodeValue(element) ?? null } };
}

const MODIFIER_KEYS = new Set(['alt', 'control', 'meta', 'shift']);

const KEY_CODES: Record<string, string> = keyContract.codes;
const KEY_VALUE_ALIASES: Record<string, string> = keyContract.aliases;

function keyCodeFor(key: string): string {
  const known = KEY_CODES[key.toLowerCase()];
  if (known) return known;
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/[0-9]/.test(key)) return `Digit${key}`;
    return key;
  }
  return key;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface KeyOptions {
  modifiers?: string[];
  /** Keep the key down this long before releasing it (ms). */
  holdMs?: number;
}

export async function pressKey(
  surface: MiniAppAgentDomSurface,
  key: string,
  options: KeyOptions = {},
): Promise<InputResult> {
  const doc = requireSurfaceDocument(surface);
  // A space is a real key for a game, so only trim the names that carry padding.
  const normalizedKey = key === ' ' ? ' ' : key.trim();
  if (!normalizedKey) {
    throw surfaceError('INVALID_PARAMS', 'key: the key name is required.');
  }
  const keyValue = KEY_VALUE_ALIASES[normalizedKey.toLowerCase()] ?? normalizedKey;
  const target = (doc.activeElement ?? doc.body ?? doc.documentElement) as Element | null;
  if (!target) {
    throw surfaceError('SURFACE_UNAVAILABLE', 'key: the MiniApp document has no focus target.');
  }
  const resolved = (options.modifiers ?? [])
    .map((modifier) => modifier.trim().toLowerCase())
    .filter((modifier) => MODIFIER_KEYS.has(modifier));
  const init = {
    key: keyValue,
    code: keyCodeFor(keyValue),
    bubbles: true,
    cancelable: true,
    composed: true,
    altKey: resolved.includes('alt'),
    ctrlKey: resolved.includes('control'),
    metaKey: resolved.includes('meta'),
    shiftKey: resolved.includes('shift'),
  };
  target.dispatchEvent(createEvent(doc, 'keydown', init, 'KeyboardEvent'));
  if (!MODIFIER_KEYS.has(normalizedKey.toLowerCase())) {
    target.dispatchEvent(createEvent(doc, 'keypress', init, 'KeyboardEvent'));
  }
  // A game loop samples held keys on its own animation frame, so releasing in
  // the same tick reads as "not pressed". Hold first, then release.
  const holdMs = Math.min(
    Math.max(0, Math.round(options.holdMs ?? 0)),
    MINIAPP_AGENT_MAX_KEY_HOLD_MS,
  );
  if (holdMs > 0) await delay(holdMs);
  target.dispatchEvent(createEvent(doc, 'keyup', init, 'KeyboardEvent'));
  return { target: target.tagName?.toLowerCase() ?? 'document', detail: { key: normalizedKey, holdMs, modifiers: resolved } };
}

export function scrollSurface(
  surface: MiniAppAgentDomSurface,
  nodeKey: string | undefined,
  deltaX: number,
  deltaY: number,
): Record<string, unknown> {
  const doc = requireSurfaceDocument(surface);
  const target = nodeKey
    ? resolveElement(surface, nodeKey)
    : (doc.scrollingElement ?? doc.documentElement);
  const scroller = target as HTMLElement;
  scroller.scrollLeft = (scroller.scrollLeft ?? 0) + deltaX;
  scroller.scrollTop = (scroller.scrollTop ?? 0) + deltaY;
  target.dispatchEvent(createEvent(doc, 'scroll', { bubbles: false }, 'Event'));
  return {
    scrollTop: scroller.scrollTop ?? 0,
    scrollLeft: scroller.scrollLeft ?? 0,
    deltaX,
    deltaY,
  };
}
