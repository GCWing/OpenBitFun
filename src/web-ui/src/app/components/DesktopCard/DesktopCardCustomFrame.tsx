import React, { useEffect, useMemo, useRef, useState } from 'react';
import { widgetAppearanceAdapter } from '@/infrastructure/appearance/adapters/WidgetAppearanceAdapter';
import {
  createWidgetAppearanceFallbackCss,
  readWidgetAppearancePayload,
} from '@/tools/generative-widget/appearancePayload';

const FRAME_MESSAGE_SOURCE = 'openbitfun-desktop-card';
const HOST_MESSAGE_SOURCE = 'openbitfun-desktop-card-host';

export interface DesktopCardCustomPayload {
  data: unknown;
  card: { id: string; title: string; subtitle?: string };
  error?: string;
}

interface DesktopCardCustomFrameProps {
  html: string;
  title: string;
  payload: DesktopCardCustomPayload;
  onOpenLink: (url: string) => void;
}

// The widget runs in an opaque-origin sandbox and talks to the card only through this bridge.
const BRIDGE_SCRIPT = `(function () {
  var handlers = [];
  var latest = null;
  function deliver(handler) {
    try { handler(latest); } catch (error) { console.error(error); }
  }
  window.openbitfunCard = {
    onData: function (handler) {
      if (typeof handler !== 'function') return;
      handlers.push(handler);
      if (latest) deliver(handler);
    },
    openLink: function (url) {
      parent.postMessage({ source: '${FRAME_MESSAGE_SOURCE}', type: 'open-link', url: String(url) }, '*');
    }
  };
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var message = event.data;
    if (!message || message.source !== '${HOST_MESSAGE_SOURCE}' || message.type !== 'data') return;
    latest = message.payload;
    handlers.forEach(deliver);
  });
  parent.postMessage({ source: '${FRAME_MESSAGE_SOURCE}', type: 'ready' }, '*');
})();`;

export const DESKTOP_CARD_WIDGET_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; overflow: auto; }
html { scrollbar-width: thin; scrollbar-color: var(--openbitfun-color-scrollbar-thumb) transparent; }
body {
  color: var(--openbitfun-color-content-primary);
  font-family: var(--openbitfun-type-body-sm-font-family);
  font-size: var(--openbitfun-type-label-md-font-size);
  line-height: var(--openbitfun-type-body-sm-line-height);
}
a { color: var(--openbitfun-color-accent-default); text-decoration: none; }
img, svg, canvas { max-width: 100%; height: auto; }
.openbitfun-card-stack { display: flex; flex-direction: column; gap: var(--openbitfun-space-2); }
.openbitfun-card-row { display: flex; align-items: center; justify-content: space-between; gap: var(--openbitfun-space-3); min-width: 0; }
.openbitfun-card-value {
  font-family: var(--openbitfun-type-heading-page-font-family);
  font-size: var(--openbitfun-type-heading-page-font-size);
  font-weight: var(--openbitfun-type-heading-page-font-weight);
  line-height: var(--openbitfun-type-heading-page-line-height);
  font-variant-numeric: tabular-nums;
}
.openbitfun-card-muted { color: var(--openbitfun-color-content-secondary); font-size: var(--openbitfun-type-body-sm-font-size); }
.openbitfun-card-truncate { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.openbitfun-card-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.openbitfun-card-item {
  display: flex;
  align-items: center;
  gap: var(--openbitfun-space-2);
  min-width: 0;
  padding: var(--openbitfun-space-1) var(--openbitfun-space-1);
  border-radius: var(--openbitfun-radius-sm);
}
.openbitfun-card-item > .openbitfun-card-truncate { flex: 1 1 auto; }
.openbitfun-card-list > .openbitfun-card-item + .openbitfun-card-item { border-top: var(--openbitfun-border-width-default) solid var(--openbitfun-color-border-subtle); }
.openbitfun-card-item[role='link'], .openbitfun-card-item[data-url] { cursor: pointer; }
.openbitfun-card-item[role='link']:hover, .openbitfun-card-item[data-url]:hover { background: var(--openbitfun-color-action-quiet-hover); }
.openbitfun-card-good { color: var(--openbitfun-color-status-success-content); }
.openbitfun-card-warn { color: var(--openbitfun-color-status-warning-content); }
.openbitfun-card-bad { color: var(--openbitfun-color-status-danger-content); }
`;

export interface DesktopCardWidgetAppearance {
  mode?: string;
  vars: Record<string, string>;
}

function escapeStyleText(value: string): string {
  return value.replace(/<\/style/gi, '<\\/style');
}

function readAppearance(): DesktopCardWidgetAppearance {
  const payload = readWidgetAppearancePayload();
  return { mode: payload?.mode, vars: payload?.vars ?? {} };
}

export function buildDesktopCardSrcDoc(html: string, appearance: DesktopCardWidgetAppearance): string {
  const themeCss = Object.entries(appearance.vars)
    .filter(([name, value]) => /^--[a-z0-9-]+$/i.test(name) && !/[;{}<>]/.test(value))
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
  const mode = appearance.mode === 'light' || appearance.mode === 'dark' ? appearance.mode : undefined;
  // A color-scheme that differs from the card window's makes Chromium (WebView2)
  // paint an opaque light canvas and light scrollbars behind the widget.
  return `<!DOCTYPE html>
<html${mode ? ` data-openbitfun-appearance-mode="${mode}"` : ''}>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; media-src data: https:" />
<style>:root {
color-scheme: ${mode ?? 'light dark'};
${createWidgetAppearanceFallbackCss()}
${escapeStyleText(themeCss)}
}
${DESKTOP_CARD_WIDGET_CSS}</style>
<script>${BRIDGE_SCRIPT}</script>
</head>
<body>${html}</body>
</html>`;
}

export function DesktopCardCustomFrame({ html, title, payload, onOpenLink }: DesktopCardCustomFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const payloadRef = useRef(payload);
  const onOpenLinkRef = useRef(onOpenLink);
  const [appearance, setAppearance] = useState<DesktopCardWidgetAppearance>(readAppearance);
  payloadRef.current = payload;
  onOpenLinkRef.current = onOpenLink;

  useEffect(() => widgetAppearanceAdapter.subscribe(() => {
    setAppearance(readAppearance());
  }), []);

  const srcDoc = useMemo(() => buildDesktopCardSrcDoc(html, appearance), [html, appearance]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const message = event.data as { source?: unknown; type?: unknown; url?: unknown } | null;
      if (!message || message.source !== FRAME_MESSAGE_SOURCE) return;
      if (message.type === 'ready') {
        frameWindow.postMessage({ source: HOST_MESSAGE_SOURCE, type: 'data', payload: payloadRef.current }, '*');
      } else if (message.type === 'open-link' && typeof message.url === 'string') {
        onOpenLinkRef.current(message.url);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ source: HOST_MESSAGE_SOURCE, type: 'data', payload }, '*');
  }, [payload]);

  return (
    <iframe
      ref={iframeRef}
      className="openbitfun-desktop-card__custom-frame"
      title={title}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
    />
  );
}

export default React.memo(DesktopCardCustomFrame);
