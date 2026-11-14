import { useMemo } from 'react';
import { useEffect, useRef } from 'react';
import { useColorScheme } from './components/openui/scheme';
import { type GenUIDesignSpec } from './genUIContract';
import type { GenUIHtmlDocumentSource } from './genUITypes';

import { sanitizeGenUIHtmlSource, validateBridgePayload, type GenUIHtmlBridge, type GenUIHtmlInspection, type GenUIHtmlFrameReport } from './genUIHtmlSource';

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
  const themeRef = useRef<HTMLDivElement>(null);
  const colorScheme = useColorScheme(themeRef);
  const hostStyleResourceCss = useMemo(() => {
    if (typeof document === 'undefined') return '';
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
    return `:root{color-scheme:${colorScheme};${tokens.join('')}}html,body{margin:0;min-height:100%;color:var(--openbitfun-color-content-primary);background:var(--openbitfun-color-surface-canvas);font-family:var(--openbitfun-type-body-md-font-family);font-size:var(--openbitfun-type-body-md-font-size);line-height:var(--openbitfun-type-body-md-line-height);}`;
  }, [colorScheme]);
  const inspectionEnabled = Boolean(inspection);
  const canRunScript = Boolean(scriptEnabled && bridge && source.script?.trim() && !inspectionEnabled);
  const sanitized = useMemo(() => sanitizeGenUIHtmlSource(source, specification, hostStyleResourceCss, canRunScript, inspectionEnabled, false, colorScheme), [source, specification, hostStyleResourceCss, canRunScript, inspectionEnabled, colorScheme]);
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
  return <div ref={themeRef} className="gen-ui-html-document" data-gen-ui-html-document="true" data-gen-ui-source-kind={source.kind} data-gen-ui-sanitize-diagnostics={sanitized.diagnostics.length}>
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
