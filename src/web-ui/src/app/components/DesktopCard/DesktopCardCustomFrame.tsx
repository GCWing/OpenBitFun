import React, { useEffect, useMemo, useRef, useState } from 'react';
import { widgetAppearanceAdapter } from '@/infrastructure/appearance/adapters/WidgetAppearanceAdapter';
import { readWidgetAppearancePayload } from '@/tools/generative-widget/appearancePayload';
import { buildDesktopCardSrcDoc, FRAME_MESSAGE_SOURCE, HOST_MESSAGE_SOURCE, type DesktopCardCustomPayload, type DesktopCardWidgetAppearance } from './desktopCardSrcDoc';

interface DesktopCardCustomFrameProps {
  html: string;
  title: string;
  payload: DesktopCardCustomPayload;
  onOpenLink: (url: string) => void;
}

function readAppearance(): DesktopCardWidgetAppearance {
  const payload = readWidgetAppearancePayload();
  return { mode: payload?.mode, vars: payload?.vars ?? {} };
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
