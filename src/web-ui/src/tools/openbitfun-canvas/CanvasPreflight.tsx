import { useEffect } from 'react';
import { canvasAPI } from '@/infrastructure/api/service-api/CanvasAPI';
import { createLogger } from '@/shared/utils/logger';
import { readHostAppearancePayload } from './appearance';
import { buildReactCanvasHtmlResult } from './reactRuntime';

const log = createLogger('CanvasPreflight');

export type CanvasPreflightStatus = 'idle' | 'validating' | 'ready' | 'failed' | 'timeout';

interface CanvasPreflightProps {
  artifactReference: string;
  title: string;
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  onStatusChange: (status: CanvasPreflightStatus) => void;
}

export function CanvasPreflight({
  artifactReference,
  title,
  workspaceId,
  workspacePath,
  remoteConnectionId,
  remoteSshHost,
  onStatusChange,
}: CanvasPreflightProps) {
  useEffect(() => {
    let disposed = false;
    let iframe: HTMLIFrameElement | null = null;
    let timeout = 0;
    let terminal = false;
    const context = { artifactReference, workspaceId: workspaceId ?? '' };

    const finish = (status: CanvasPreflightStatus) => {
      if (disposed || terminal) return;
      terminal = status === 'ready' || status === 'failed' || status === 'timeout';
      onStatusChange(status);
    };

    const handleMessage = async (event: MessageEvent) => {
      if (!iframe?.contentWindow || event.source !== iframe.contentWindow) return;
      const message = event.data as Record<string, unknown> | null;
      const type = typeof message?.type === 'string' ? message.type : '';
      if (!type.startsWith('openbitfun-canvas-')) return;
      try {
        if (type === 'openbitfun-canvas-load-state') {
          const response = await canvasAPI.loadState(context);
          iframe.contentWindow.postMessage({
            type: 'openbitfun-canvas-load-state-result',
            requestId: message?.requestId,
            state: response.state ?? null,
          }, '*');
          return;
        }
        if (type === 'openbitfun-canvas-module-started') {
          iframe.contentWindow.postMessage({
            type: 'openbitfun-canvas-appearance',
            appearance: readHostAppearancePayload(),
          }, '*');
          return;
        }
        if (type === 'openbitfun-canvas-save-state') {
          iframe.contentWindow.postMessage({
            type: 'openbitfun-canvas-save-state-result',
            requestId: message?.requestId,
            state: null,
          }, '*');
          return;
        }
        if (type === 'openbitfun-canvas-action') {
          iframe.contentWindow.postMessage({
            type: 'openbitfun-canvas-error',
            requestId: message?.requestId,
            error: 'Canvas host actions are disabled during preflight validation',
          }, '*');
          return;
        }
        if (type === 'openbitfun-canvas-ready') {
          const sourceRevisionSeen = String(message?.sourceRevisionSeen || '');
          const runtimeVersion = String(message?.runtimeVersion || '');
          const sdkVersion = String(message?.sdkVersion || '');
          if (!sourceRevisionSeen || !runtimeVersion || !sdkVersion) {
            throw new Error('Canvas runtime readiness did not include contract versions');
          }
          await canvasAPI.reportRuntimeReady({
            ...context,
            sourceRevisionSeen,
            runtimeVersion,
            sdkVersion,
          });
          finish('ready');
          return;
        }
        if (type === 'openbitfun-canvas-runtime-error' || type === 'openbitfun-canvas-early-error') {
          await canvasAPI.reportRuntimeError({
            ...context,
            sourceRevisionSeen: String(message?.sourceRevisionSeen || '') || undefined,
            message: String(message?.message || 'Canvas runtime error'),
            name: message?.name ? String(message.name) : undefined,
            stack: message?.stack ? String(message.stack) : undefined,
            filename: message?.filename ? String(message.filename) : undefined,
            line: typeof message?.lineno === 'number' ? message.lineno : undefined,
            column: typeof message?.colno === 'number' ? message.colno : undefined,
            componentStack: message?.componentStack ? String(message.componentStack) : undefined,
          });
          finish('failed');
        }
      } catch (error) {
        log.warn('Canvas preflight message handling failed', { artifactReference, type, error });
        finish('failed');
      }
    };

    window.addEventListener('message', handleMessage);
    onStatusChange('validating');
    void canvasAPI.loadArtifact(context).then(response => {
      if (disposed) return;
      const payload = response.canvas?.compiledPayload;
      const rendered = buildReactCanvasHtmlResult(payload?.html, {
        title,
        runtimeVersion: payload?.runtimeVersion,
        sdkVersion: payload?.sdkVersion,
      });
      if (!rendered.html || !payload?.sourceRevision || !payload.runtimeVersion) {
        throw new Error('Canvas preflight requires a versioned compiled payload');
      }

      iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      iframe.srcdoc = rendered.html;
      Object.assign(iframe.style, {
        position: 'fixed', width: '1px', height: '1px', left: '-10000px', top: '-10000px',
        border: '0', opacity: '0', pointerEvents: 'none',
      });
      document.body.appendChild(iframe);

      timeout = window.setTimeout(() => {
        log.warn('Canvas preflight timed out', {
          artifactReference,
          sourceRevision: payload.sourceRevision,
          runtimeVersion: payload.runtimeVersion,
        });
        finish('timeout');
      }, 5000);
    }).catch(error => {
      log.warn('Canvas preflight setup failed', { artifactReference, error });
      finish('failed');
    });

    return () => {
      disposed = true;
      window.removeEventListener('message', handleMessage);
      if (timeout) window.clearTimeout(timeout);
      iframe?.remove();
    };
  }, [artifactReference, onStatusChange, remoteConnectionId, remoteSshHost, title, workspacePath, workspaceId]);

  return null;
}
