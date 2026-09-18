import { captureContentScope } from '@/shared/services/workbenchContentService';
import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon, IconButton } from '@openbitfun/ui';
import { AlertTriangle, Code2, Loader2, MousePointer2 } from 'lucide-react';
import path from 'path-browserify';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { canvasAPI, type CanvasSnapshotValue } from '@/infrastructure/api/service-api/CanvasAPI';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { globalEventBus } from '@/infrastructure/event-bus';
import { fileTabManager } from '@/shared/services/FileTabManager';
import { hasNonFileUriScheme } from '@/shared/utils/pathUtils';
import { parseCanvasArtifactReference } from '@/shared/utils/canvasArtifactReference';
import { createLogger } from '@/shared/utils/logger';
import type { WebElementContext } from '@/shared/types/context';
import { canvasAppearanceAdapter } from '@/infrastructure/appearance/adapters/CanvasAppearanceAdapter';
import { exportCanvasHtml } from './canvasHtmlExportService';
import { buildReactCanvasHtmlResult } from './reactRuntime';
import { readHostAppearancePayload } from './appearance';
import {
  isPeerDeviceModeActive,
  PEER_MODE_CANVAS_POLL_MS,
} from '@/infrastructure/peer-device/peerModeFlag';
import './OpenBitFunCanvasPanel.scss';

const log = createLogger('OpenBitFunCanvasPanel');

const CanvasSourceCodeEditor = React.lazy(() =>
  import('@/tools/editor/components/CodeEditor').then(module => ({
    default: module.default,
  })),
);

export interface OpenBitFunCanvasDiagnostic {
  severity?: string;
  category?: string;
  message?: string;
  code?: string;
  line?: number;
  column?: number;
}

export interface OpenBitFunCanvasPanelProps {
  title?: string;
  artifactReference?: string;
  html?: string;
  source?: string;
  status?: string;
  diagnostics?: OpenBitFunCanvasDiagnostic[];
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

interface CanvasActionRecord {
  type?: unknown;
  text?: unknown;
  filePath?: unknown;
  path?: unknown;
  sessionId?: unknown;
  line?: unknown;
  column?: unknown;
  lineEnd?: unknown;
}

interface CanvasElementReference {
  nodeId?: string | null;
  component?: string;
  tagName?: string;
  selector?: string;
  text?: string;
  bounds?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
}

function normalizeFileTarget(filePath: string, workspacePath?: string): string {
  if (hasNonFileUriScheme(filePath)) {
    throw new Error('Canvas openWorkspaceFile action only supports file paths');
  }
  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(filePath);
  if (isWindowsAbsolutePath || path.isAbsolute(filePath) || !workspacePath) {
    if (!isWindowsAbsolutePath && !path.isAbsolute(filePath) && !workspacePath) {
      throw new Error('Canvas openWorkspaceFile action requires an active workspace for relative paths');
    }
    return filePath;
  }

  return path.join(workspacePath, filePath);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function sessionIdFromCanvasArtifactReference(artifactReference?: string): string | null {
  if (!artifactReference) return null;
  return parseCanvasArtifactReference(artifactReference)?.sessionId ?? null;
}

function canvasAutoRepairPrompt(params: {
  artifactReference: string;
  sourceRevision?: string;
  message: string;
  name?: string;
  stack?: string;
}): string {
  const lines = [
    'Canvas render validation failed after the artifact was opened.',
    '',
    `Artifact: ${params.artifactReference}`,
    params.sourceRevision ? `Source revision: ${params.sourceRevision}` : null,
    `Runtime error: ${params.name ? `${params.name}: ` : ''}${params.message}`,
    params.stack ? `Stack:\n${params.stack}` : null,
    '',
    'Read this Canvas artifact with ReadCanvas, inspect its diagnostics and source, then fix it with PatchCanvas or UpdateCanvas.',
    'Do not stop after explaining the error. The Canvas must compile and render successfully.',
  ].filter(Boolean);
  return lines.join('\n');
}

function formatElementReference(reference: CanvasElementReference, artifactReference?: string): string {
  const parts = [
    'Canvas element reference:',
    artifactReference ? `artifact: ${artifactReference}` : null,
    reference.nodeId ? `node: ${reference.nodeId}` : null,
    reference.component ? `component: ${reference.component}` : null,
    reference.tagName ? `tag: ${reference.tagName}` : null,
    reference.selector ? `selector: ${reference.selector}` : null,
    reference.text ? `text: ${reference.text}` : null,
    reference.bounds
      ? `bounds: x=${reference.bounds.x ?? 0}, y=${reference.bounds.y ?? 0}, width=${reference.bounds.width ?? 0}, height=${reference.bounds.height ?? 0}`
      : null,
  ].filter(Boolean);
  return parts.join('\n');
}

function createCanvasElementContext(
  reference: CanvasElementReference,
  artifactReference?: string,
  title?: string,
): WebElementContext {
  const label = [
    'Canvas',
    reference.component || reference.tagName,
    reference.text ? `- ${reference.text.slice(0, 48)}` : null,
  ].filter(Boolean).join(' ');
  return {
    id: `canvas-element:${artifactReference || 'unknown'}:${reference.selector || reference.tagName || Date.now()}`,
    type: 'web-element',
    timestamp: Date.now(),
    tagName: reference.tagName || 'element',
    path: reference.selector || reference.tagName || 'canvas-element',
    attributes: {
      ...(reference.nodeId ? { id: reference.nodeId } : {}),
      ...(reference.component ? { component: reference.component } : {}),
      ...(artifactReference ? { artifact: artifactReference } : {}),
    },
    textContent: reference.text || '',
    outerHTML: formatElementReference(reference, artifactReference),
    sourceUrl: artifactReference,
    metadata: {
      label,
      canvasTitle: title,
      artifactReference,
      bounds: reference.bounds,
    },
  };
}

function canvasSnapshotSignature(canvas: CanvasSnapshotValue | null | undefined): string {
  if (!canvas) return 'none';
  return [
    canvas.artifact?.status || '',
    canvas.artifact?.sourceRevision || '',
    canvas.artifact?.latestCompiledRevision || '',
    canvas.artifact?.latestRenderedRevision || '',
    canvas.artifact?.lastKnownGoodRevision || '',
    canvas.source?.revision || '',
    canvas.source?.source?.length ?? 0,
    canvas.compiledPayload?.sourceRevision || '',
    canvas.compiledPayload?.contentHash || '',
    canvas.compiledPayload?.sdkVersion || '',
    canvas.compiledPayload?.runtimeVersion || '',
    canvas.compiledPayload?.html?.length ?? 0,
    canvas.diagnostics?.length ?? 0,
    canvas.diagnostics?.map(diagnostic => `${diagnostic.severity || ''}:${diagnostic.code || ''}:${diagnostic.message || ''}`).join('|') || '',
  ].join('\u0000');
}

export const OpenBitFunCanvasPanel: React.FC<OpenBitFunCanvasPanelProps> = ({
  title,
  artifactReference,
  html,
  source,
  status,
  diagnostics = [],
  workspaceId,
  workspacePath,
  remoteConnectionId,
  remoteSshHost,
}) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeStatusRef = useRef({
    bootStarted: false,
    moduleStarted: false,
    ready: false,
    runtimeError: false,
  });
  const reportedRuntimeErrorsRef = useRef(new Set<string>());
  const reportedReadyRevisionsRef = useRef(new Set<string>());
  const autoRepairRuntimeErrorsRef = useRef(new Set<string>());
  const loadedCanvasSignatureRef = useRef<string | null>(null);
  const [sourceVisible, setSourceVisible] = useState(false);
  const [designMode, setDesignMode] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [loadedCanvas, setLoadedCanvas] = useState<CanvasSnapshotValue | null>(null);
  const [frameReadyKey, setFrameReadyKey] = useState<string | null>(null);
  const resolvedHtml = loadedCanvas?.compiledPayload?.html || html;
  const resolvedSource = loadedCanvas?.source?.source || source;
  const resolvedStatus = loadedCanvas?.artifact?.status || status;
  const resolvedDiagnostics = loadedCanvas?.diagnostics ?? diagnostics;
  const resolvedTitle = loadedCanvas?.artifact?.title || title || 'OpenBitFun Canvas';
  const renderedCanvas = useMemo(
    () => buildReactCanvasHtmlResult(resolvedHtml, {
      title: resolvedTitle,
      runtimeVersion: loadedCanvas?.compiledPayload?.runtimeVersion,
      sdkVersion: loadedCanvas?.compiledPayload?.sdkVersion,
    }),
    [loadedCanvas?.compiledPayload?.runtimeVersion, loadedCanvas?.compiledPayload?.sdkVersion, resolvedHtml, resolvedTitle],
  );
  const renderedHtml = renderedCanvas.html;
  const hasHtml = typeof renderedHtml === 'string' && renderedHtml.trim().length > 0;
  const renderedHtmlKey = `${renderedCanvas.runtime}:${renderedCanvas.revision ?? ''}:${renderedHtml?.length ?? 0}`;
  const frameDocumentKey = `${artifactReference ?? 'inline'}:${renderedHtmlKey}`;
  const isFrameReady = frameReadyKey === frameDocumentKey;
  const sourcePreview = useMemo(() => {
    if (!resolvedSource) return '';
    return resolvedSource.length > 5000 ? `${resolvedSource.slice(0, 5000)}\n...` : resolvedSource;
  }, [resolvedSource]);
  const sourceDialogText = resolvedSource || renderedHtml || '';
  const sourceDialogFileName = resolvedSource ? 'canvas.source.tsx' : 'canvas.html';
  const sourceDialogFilePath = `OpenBitFun Canvas/${sourceDialogFileName}`;
  const sourceDialogLanguage = resolvedSource ? 'typescriptreact' : 'html';
  const sourceDialogKey = `${sourceDialogFileName}:${sourceDialogText.length}:${renderedCanvas.revision ?? renderedHtmlKey}`;
  const hasSourceDialogText = sourceDialogText.trim().length > 0;

  useEffect(() => {
    loadedCanvasSignatureRef.current = null;
    reportedRuntimeErrorsRef.current.clear();
    reportedReadyRevisionsRef.current.clear();
    autoRepairRuntimeErrorsRef.current.clear();
    setLoadedCanvas(null);
  }, [artifactReference]);

  useEffect(() => {
    log.info('Canvas preview HTML resolved', {
      artifactReference,
      runtime: renderedCanvas.runtime,
      revision: renderedCanvas.revision,
      hasResolvedHtml: Boolean(resolvedHtml),
      inputLength: resolvedHtml?.length ?? 0,
      outputLength: renderedHtml?.length ?? 0,
      status: resolvedStatus,
      diagnosticCount: resolvedDiagnostics.length,
    });
  }, [
    artifactReference,
    renderedCanvas.revision,
    renderedCanvas.runtime,
    renderedHtml,
    resolvedDiagnostics.length,
    resolvedHtml,
    resolvedStatus,
  ]);

  const postToIframe = useCallback((message: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(message, '*');
  }, []);

  const postAppearanceToIframe = useCallback(() => {
    postToIframe({ type: 'openbitfun-canvas-appearance', appearance: readHostAppearancePayload() });
  }, [postToIframe]);

  const postDesignModeToIframe = useCallback((enabled: boolean) => {
    postToIframe({ type: 'openbitfun-canvas-design-mode', enabled });
  }, [postToIframe]);

  const applyLoadedCanvas = useCallback((canvas: CanvasSnapshotValue | null, reason: string) => {
    const nextSignature = canvasSnapshotSignature(canvas);
    if (loadedCanvasSignatureRef.current === nextSignature) {
      return false;
    }
    loadedCanvasSignatureRef.current = nextSignature;
    log.info('Canvas artifact snapshot changed', {
      artifactReference,
      reason,
      status: canvas?.artifact?.status,
      sourceRevision: canvas?.source?.revision || canvas?.artifact?.sourceRevision,
      compiledRevision: canvas?.compiledPayload?.sourceRevision,
      compiledHash: canvas?.compiledPayload?.contentHash,
      hasCompiledHtml: Boolean(canvas?.compiledPayload?.html),
      diagnosticCount: canvas?.diagnostics?.length ?? 0,
    });
    setLoadedCanvas(canvas);
    return true;
  }, [artifactReference]);

  const loadArtifactSnapshot = useCallback(async (reason: string) => {
    if (!artifactReference) return null;
    const response = await canvasAPI.loadArtifact({

      workspaceId: workspaceId ?? '',
      artifactReference,
    });
    const canvas = response.canvas ?? null;
    applyLoadedCanvas(canvas, reason);
    return canvas;
  }, [applyLoadedCanvas, artifactReference, workspaceId]);

  const loadState = useCallback(async () => {
    if (!artifactReference) return null;
    const response = await canvasAPI.loadState({

      workspaceId: workspaceId ?? '',
      artifactReference,
    });
    return response.state ?? null;
  }, [artifactReference, workspaceId]);

  const requestCanvasAutoRepair = useCallback(async (data: {
    message: string;
    name?: string;
    stack?: string;
    sourceRevisionSeen?: string;
  }) => {
    if (!artifactReference) return;
    const targetSessionId = sessionIdFromCanvasArtifactReference(artifactReference);
    if (!targetSessionId) {
      log.warn('Cannot auto-repair Canvas runtime error without artifact session id', {
        artifactReference,
        revision: data.sourceRevisionSeen,
      });
      return;
    }
    const session = flowChatStore.getState().sessions.get(targetSessionId);
    if (!session) {
      log.warn('Cannot auto-repair Canvas runtime error because session is not loaded', {
        artifactReference,
        targetSessionId,
        revision: data.sourceRevisionSeen,
      });
      return;
    }

    const repairKey = [
      artifactReference,
      data.sourceRevisionSeen ?? '',
      data.name ?? '',
      data.message,
      data.stack ?? '',
    ].join('\u0000');
    if (autoRepairRuntimeErrorsRef.current.has(repairKey)) return;
    autoRepairRuntimeErrorsRef.current.add(repairKey);

    const prompt = canvasAutoRepairPrompt({
      artifactReference,
      sourceRevision: data.sourceRevisionSeen,
      message: data.message,
      name: data.name,
      stack: data.stack,
    });
    const mode = session.mode || 'Standard';
    try {
      const { FlowChatManager } = await import('@/flow_chat/services/FlowChatManager');
      await FlowChatManager.getInstance().sendMessage(
        prompt,
        targetSessionId,
        `Fix Canvas runtime error for ${artifactReference}`,
        mode,
        mode,
        {
          userMessageMetadata: {
            source: 'canvas-runtime-auto-repair',
            artifactReference,
            sourceRevisionSeen: data.sourceRevisionSeen,
          },
        },
      );
      log.info('Queued Canvas runtime auto-repair request', {
        artifactReference,
        targetSessionId,
        revision: data.sourceRevisionSeen,
      });
    } catch (error) {
      autoRepairRuntimeErrorsRef.current.delete(repairKey);
      log.warn('Failed to queue Canvas runtime auto-repair request', {
        artifactReference,
        targetSessionId,
        revision: data.sourceRevisionSeen,
        error,
      });
    }
  }, [artifactReference]);

  const reportRuntimeError = useCallback(async (data: {
    message?: unknown;
    name?: unknown;
    stack?: unknown;
    filename?: unknown;
    lineno?: unknown;
    colno?: unknown;
    componentStack?: unknown;
  }) => {
    if (!artifactReference) return;
    const message = String(data.message || 'Canvas runtime error');
    const name = data.name ? String(data.name) : undefined;
    const stack = data.stack ? String(data.stack) : undefined;
    const sourceRevisionSeen = renderedCanvas.revision;
    const dedupeKey = [
      artifactReference,
      sourceRevisionSeen ?? '',
      name ?? '',
      message,
      stack ?? '',
    ].join('\u0000');
    if (reportedRuntimeErrorsRef.current.has(dedupeKey)) return;
    reportedRuntimeErrorsRef.current.add(dedupeKey);
    try {
      const response = await canvasAPI.reportRuntimeError({

      workspaceId: workspaceId ?? '',
        artifactReference,
        sourceRevisionSeen,
        message,
        name,
        stack,
        filename: data.filename ? String(data.filename) : undefined,
        line: typeof data.lineno === 'number' ? data.lineno : undefined,
        column: typeof data.colno === 'number' ? data.colno : undefined,
        componentStack: data.componentStack ? String(data.componentStack) : undefined,
      });
      applyLoadedCanvas(response.canvas ?? null, 'runtime-error');
      void requestCanvasAutoRepair({
        message,
        name,
        stack,
        sourceRevisionSeen,
      });
    } catch (error) {
      log.warn('Failed to report Canvas runtime error', {
        artifactReference,
        revision: sourceRevisionSeen,
        error,
      });
    }
  }, [
    applyLoadedCanvas,
    artifactReference,
    requestCanvasAutoRepair,
    renderedCanvas.revision,
    workspaceId,
  ]);

  const reportRuntimeReady = useCallback(async (data: {
    sourceRevisionSeen?: unknown;
    runtimeVersion?: unknown;
    sdkVersion?: unknown;
  }) => {
    const expectedRevision = renderedCanvas.revision;
    const expectedRuntimeVersion = loadedCanvas?.compiledPayload?.runtimeVersion;
    const expectedSdkVersion = loadedCanvas?.compiledPayload?.sdkVersion;
    const sourceRevisionSeen = String(data.sourceRevisionSeen || '');
    const runtimeVersion = String(data.runtimeVersion || '');
    const sdkVersion = String(data.sdkVersion || '');
    if (
      !artifactReference
      || renderedCanvas.runtime !== 'react'
      || !expectedRevision
      || !expectedRuntimeVersion
      || !expectedSdkVersion
    ) return;
    if (
      sourceRevisionSeen !== expectedRevision
      || runtimeVersion !== expectedRuntimeVersion
      || sdkVersion !== expectedSdkVersion
    ) {
      log.warn('Ignored mismatched Canvas runtime readiness', {
        artifactReference,
        expectedRevision,
        sourceRevisionSeen,
        expectedRuntimeVersion,
        runtimeVersion,
        expectedSdkVersion,
        sdkVersion,
      });
      return;
    }
    const key = `${artifactReference}\u0000${sourceRevisionSeen}\u0000${runtimeVersion}\u0000${sdkVersion}`;
    if (reportedReadyRevisionsRef.current.has(key)) return;
    reportedReadyRevisionsRef.current.add(key);
    try {
      const response = await canvasAPI.reportRuntimeReady({

      workspaceId: workspaceId ?? '',
        artifactReference,
        sourceRevisionSeen,
        runtimeVersion,
        sdkVersion,
      });
      applyLoadedCanvas(response.canvas ?? null, 'runtime-ready');
    } catch (error) {
      reportedReadyRevisionsRef.current.delete(key);
      log.warn('Failed to report Canvas runtime readiness', {
        artifactReference,
        revision: sourceRevisionSeen,
        runtimeVersion,
        error,
      });
    }
  }, [
    applyLoadedCanvas,
    artifactReference,
    loadedCanvas?.compiledPayload?.runtimeVersion,
    loadedCanvas?.compiledPayload?.sdkVersion,
    renderedCanvas.revision,
    renderedCanvas.runtime,
    workspaceId,
  ]);

  const initializeIframe = useCallback(async (reason: string) => {
    if (!hasHtml) return;
    log.info('Initializing Canvas iframe', {
      artifactReference,
      runtime: renderedCanvas.runtime,
      revision: renderedCanvas.revision,
      reason,
    });
    postAppearanceToIframe();
    postDesignModeToIframe(designMode);
    if (artifactReference) {
      const state = await loadState();
      postToIframe({ type: 'openbitfun-canvas-state', state });
    }
  }, [
    artifactReference,
    designMode,
    hasHtml,
    loadState,
    postDesignModeToIframe,
    postAppearanceToIframe,
    postToIframe,
    renderedCanvas.revision,
    renderedCanvas.runtime,
  ]);

  useEffect(() => {
    if (!artifactReference) return;

    let cancelled = false;
    log.info('Loading Canvas artifact snapshot', { artifactReference });
    void loadArtifactSnapshot('initial').then(() => {
      if (cancelled) return;
    }).catch((error) => {
      log.warn('Failed to load Canvas artifact snapshot', { artifactReference, error });
    });

    return () => {
      cancelled = true;
    };
  }, [artifactReference, loadArtifactSnapshot]);

  useEffect(() => {
    if (!artifactReference) return undefined;

    let cancelled = false;
    const refresh = async (reason: string) => {
      if (cancelled || document.visibilityState === 'hidden') return;
      try {
        await loadArtifactSnapshot(reason);
      } catch (error) {
        log.warn('Failed to refresh Canvas artifact snapshot', { artifactReference, reason, error });
      }
    };

    const interval = window.setInterval(() => {
      void refresh('poll');
    }, isPeerDeviceModeActive() ? PEER_MODE_CANVAS_POLL_MS : 2000);
    const handleFocus = () => {
      void refresh('focus');
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refresh('visible');
      }
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [artifactReference, loadArtifactSnapshot]);

  const handleCanvasAction = useCallback(async (action: unknown) => {
    if (!action || typeof action !== 'object') {
      log.warn('Ignoring invalid Canvas action');
      return null;
    }
    const record = action as CanvasActionRecord;
    switch (record.type) {
      case 'copyText': {
        if (typeof record.text !== 'string') {
          log.warn('Ignoring Canvas copyText action without text');
          return null;
        }
        await systemAPI.setClipboard(record.text);
        return { copied: true };
      }
      case 'showSource': {
        setSourceVisible(true);
        return { visible: true };
      }
      case 'openWorkspaceFile': {
        const requestedPath = typeof record.filePath === 'string'
          ? record.filePath.trim()
          : typeof record.path === 'string'
            ? record.path.trim()
            : '';
        if (!requestedPath) {
          throw new Error('Canvas openWorkspaceFile action requires filePath');
        }
        if (!workspaceId) throw new Error('Canvas workspace ID is unavailable');
        const filePath = normalizeFileTarget(requestedPath, workspacePath);
        const line = positiveInteger(record.line);
        const column = positiveInteger(record.column);
        const lineEnd = positiveInteger(record.lineEnd);
        if (line && lineEnd && lineEnd > line) {
          fileTabManager.openFile({
            filePath,
            workspacePath,
            scope: captureContentScope({ workspaceId }),
            jumpToRange: { start: line, end: lineEnd },
            mode: 'agent',
          });
        } else if (line) {
          fileTabManager.openFileAndJump(filePath, line, column, {
            workspacePath,
            scope: captureContentScope({ workspaceId }),
            mode: 'agent',
          });
        } else {
          fileTabManager.openFile({
            filePath,
            workspacePath,
            scope: captureContentScope({ workspaceId }),
            mode: 'agent',
          });
        }
        return { opened: true, filePath };
      }
      case 'openSession': {
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
        if (!sessionId) {
          throw new Error('Canvas openSession action requires sessionId');
        }
        const session = flowChatStore.getState().sessions.get(sessionId);
        if (!session) {
          throw new Error(`Canvas openSession target was not found: ${sessionId}`);
        }
        flowChatStore.switchSession(sessionId);
        return { opened: true, sessionId };
      }
      default:
        log.warn('Unsupported Canvas action requested', { type: record.type });
        throw new Error(`Unsupported Canvas action: ${String(record.type)}`);
    }
  }, [workspaceId, workspacePath]);

  const handleExportHtml = useCallback(async () => {
    if (!renderedHtml || exportingHtml) return;
    setExportingHtml(true);
    try {
      await exportCanvasHtml({
        html: renderedHtml,
        title: resolvedTitle,
      });
    } catch (error) {
      log.error('Failed to export Canvas HTML', {
        artifactReference,
        runtime: renderedCanvas.runtime,
        revision: renderedCanvas.revision,
        error,
      });
    } finally {
      setExportingHtml(false);
    }
  }, [
    artifactReference,
    exportingHtml,
    renderedCanvas.revision,
    renderedCanvas.runtime,
    renderedHtml,
    resolvedTitle,
  ]);

  useLayoutEffect(() => {
    if (!hasHtml || !artifactReference) {
      setFrameReadyKey(null);
      return;
    }
    iframeStatusRef.current = {
      bootStarted: false,
      moduleStarted: false,
      ready: false,
      runtimeError: false,
    };

    const handleMessage = async (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const maybeType = (data as { type?: unknown }).type;
      if (typeof maybeType !== 'string' || !maybeType.startsWith('openbitfun-canvas-')) return;
      if (!iframeWindow) return;
      if (event.source !== iframeWindow) {
        log.warn('Canvas iframe message source mismatch; ignoring message', {
          artifactReference,
          runtime: renderedCanvas.runtime,
          revision: renderedCanvas.revision,
          type: maybeType,
        });
        return;
      }
      const message = data as {
        type?: string;
        requestId?: string;
        values?: Record<string, unknown>;
        valueVersions?: Record<string, number>;
        sourceRevisionSeen?: string;
        action?: unknown;
        reference?: CanvasElementReference;
      };

      try {
        switch (message.type) {
          case 'openbitfun-canvas-boot-started': {
            iframeStatusRef.current.bootStarted = true;
            log.info('Canvas iframe boot script started', {
              artifactReference,
              runtime: renderedCanvas.runtime,
              revision: renderedCanvas.revision,
            });
            break;
          }
          case 'openbitfun-canvas-react-loaded': {
            log.info('Canvas iframe React loaded', {
              artifactReference,
              runtime: renderedCanvas.runtime,
              revision: renderedCanvas.revision,
              hasReact: (data as { hasReact?: unknown }).hasReact,
            });
            break;
          }
          case 'openbitfun-canvas-react-dom-loaded': {
            log.info('Canvas iframe ReactDOM loaded', {
              artifactReference,
              runtime: renderedCanvas.runtime,
              revision: renderedCanvas.revision,
              hasReactDOM: (data as { hasReactDOM?: unknown }).hasReactDOM,
              hasCreateRoot: (data as { hasCreateRoot?: unknown }).hasCreateRoot,
            });
            break;
          }
          case 'openbitfun-canvas-early-error': {
            iframeStatusRef.current.runtimeError = true;
            log.warn('Canvas iframe early runtime error', {
              artifactReference,
              runtime: renderedCanvas.runtime,
              revision: renderedCanvas.revision,
              message: (data as { message?: unknown }).message,
              name: (data as { name?: unknown }).name,
              filename: (data as { filename?: unknown }).filename,
              lineno: (data as { lineno?: unknown }).lineno,
              colno: (data as { colno?: unknown }).colno,
            });
            void reportRuntimeError(data);
            break;
          }
          case 'openbitfun-canvas-ready': {
            iframeStatusRef.current.ready = true;
            log.info('Canvas iframe reported ready', {
              artifactReference,
              runtime: renderedCanvas.runtime,
              revision: renderedCanvas.revision,
            });
            await initializeIframe('ready');
            await reportRuntimeReady(data);
            break;
          }
          case 'openbitfun-canvas-module-started': {
            iframeStatusRef.current.moduleStarted = true;
            log.info('Canvas iframe module started', {
              artifactReference,
              runtime: renderedCanvas.runtime,
              revision: renderedCanvas.revision,
            });
            await initializeIframe('module-started');
            break;
          }
          case 'openbitfun-canvas-state-warning': {
            log.warn('Canvas rejected incompatible persisted state', {
              artifactReference,
              revision: renderedCanvas.revision,
              key: (data as { key?: unknown }).key,
              message: (data as { message?: unknown }).message,
            });
            break;
          }
          case 'openbitfun-canvas-prop-warning': {
            log.warn('Canvas ignored an invalid component prop value', {
              artifactReference,
              revision: renderedCanvas.revision,
              component: (data as { component?: unknown }).component,
              prop: (data as { prop?: unknown }).prop,
              message: (data as { message?: unknown }).message,
            });
            break;
          }
          case 'openbitfun-canvas-load-state': {
            const state = await loadState();
            postToIframe({
              type: 'openbitfun-canvas-load-state-result',
              requestId: message.requestId,
              state,
            });
            break;
          }
          case 'openbitfun-canvas-save-state': {
            const response = await canvasAPI.saveState({

      workspaceId: workspaceId ?? '',
              artifactReference,
              sourceRevisionSeen: message.sourceRevisionSeen,
              values: message.values ?? {},
              valueVersions: message.valueVersions ?? {},
              updatedAt: Date.now(),
            });
            postToIframe({
              type: 'openbitfun-canvas-save-state-result',
              requestId: message.requestId,
              state: response.state ?? null,
            });
            break;
          }
          case 'openbitfun-canvas-action': {
            const result = await handleCanvasAction(message.action);
            postToIframe({
              type: 'openbitfun-canvas-action-result',
              requestId: message.requestId,
              result,
            });
            break;
          }
          case 'openbitfun-canvas-runtime-error': {
            iframeStatusRef.current.runtimeError = true;
            log.warn('Canvas runtime error', {
              artifactReference,
              runtime: renderedCanvas.runtime,
              revision: renderedCanvas.revision,
              message: (data as { message?: unknown }).message,
              name: (data as { name?: unknown }).name,
              stack: (data as { stack?: unknown }).stack,
            });
            void reportRuntimeError(data);
            break;
          }
          case 'openbitfun-canvas-element-selected': {
            setDesignMode(false);
            if (message.reference) {
              globalEventBus.emit(
                'fill-chat-input',
                {
                  context: createCanvasElementContext(message.reference, artifactReference, resolvedTitle),
                },
                'OpenBitFunCanvasPanel',
              );
            }
            break;
          }
          default:
            break;
        }
      } catch (error) {
        log.error('Canvas iframe message handling failed', { type: message.type, error });
        if (message.requestId) {
          postToIframe({
            type: message.type === 'openbitfun-canvas-action'
              ? 'openbitfun-canvas-action-result'
              : 'openbitfun-canvas-error',
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    window.addEventListener('message', handleMessage);
    setFrameReadyKey(frameDocumentKey);
    const timer = window.setTimeout(() => {
      const status = iframeStatusRef.current;
      if (renderedCanvas.runtime === 'react' && !status.moduleStarted && !status.ready && !status.runtimeError) {
        log.warn('Canvas iframe did not report runtime startup', {
          artifactReference,
          runtime: renderedCanvas.runtime,
          revision: renderedCanvas.revision,
          renderedHtmlLength: renderedHtml?.length ?? 0,
          frameTransport: 'srcdoc',
          bootStarted: status.bootStarted,
        });
      }
    }, 1200);
    return () => {
      window.removeEventListener('message', handleMessage);
      window.clearTimeout(timer);
    };
  }, [
    artifactReference,
    designMode,
    frameDocumentKey,
    handleCanvasAction,
    hasHtml,
    initializeIframe,
    loadState,
    postDesignModeToIframe,
    postToIframe,
    postAppearanceToIframe,
    reportRuntimeError,
    reportRuntimeReady,
    renderedHtml,
    renderedHtmlKey,
    renderedCanvas.revision,
    renderedCanvas.runtime,
    remoteConnectionId,
    resolvedTitle,
    remoteSshHost,
    workspacePath,
    workspaceId,
  ]);

  useEffect(() => {
    if (!hasHtml) return;
    postDesignModeToIframe(designMode);
  }, [designMode, hasHtml, postDesignModeToIframe]);

  useEffect(() => {
    if (!hasHtml) return;
    postAppearanceToIframe();
    return canvasAppearanceAdapter.subscribe(postAppearanceToIframe);
  }, [hasHtml, postAppearanceToIframe]);

  useEffect(() => {
    if (!hasSourceDialogText && sourceVisible) {
      setSourceVisible(false);
    }
  }, [hasSourceDialogText, sourceVisible]);

  if (!hasHtml) {
    return (
      <div className="openbitfun-canvas-panel openbitfun-canvas-panel--empty" data-openbitfun-component="canvas-tool" data-openbitfun-part="empty" data-openbitfun-state="empty">
        <div className="openbitfun-canvas-panel__message" data-openbitfun-component="canvas-tool" data-openbitfun-part="message">
          <AlertTriangle size={18} />
          <div>
            <h3>{resolvedTitle}</h3>
            <p>Canvas preview is unavailable for this revision.</p>
            {resolvedStatus && <span>Status: {resolvedStatus}</span>}
          </div>
        </div>
        {resolvedDiagnostics.length > 0 && (
          <ul className="openbitfun-canvas-panel__diagnostics" data-openbitfun-component="canvas-tool" data-openbitfun-part="diagnostics">
            {resolvedDiagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code || diagnostic.message || 'diagnostic'}-${index}`}>
                {diagnostic.message || diagnostic.code || 'Canvas diagnostic'}
              </li>
            ))}
          </ul>
        )}
        {sourcePreview && <pre className="openbitfun-canvas-panel__source" data-openbitfun-component="canvas-tool" data-openbitfun-part="source">{sourcePreview}</pre>}
      </div>
    );
  }

  return (
    <div className="openbitfun-canvas-panel" data-openbitfun-component="canvas-tool" data-openbitfun-part="root">
      <div className="openbitfun-canvas-panel__toolbar" data-openbitfun-component="canvas-tool" data-openbitfun-part="toolbar">
        <IconButton
          type="button"
          className={`openbitfun-canvas-panel__toolbar-button${sourceVisible ? ' openbitfun-canvas-panel__toolbar-button--active' : ''}`}
          aria-pressed={sourceVisible}
          aria-label={sourceVisible ? 'Hide Canvas source' : 'Show Canvas source'}
          title={sourceVisible ? 'Hide Canvas source' : 'Show Canvas source'}
          disabled={!hasSourceDialogText}
          onClick={() => setSourceVisible(value => !value)}
          icon={<Code2 size={15} />}
        />
        <IconButton
          type="button"
          className={`openbitfun-canvas-panel__toolbar-button${designMode ? ' openbitfun-canvas-panel__toolbar-button--active' : ''}`}
          aria-pressed={designMode}
          title="Select Canvas element"
          onClick={() => setDesignMode(value => !value)}
          aria-label="Select Canvas element"
          icon={<MousePointer2 size={15} />}
        />
        <IconButton
          type="button"
          className="openbitfun-canvas-panel__toolbar-button"
          title="Export HTML"
          aria-label="Export Canvas HTML"
          disabled={exportingHtml}
          onClick={handleExportHtml}
          icon={exportingHtml ? <Loader2 size={15} className="openbitfun-canvas-panel__toolbar-icon--spin" /> : <Icon name="arrow-down" size="sm" />}
        />
      </div>
      {isFrameReady && (
        <iframe
          key={frameDocumentKey}
          ref={iframeRef}
          className="openbitfun-canvas-panel__frame"
          data-openbitfun-component="canvas-tool"
          data-openbitfun-part="frame"
          title={resolvedTitle}
          srcDoc={renderedHtml}
          sandbox="allow-scripts"
          data-artifact-reference={artifactReference}
          onLoad={() => {
            log.info('Canvas iframe loaded', {
              artifactReference,
              runtime: renderedCanvas.runtime,
              revision: renderedCanvas.revision,
              frameTransport: 'srcdoc',
            });
            void initializeIframe('load');
          }}
        />
      )}
      {sourceVisible && (
        <div className="openbitfun-canvas-panel__source-overlay" role="dialog" aria-modal="true" data-openbitfun-component="canvas-tool" data-openbitfun-part="sourceOverlay">
          <div className="openbitfun-canvas-panel__source-dialog" data-openbitfun-component="canvas-tool" data-openbitfun-part="sourceDialog">
            <div className="openbitfun-canvas-panel__source-editor">
              <Suspense fallback={<div className="openbitfun-canvas-panel__source-loading">Loading editor...</div>}>
                <CanvasSourceCodeEditor
                  key={sourceDialogKey}
                  filePath={sourceDialogFilePath}
                  fileName={sourceDialogFileName}
                  initialContent={sourceDialogText}
                  language={sourceDialogLanguage}
                  readOnly
                  showBreadcrumb={false}
                  showLineNumbers
                  showMinimap
                  isActiveTab={sourceVisible}
                  className="openbitfun-canvas-panel__source-code-editor"
                />
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default OpenBitFunCanvasPanel;
