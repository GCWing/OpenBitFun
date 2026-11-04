import { useMemo } from 'react';
import { useEffect, useRef } from 'react';
import { genUICatalog, type GenUIDesignSpec } from './genUIContract';
import type { GenUIHtmlDocumentSource } from './genUITypes';

export interface GenUIHtmlSanitizeResult {
  document: string;
  diagnostics: string[];
}

export interface GenUIHtmlBridgeContext {
  appId: string;
  sourceKey: string;
  designSpec?: { id: string; revision: number };
  signal: AbortSignal;
}
export interface GenUIHtmlBridgeSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, GenUIHtmlBridgeSchema>;
  required?: string[];
  items?: GenUIHtmlBridgeSchema;
  additionalProperties?: boolean;
}
export interface GenUIHtmlBridgeCapability {
  payload?: GenUIHtmlBridgeSchema;
  permission: string;
  remote: 'local' | 'workspace' | 'peer' | 'unsupported';
}
export interface GenUIHtmlBridge {
  capabilities: Record<string, GenUIHtmlBridgeCapability>;
  handlers: Record<string, (payload: unknown, context: GenUIHtmlBridgeContext) => unknown | Promise<unknown>>;
}

export interface GenUIHtmlFrameReport {
  viewportWidth: number;
  viewportHeight: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  visibleElementCount: number;
  contentBounds: { left: number; top: number; right: number; bottom: number } | null;
  renderedEvidence: Array<{ ref: string; label?: string; text?: string; role?: string }>;
}

export interface GenUIHtmlInspection {
  onReport: (report: GenUIHtmlFrameReport) => void;
}

/** Versioned host capabilities are part of HTML delivery evidence. */
export const GENUI_HTML_RUNTIME = {
  ...genUICatalog.htmlRuntime,
} as const;

/**
 * HTML documents are deliberately accepted as documents, but the document
 * boundary is still structural. Keep the active surface small and explicit;
 * anything outside this list is removed before the opaque frame is mounted.
 * This is the sanitizer contract for revision 2 of the HTML runtime.
 */
const ALLOWED_ELEMENTS = new Set([
  'html', 'head', 'body', 'title', 'style',
  'main', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'em', 'b', 'i', 'small', 'sub', 'sup', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'figure', 'figcaption', 'details', 'summary',
  'label', 'fieldset', 'legend', 'button', 'input', 'select', 'option', 'textarea',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'a', 'img', 'canvas', 'video', 'audio',
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'symbol', 'text', 'tspan', 'marker', 'use',
]);

const ALLOWED_ATTRIBUTES = new Set([
  'id', 'class', 'title', 'role', 'tabindex', 'dir', 'lang', 'hidden', 'slot', 'style',
  'href', 'target', 'rel', 'download', 'src', 'alt', 'width', 'height', 'loading', 'decoding',
  'type', 'name', 'value', 'placeholder', 'checked', 'disabled', 'readonly', 'required', 'multiple', 'selected', 'min', 'max', 'step', 'rows', 'cols', 'for', 'autocomplete', 'inputmode', 'accept',
  'viewbox', 'preserveaspectratio', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'x1', 'x2', 'y', 'y1', 'y2', 'points', 'transform', 'opacity', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'patternunits', 'patterncontentunits', 'patterntransform', 'xmlns', 'version',
]);

function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]+;?/gi, '')
    .replace(/url\s*\(\s*['"]?(?:https?:|data:|javascript:|vbscript:|\/\/)[^)]*\)/gi, 'none');
}

function sanitizeControlledScript(script: string): string {
  // Keep the bridge deliberately small. Dynamic code loading and code
  // generation would escape the owner-reviewed source boundary.
  return script
    .replace(/\beval\s*\(/gi, '/* blocked eval */ (')
    .replace(/\bnew\s+Function\s*\(/gi, '/* blocked Function */ (')
    .replace(/\bimport\s*\(/gi, '/* blocked import */ (');
}

function createCspNonce(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateBridgePayload(value: unknown, schema: GenUIHtmlBridgeSchema | undefined, path = 'payload'): string | undefined {
  if (!schema) return undefined;
  const validType = schema.type === undefined
    || (schema.type === 'null' ? value === null
      : schema.type === 'array' ? Array.isArray(value)
        : schema.type === 'object' ? Boolean(value && typeof value === 'object' && !Array.isArray(value))
          : typeof value === schema.type && (schema.type !== 'number' || (typeof value === 'number' && Number.isFinite(value))));
  if (!validType) return `${path} has the wrong type`;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const error = validateBridgePayload(item, schema.items, `${path}[${index}]`);
      if (error) return error;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.prototype.hasOwnProperty.call(object, key)) return `${path}.${key} is required`;
    for (const [key, entry] of Object.entries(object)) {
      const child = schema.properties?.[key];
      if (!child && schema.additionalProperties === false) return `${path}.${key} is unsupported`;
      const error = validateBridgePayload(entry, child, `${path}.${key}`);
      if (error) return error;
    }
  }
  return undefined;
}

function bridgeBootstrap(): string {
  return `(() => {
    const pending = new Map();
    let sequence = 0;
    const request = (capability, payload) => new Promise((resolve, reject) => {
      const requestId = 'genui-' + (++sequence);
      pending.set(requestId, { resolve, reject });
      parent.postMessage({ kind: 'openbitfun.genui.bridge.request', requestId, capability, payload }, '*');
    });
    Object.defineProperty(window, 'openbitfunWidget', { value: Object.freeze({ request }), configurable: false, writable: false });
    addEventListener('message', event => {
      if (event.source !== parent || !event.data || event.data.kind !== 'openbitfun.genui.bridge.response') return;
      const pendingRequest = pending.get(event.data.requestId);
      if (!pendingRequest) return;
      pending.delete(event.data.requestId);
      if (event.data.ok) pendingRequest.resolve(event.data.value);
      else pendingRequest.reject(new Error(String(event.data.error || 'GenUI bridge request failed')));
    });
  })();`;
}

function inspectionBootstrap(): string {
  // This is host-owned, read-only evidence. It is injected only for the
  // delivery checker; candidate scripts remain disabled in that path.
  return `(() => {
    const report = () => {
      const body = document.body;
      const elements = body ? [...body.querySelectorAll('*')] : [];
      let visibleElementCount = 0;
      let contentBounds = null;
      const renderedEvidence = [];
      const seenRefs = new Set();
      for (const element of elements) {
        if (['SCRIPT', 'STYLE', 'META', 'LINK'].includes(element.tagName)) continue;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) continue;
        visibleElementCount += 1;
        contentBounds = contentBounds
          ? { left: Math.min(contentBounds.left, rect.left), top: Math.min(contentBounds.top, rect.top), right: Math.max(contentBounds.right, rect.right), bottom: Math.max(contentBounds.bottom, rect.bottom) }
          : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        const text = (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
        const label = element.getAttribute('aria-label') || element.getAttribute('data-genui-ref') || '';
        const id = element.id || '';
        const role = element.getAttribute('role') || element.tagName.toLowerCase();
        const ref = id ? 'id:' + id : label ? 'aria:' + label : /^(H1|H2|H3|BUTTON|INPUT|SELECT|TEXTAREA|SVG)$/.test(element.tagName) && text ? 'text:' + element.tagName.toLowerCase() + ':' + text : '';
        if (ref && !seenRefs.has(ref)) { seenRefs.add(ref); renderedEvidence.push({ ref, label: label || undefined, text: text || undefined, role }); }
      }
      const seenText = new Set();
      const textWalker = body ? document.createTreeWalker(body, NodeFilter.SHOW_TEXT) : null;
      let textIndex = 0;
      for (let node = textWalker?.nextNode(); node; node = textWalker?.nextNode()) {
        const text = (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
        if (!text || seenText.has(text)) continue;
        const parentElement = node.parentElement;
        if (!parentElement) continue;
        const style = getComputedStyle(parentElement);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        seenText.add(text);
        const ref = 'text:' + textIndex++;
        if (!seenRefs.has(ref)) { seenRefs.add(ref); renderedEvidence.push({ ref, text, role: parentElement.getAttribute('role') || parentElement.tagName.toLowerCase() }); }
      }
      parent.postMessage({
        kind: 'openbitfun.genui.inspection.report',
        report: {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          clientWidth: document.documentElement?.clientWidth || body?.clientWidth || 0,
          clientHeight: document.documentElement?.clientHeight || body?.clientHeight || 0,
          scrollWidth: Math.max(document.documentElement?.scrollWidth || 0, body?.scrollWidth || 0),
          scrollHeight: Math.max(document.documentElement?.scrollHeight || 0, body?.scrollHeight || 0),
          visibleElementCount,
          contentBounds,
          renderedEvidence,
        },
      }, '*');
    };
    addEventListener('message', event => {
      if (event.source === parent && event.data?.kind === 'openbitfun.genui.inspection.request') {
        setTimeout(report, 0);
        requestAnimationFrame(() => requestAnimationFrame(report));
      }
    });
    setTimeout(report, 0);
    requestAnimationFrame(() => requestAnimationFrame(report));
  })();`;
}

/**
 * Keep free documents as documents. The parser only removes host escape paths;
 * it does not translate the document into the component graph. Scripts are
 * retained in the source record but are deliberately disabled by this static
 * renderer until a host has negotiated the controlled bridge capability.
 */
export function sanitizeGenUIHtmlSource(source: GenUIHtmlDocumentSource, specification?: GenUIDesignSpec, hostStyleResourceCss = '', scriptEnabled = false, inspectionEnabled = false, inlineScriptEnabled = false): GenUIHtmlSanitizeResult {
  const diagnostics: string[] = [];
  const allowControlledScript = scriptEnabled && !inspectionEnabled;
  const scriptNonce = allowControlledScript || inspectionEnabled ? createCspNonce() : undefined;
  const parsed = new DOMParser().parseFromString(source.html, 'text/html');
  // HtmlView is a trusted product component with a separate opt-in for its
  // local animation script. Free HTML documents keep scripts in their own
  // source.script field, so inline document scripts remain disabled there.
  const inlineScript = inlineScriptEnabled
    ? [...parsed.querySelectorAll('script')].map(script => script.textContent ?? '').filter(Boolean).join('\n')
    : '';
  parsed.querySelectorAll('*').forEach(element => {
    const tagName = element.tagName.toLowerCase();
    if (!ALLOWED_ELEMENTS.has(tagName)) {
      if (tagName === 'script' && inlineScriptEnabled) {
        element.remove();
        return;
      }
      diagnostics.push(`Removed unsupported element: <${tagName}>`);
      element.remove();
      return;
    }
    for (const attribute of [...element.attributes]) {
      const attributeName = attribute.name.toLowerCase();
      if (attributeName.startsWith('on') || (!ALLOWED_ATTRIBUTES.has(attributeName) && !attributeName.startsWith('aria-') && !attributeName.startsWith('data-'))) {
        diagnostics.push(`Removed unsupported attribute: ${attribute.name}`);
        element.removeAttribute(attribute.name);
        continue;
      }
      if (attributeName === 'style') {
        element.setAttribute(attribute.name, sanitizeCss(attribute.value));
      }
      if ((attributeName === 'href' || attributeName === 'src' || attributeName === 'xlink:href')
        && /^(?:https?:|data:|javascript:|vbscript:|\/\/)/i.test(attribute.value.trim())) {
        diagnostics.push(`Removed unsafe URL from ${attribute.name}`);
        element.removeAttribute(attribute.name);
      }
    }
  });
  parsed.querySelectorAll('style').forEach(style => {
    style.textContent = sanitizeCss(style.textContent ?? '');
  });
  const css = sanitizeCss(source.css ?? '');
  if (css.trim()) {
    const style = parsed.createElement('style');
    style.setAttribute('data-gen-ui-source-style', 'true');
    style.textContent = css;
    parsed.head.appendChild(style);
  }
  if (specification) {
    const identity = parsed.createElement('meta');
    identity.name = 'openbitfun-design-spec';
    identity.content = `${specification.label}@${specification.revision}`;
    parsed.head.appendChild(identity);
    const resources = parsed.createElement('meta');
    resources.name = 'openbitfun-style-resources';
    resources.content = specification.styleResources.join(',');
    parsed.head.appendChild(resources);
  }
  if (hostStyleResourceCss.trim()) {
    const style = parsed.createElement('style');
    style.setAttribute('data-gen-ui-host-style-resources', 'true');
    style.textContent = hostStyleResourceCss;
    parsed.head.appendChild(style);
  }
  const policy = parsed.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; script-src 'none'`;
  parsed.head.prepend(policy);
  const scripts = [source.script?.trim() ?? '', inlineScript.trim()].filter(Boolean).join('\n');
  if (scripts) {
    if (!allowControlledScript) diagnostics.push('Controlled script execution is disabled on this host');
    else {
      const script = parsed.createElement('script');
      script.setAttribute('nonce', scriptNonce!);
      script.textContent = `${bridgeBootstrap()}\n${sanitizeControlledScript(scripts)}`.replace(/<\/script/gi, '<\\/script');
      parsed.body.appendChild(script);
    }
  }
  if (inspectionEnabled) {
    const script = parsed.createElement('script');
    script.setAttribute('nonce', scriptNonce!);
    script.textContent = inspectionBootstrap();
    parsed.body.appendChild(script);
  }
  if (scriptNonce) policy.setAttribute('content', `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; script-src 'nonce-${scriptNonce}'`);
  return {
    document: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${parsed.head.innerHTML}</head><body>${parsed.body.innerHTML}</body></html>`,
    diagnostics,
  };
}

export function inspectGenUIHtmlSource(source: GenUIHtmlDocumentSource, specification?: GenUIDesignSpec): string[] {
  const { diagnostics } = sanitizeGenUIHtmlSource(source);
  const issues = diagnostics.filter(message => message.startsWith('Removed unsafe URL'));
  if (specification && !specification.sourceKinds.includes('html-document')) issues.push(`UI specification ${specification.label} does not allow HTML documents`);
  const parsed = new DOMParser().parseFromString(source.html, 'text/html');
  for (const selector of specification?.shell.forbiddenContentSelectors ?? []) {
    try {
      if (parsed.querySelector(selector)) issues.push('Generated document duplicates host-owned shell part: ' + selector);
    } catch {
      issues.push('Invalid host-owned content selector in UI specification: ' + selector);
    }
  }
  // Reject the unconditionally empty case before mounting an opaque iframe.
  // Actual browser inspection still owns visibility, geometry and overflow
  // checks for documents that contain content but may be hidden or misplaced
  // by their CSS.
  const body = parsed.body;
  const hasBodyText = Boolean(body?.textContent?.trim());
  const hasRenderableElement = Boolean(body?.querySelector('svg,img,canvas,video,audio,input,button,select,textarea,[role],iframe'));
  if (!hasBodyText && !hasRenderableElement) issues.push('HTML document has no visible rendered content');
  return issues;
}

export default function GenUIHtmlDocument({ source, specification, designSpecId, appId = 'unknown', sourceKey = 'unknown', bridge, scriptEnabled = false, inspection }: {
  source: GenUIHtmlDocumentSource;
  specification?: GenUIDesignSpec;
  designSpecId?: string;
  appId?: string;
  sourceKey?: string;
  bridge?: GenUIHtmlBridge;
  scriptEnabled?: boolean;
  inspection?: GenUIHtmlInspection;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostStyleResourceCss = useMemo(() => {
    if (!specification?.styleResources.length || typeof document === 'undefined') return '';
    const computed = getComputedStyle(document.documentElement);
    const tokens: string[] = [];
    for (let index = 0; index < computed.length; index++) {
      const name = computed.item(index);
      if (!name.startsWith('--openbitfun-')) continue;
      const value = computed.getPropertyValue(name).trim();
      // Appearance values are host-owned, but do not copy malformed values
      // into the opaque document's inline stylesheet.
      if (value && !/[{};]/.test(value)) tokens.push(`${name}:${value};`);
    }
    const base = tokens.length
      ? `:root{${tokens.join('')}}html,body{margin:0;min-height:100%;color:var(--openbitfun-color-content-primary);background:var(--openbitfun-color-surface-canvas);font-family:var(--openbitfun-type-body-md-font-family);font-size:var(--openbitfun-type-body-md-font-size);line-height:var(--openbitfun-type-body-md-line-height);}`
      : '';
    return base;
  }, [specification]);
  const inspectionEnabled = Boolean(inspection);
  const canRunScript = Boolean(scriptEnabled && bridge && source.script?.trim() && !inspectionEnabled);
  const sanitized = useMemo(() => sanitizeGenUIHtmlSource(source, specification, hostStyleResourceCss, canRunScript, inspectionEnabled, false), [source, specification, hostStyleResourceCss, canRunScript, inspectionEnabled]);
  useEffect(() => {
    if (!canRunScript || !bridge) return;
    const frame = frameRef.current;
    if (!frame) return;
    let windowStart = Date.now();
    let requestCount = 0;
    const requests = new Map<string, AbortController>();
    const sendError = (requestId: string, error: string) => frame.contentWindow?.postMessage({ kind: 'openbitfun.genui.bridge.response', requestId, ok: false, error }, '*');
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
      const request = event.data as Record<string, unknown>;
      if (request.kind === 'openbitfun.genui.bridge.cancel' && typeof request.requestId === 'string') {
        requests.get(request.requestId)?.abort();
        return;
      }
      if (request.kind !== 'openbitfun.genui.bridge.request' || typeof request.requestId !== 'string' || typeof request.capability !== 'string') return;
      const requestId = request.requestId;
      const capability = request.capability;
      if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(capability) || requestId.length > 128) {
        sendError(requestId, 'Invalid GenUI capability request');
        return;
      }
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; requestCount = 0; }
      if (++requestCount > 60) {
        sendError(requestId, 'GenUI capability rate limit exceeded');
        return;
      }
      try {
        if (JSON.stringify(request.payload).length > 64 * 1024) {
          sendError(requestId, 'GenUI capability payload is too large');
          return;
        }
      } catch {
        sendError(requestId, 'GenUI capability payload is not serializable');
        return;
      }
      const capabilitySpec = bridge.capabilities[capability];
      const handler = Object.prototype.hasOwnProperty.call(bridge.handlers, capability) ? bridge.handlers[capability] : undefined;
      const response = (message: Record<string, unknown>) => frame.contentWindow?.postMessage(message, '*');
      if (!capabilitySpec || !handler || capabilitySpec.remote === 'unsupported') {
        sendError(requestId, 'Unsupported GenUI capability');
        return;
      }
      const payloadError = validateBridgePayload(request.payload, capabilitySpec.payload);
      if (payloadError) {
        sendError(requestId, payloadError);
        return;
      }
      const controller = new AbortController();
      requests.set(requestId, controller);
      Promise.resolve(handler(request.payload, { appId, sourceKey, designSpec: specification && designSpecId ? { id: designSpecId, revision: specification.revision } : undefined, signal: controller.signal })).then(
        value => {
          requests.delete(requestId);
          try {
            if (JSON.stringify(value).length > 256 * 1024) {
              sendError(requestId, 'GenUI capability response is too large');
              return;
            }
          } catch {
            sendError(requestId, 'GenUI capability response is not serializable');
            return;
          }
          response({ kind: 'openbitfun.genui.bridge.response', requestId, ok: true, value });
        },
        error => {
          requests.delete(requestId);
          response({ kind: 'openbitfun.genui.bridge.response', requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
        },
      );
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      for (const controller of requests.values()) controller.abort();
      requests.clear();
    };
  }, [appId, sourceKey, designSpecId, specification, bridge, canRunScript]);
  useEffect(() => {
    if (!inspection) return;
    const frame = frameRef.current;
    if (!frame) return;
    const requestReport = () => frame.contentWindow?.postMessage({ kind: 'openbitfun.genui.inspection.request' }, '*');
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
      const message = event.data as Record<string, unknown>;
      if (message.kind !== 'openbitfun.genui.inspection.report' || !message.report || typeof message.report !== 'object') return;
      const report = message.report as Record<string, unknown>;
      const numeric = ['viewportWidth', 'viewportHeight', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'visibleElementCount'];
      if (numeric.some(key => typeof report[key] !== 'number' || !Number.isFinite(report[key] as number))) return;
      const bounds = report.contentBounds;
      if (bounds !== null && (typeof bounds !== 'object' || ['left', 'top', 'right', 'bottom'].some(key => typeof (bounds as Record<string, unknown>)[key] !== 'number' || !Number.isFinite((bounds as Record<string, unknown>)[key] as number)))) return;
      const renderedEvidence = report.renderedEvidence;
      if (!Array.isArray(renderedEvidence) || renderedEvidence.some(entry => !entry || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).ref !== 'string')) return;
      inspection.onReport({
        viewportWidth: report.viewportWidth as number,
        viewportHeight: report.viewportHeight as number,
        clientWidth: report.clientWidth as number,
        clientHeight: report.clientHeight as number,
        scrollWidth: report.scrollWidth as number,
        scrollHeight: report.scrollHeight as number,
        visibleElementCount: report.visibleElementCount as number,
        contentBounds: bounds as GenUIHtmlFrameReport['contentBounds'],
        renderedEvidence: renderedEvidence as GenUIHtmlFrameReport['renderedEvidence'],
      });
    };
    window.addEventListener('message', handleMessage);
    frame.addEventListener('load', requestReport);
    requestReport();
    // The iframe can finish loading between the React commit and this effect
    // attaching its listener. Retry the host-owned handshake briefly so a
    // missed postMessage never turns a valid document into a flaky timeout.
    const retryTimer = window.setInterval(requestReport, 250);
    return () => {
      window.removeEventListener('message', handleMessage);
      frame.removeEventListener('load', requestReport);
      window.clearInterval(retryTimer);
    };
  }, [inspection]);
  return <div className="gen-ui-html-document" data-gen-ui-html-document="true" data-gen-ui-source-kind={source.kind} data-gen-ui-sanitize-diagnostics={sanitized.diagnostics.length}>
    <iframe
      title="Generated HTML document"
      className="gen-ui-html-document__frame"
      // Script capability is negotiated by the owner and never enabled by a
      // generated source field alone. The sandbox remains opaque-origin.
      ref={frameRef}
      sandbox={canRunScript || inspectionEnabled ? 'allow-scripts' : ''}
      srcDoc={sanitized.document}
      data-gen-ui-html-frame="true"
      data-gen-ui-viewport-width={specification?.viewport.width}
      data-gen-ui-viewport-height={specification?.viewport.height}
    />
  </div>;
}
