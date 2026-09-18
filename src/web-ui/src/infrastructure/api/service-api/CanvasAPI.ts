import { api } from './ApiClient';
import { workspaceScopedRequest } from './legacyWorkspaceCompatibility';

export interface CanvasStateValue {
  canvasId: string;
  sourceRevisionSeen?: string;
  values: Record<string, unknown>;
  valueVersions?: Record<string, number>;
  updatedAt: number;
  schemaVersion: number;
}

export interface CanvasStateRequest {
  artifactReference: string;
  workspaceId: string;
}

export interface SaveCanvasStateRequest extends CanvasStateRequest {
  sourceRevisionSeen?: string;
  values: Record<string, unknown>;
  valueVersions?: Record<string, number>;
  updatedAt: number;
}

export interface ReportCanvasRuntimeErrorRequest extends CanvasStateRequest {
  sourceRevisionSeen?: string;
  message: string;
  name?: string;
  stack?: string;
  filename?: string;
  line?: number;
  column?: number;
  componentStack?: string;
}

export interface ReportCanvasRuntimeReadyRequest extends CanvasStateRequest {
  sourceRevisionSeen: string;
  runtimeVersion: string;
  sdkVersion: string;
}

export interface CanvasStateResponse {
  state?: CanvasStateValue | null;
}

export interface CanvasDiagnosticValue {
  severity?: string;
  category?: string;
  message?: string;
  code?: string;
  line?: number;
  column?: number;
  suggestedFix?: string;
}

export interface CanvasSnapshotValue {
  artifact?: {
    title?: string;
    status?: string;
    sourceRevision?: string;
    latestCompiledRevision?: string;
    latestRenderedRevision?: string;
    lastKnownGoodRevision?: string;
  };
  source?: {
    source?: string;
    filename?: string;
    revision?: string;
  };
  diagnostics?: CanvasDiagnosticValue[];
  compiledPayload?: {
    html?: string;
    sourceRevision?: string;
    contentHash?: string;
    sdkVersion?: string;
    runtimeVersion?: string;
  } | null;
  state?: CanvasStateValue | null;
}

export interface CanvasArtifactResponse {
  canvas: CanvasSnapshotValue;
  artifactReference: string;
}

async function canvasRequest<T extends CanvasStateRequest>(request: T) {
  if (!request.workspaceId) throw new Error('Workspace ID is required for Canvas state');
  return workspaceScopedRequest(request);
}

class CanvasAPI {
  async loadArtifact(request: CanvasStateRequest): Promise<CanvasArtifactResponse> {
    return api.invoke('load_canvas_artifact', { request: await canvasRequest(request) });
  }

  async loadState(request: CanvasStateRequest): Promise<CanvasStateResponse> {
    return api.invoke('load_canvas_state', { request: await canvasRequest(request) });
  }

  async saveState(request: SaveCanvasStateRequest): Promise<CanvasStateResponse> {
    return api.invoke('save_canvas_state', { request: await canvasRequest(request) });
  }

  async reportRuntimeError(request: ReportCanvasRuntimeErrorRequest): Promise<CanvasArtifactResponse> {
    return api.invoke('report_canvas_runtime_error', { request: await canvasRequest(request) });
  }

  async reportRuntimeReady(request: ReportCanvasRuntimeReadyRequest): Promise<CanvasArtifactResponse> {
    return api.invoke('report_canvas_runtime_ready', { request: await canvasRequest(request) });
  }
}

export const canvasAPI = new CanvasAPI();
