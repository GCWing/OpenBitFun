/**
 * MiniAppRunner — sandboxed iframe that runs a compiled MiniApp.
 * Injects the bridge script (already in compiledHtml from Rust compiler)
 * and handles all postMessage RPC via useMiniAppBridge.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MiniApp } from '@/infrastructure/api/service-api/MiniAppAPI';
import { createMiniAppDocumentId } from '../agent/miniAppAgentProtocol';
import { useMiniAppBridge } from '../hooks/useMiniAppBridge';
import type { MiniAppRunScope } from '../customization/miniAppCustomizationTypes';
import { useMiniAppPresentationStore } from '../miniAppPresentationStore';
import {
  registerMiniAppAgentSurface,
  updateMiniAppAgentSurfaceStatus,
} from '../agent/miniAppAgentSurfaceRegistry';

interface MiniAppRunnerProps {
  app: MiniApp;
  runScope?: MiniAppRunScope;
  strictRuntime?: boolean;
  workspacePath?: string | null;
  onReady?: () => void;
  chromeActionRef?: React.MutableRefObject<((actionId: string) => void) | null>;
}

const MiniAppRunner: React.FC<MiniAppRunnerProps> = ({ app, runScope, strictRuntime = false, workspacePath, onReady, chromeActionRef }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Content replacement ends the old document's bridge and pending requests,
  // including in the ordinary same-origin runtime. A new Window identity also
  // prevents queued messages from the old document answering for the new one.
  const documentKey = useMemo(() => app.compiled_html?.trim()
    ? `${app.id}:${createMiniAppDocumentId()}`
    : `${app.id}:empty`, [app.id, app.compiled_html]);
  // The strict runtime replaces the frame element when its blob URL changes, so
  // Agent registration must follow the mounted element instead of the first
  // render; otherwise the registry keeps a detached frame that answers nothing.
  const [surfaceFrame, setSurfaceFrame] = useState<HTMLIFrameElement | null>(null);
  const [loadedFrame, setLoadedFrame] = useState<HTMLIFrameElement | null>(null);
  const attachFrame = useCallback((node: HTMLIFrameElement | null) => {
    iframeRef.current = node;
    setSurfaceFrame(node);
  }, []);
  const runKind = runScope?.kind ?? 'active';
  const agentInstanceId = useMiniAppPresentationStore(state => state.tabs[app.id]?.instance.instanceId);
  const bridgeReady = useMiniAppBridge(
    iframeRef,
    app,
    runScope ?? { kind: 'active', appId: app.id },
    strictRuntime,
    workspacePath,
  );

  // Only the user-visible installed runner is Agent-controllable. A draft
  // preview shares the app id but is a different surface, and unmounting must
  // remove the surface so no stale handle answers for a closed tab.
  useEffect(() => {
    if (runKind !== 'active' || !surfaceFrame) return undefined;
    return registerMiniAppAgentSurface({
      appId: app.id,
      iframe: surfaceFrame,
      strictRuntime,
      instanceId: agentInstanceId,
      ready: false,
    });
  }, [agentInstanceId, app.id, runKind, strictRuntime, surfaceFrame]);

  useEffect(() => {
    if (runKind !== 'active') return;
    updateMiniAppAgentSurfaceStatus(app.id, {
      ready: bridgeReady && surfaceFrame !== null && loadedFrame === surfaceFrame,
      instanceId: agentInstanceId,
    });
  }, [agentInstanceId, app.id, bridgeReady, loadedFrame, runKind, surfaceFrame]);

  useEffect(() => {
    if (!chromeActionRef) return;
    const invoke = (actionId: string) => {
      if (!app.chrome?.titlebar?.actions?.some(action => action.id === actionId && action.enabled !== false)) return;
      iframeRef.current?.contentWindow?.postMessage({ type: 'openbitfun:event', event: 'chrome:action', payload: { actionId } }, '*');
    };
    chromeActionRef.current = invoke;
    return () => { if (chromeActionRef.current === invoke) chromeActionRef.current = null; };
  }, [app.chrome, chromeActionRef]);
  const notified = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const notifyReady = useCallback(() => {
    setLoadedFrame(iframeRef.current);
    if (!notified.current) { notified.current = true; onReadyRef.current?.(); }
  }, []);
  const [strictDocumentUrl, setStrictDocumentUrl] = useState<string>();

  const writeCompiledHtml = useCallback(() => {
    const iframe = iframeRef.current;
    const html = app.compiled_html?.trim();
    if (strictRuntime || !iframe || !html) {
      return false;
    }

    const doc = iframe.contentDocument;
    if (!doc) {
      return false;
    }

    notified.current = false;
    doc.open();
    doc.write(html);
    doc.documentElement.dataset.openbitfunMiniappRendered = app.id;
    doc.close();
    return true;
  }, [app.id, app.compiled_html, strictRuntime]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (strictRuntime || !iframe || iframe !== surfaceFrame) {
      return undefined;
    }

    const html = app.compiled_html?.trim();
    if (!html) {
      return undefined;
    }

    if (writeCompiledHtml()) {
      return undefined;
    }

    const handleLoad = () => {
      writeCompiledHtml();
    };

    iframe.addEventListener('load', handleLoad);
    if (iframe.src !== 'about:blank') {
      iframe.src = 'about:blank';
    }

    return () => {
      iframe.removeEventListener('load', handleLoad);
    };
  }, [app.id, app.compiled_html, strictRuntime, surfaceFrame, writeCompiledHtml]);

  // A fast document may finish before the asynchronous bridge becomes ready.
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!strictRuntime && bridgeReady && doc?.readyState === 'complete'
      && doc.documentElement.dataset.openbitfunMiniappRendered === app.id) notifyReady();
  }, [app.id, app.compiled_html, bridgeReady, strictRuntime, notifyReady]);

  useLayoutEffect(() => {
    const html = app.compiled_html?.trim();
    if (!strictRuntime || !bridgeReady || !html) {
      setStrictDocumentUrl(undefined);
      return undefined;
    }

    // Tauri's WKWebView has rendered srcdoc as a blank document in production.
    // A sandboxed blob navigation is reliable while retaining the strict
    // runtime's unique opaque origin because allow-same-origin is absent.
    notified.current = false;
    const documentUrl = URL.createObjectURL(
      new Blob([html], { type: 'text/html;charset=utf-8' }),
    );
    setStrictDocumentUrl(documentUrl);
    return () => {
      URL.revokeObjectURL(documentUrl);
    };
  }, [app.id, app.compiled_html, bridgeReady, strictRuntime]);

  if (strictRuntime) {
    return (
      <iframe
        key={strictDocumentUrl ?? 'empty'}
        ref={attachFrame}
        src={strictDocumentUrl ?? 'about:blank'}
        onLoad={() => { if (strictDocumentUrl && bridgeReady) notifyReady(); }}
        data-app-id={app.id}
        data-run-scope={runScope?.kind ?? 'active'}
        data-runtime-profile="market-strict"
        sandbox="allow-scripts allow-downloads"
        referrerPolicy="no-referrer"
        style={{ flex: '1 1 auto', width: '100%', minHeight: 0, border: 'none', display: 'block' }}
        title={app.name}
      />
    );
  }

  return (
    <iframe
      key={documentKey}
      ref={attachFrame}
      src="about:blank"
      onLoad={() => {
        if (bridgeReady && iframeRef.current?.contentDocument?.documentElement.dataset.openbitfunMiniappRendered === app.id) notifyReady();
      }}
      data-app-id={app.id}
      data-run-scope={runScope?.kind ?? 'active'}
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
      style={{ flex: '1 1 auto', width: '100%', minHeight: 0, border: 'none', display: 'block' }}
      title={app.name}
    />
  );
};

export default MiniAppRunner;
