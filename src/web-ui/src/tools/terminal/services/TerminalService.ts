import { resolveLegacyTerminalWorkspace } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { workspaceIdRequest } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
/**
 * Terminal service that wraps Tauri backend calls.
 */

import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createLogger } from '@/shared/utils/logger';
import {
  getActiveSurfaceScope,
  getActiveSurfaceId,
  type SurfaceScope,
} from '@/infrastructure/peer-device/deviceSurface';
import type {
  CreateSessionRequest,
  SessionResponse,
  ShellInfo,
  WriteRequest,
  ResizeRequest,
  CloseSessionRequest,
  SignalRequest,
  AcknowledgeRequest,
  ExecuteCommandRequest,
  ExecuteCommandResponse,
  SendCommandRequest,
  GetHistoryResponse,
  TerminalEvent,
  TerminalEventCallback,
  UnsubscribeFunction,
} from '../types';
import { TerminalOriginCache } from './terminalWorkspaceScope';

const log = createLogger('TerminalService');

/**
 * Singleton wrapper for terminal-related Tauri API calls.
 */
export class TerminalService {
  private readonly originCache = new TerminalOriginCache();
  private static instance: TerminalService | null = null;
  
  private eventListeners: Map<string, Set<TerminalEventCallback>> = new Map();
  
  private globalListeners: Set<TerminalEventCallback> = new Set();
  
  private unlistenFn: (() => void) | null = null;

  private connected: boolean = false;

  /** The surface the current event stream is bound to. */
  private streamScope: SurfaceScope | null = null;

  private connectingPromise: Promise<void> | null = null;

  private constructor() {
  }

  static getInstance(): TerminalService {
    if (!TerminalService.instance) {
      TerminalService.instance = new TerminalService();
    }
    return TerminalService.instance;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      if (this.isStreamCurrent()) return;
      // The stream belongs to a device this window no longer renders. Drop the
      // listener only — the PTYs on that device stay up for its agent.
      this.detachEventStream();
    }
    if (this.connectingPromise) return this.connectingPromise;

    const scope = getActiveSurfaceScope();
    const connecting = (async () => {
      this.unlistenFn = api.listen<any>('terminal_event', (payload) => {
        this.handleTerminalEvent(payload);
      });
      this.streamScope = scope;
      this.connected = true;
      log.debug('Connected to terminal event stream');
    })();

    // Cleared only after the attempt settles. Clearing it inside the task ran
    // before this assignment and latched a stale promise, so a reconnect after
    // a surface switch was answered by a connect that had already finished.
    this.connectingPromise = connecting;
    try {
      await connecting;
    } catch (error) {
      log.error('Failed to connect', error);
      throw error;
    } finally {
      if (this.connectingPromise === connecting) {
        this.connectingPromise = null;
      }
    }
  }

  /**
   * Leave the terminal event stream. Frontend-only, and must stay that way:
   * this is what a device surface switch calls, it runs before the transport
   * swaps, so a `terminal_shutdown_all` here would kill the PTYs of the device
   * being left — including the one an agent turn is running in.
   */
  async disconnect(): Promise<void> {
    this.detachEventStream();
    this.eventListeners.clear();
    this.globalListeners.clear();
  }

  private detachEventStream(): void {
    if (this.unlistenFn) {
      this.unlistenFn();
      this.unlistenFn = null;
    }
    this.streamScope = null;
    this.connected = false;
  }

  private isStreamCurrent(): boolean {
    return this.streamScope?.isCurrent() ?? false;
  }

  isConnected(): boolean {
    return this.connected && this.isStreamCurrent();
  }

  /**
   * Handle backend terminal events.
   * Backend format: { type, payload: { session_id, ... } }
   * Frontend format: { type, sessionId, ... }
   */
  private handleTerminalEvent(rawEvent: any): void {
    // An event that raced the switch describes a PTY on the device we left;
    // delivering it here would close tabs and scenes of the one we render now.
    if (!this.isStreamCurrent()) {
      return;
    }

    const eventType = rawEvent.type;
    const payload = rawEvent.payload || {};
    const sessionId = payload.session_id;
    const isSessionDestroyed = eventType === 'SessionDestroyed';

    let event: TerminalEvent;
    switch (eventType) {
      case 'Data':
        event = { type: 'output', sessionId, data: payload.data };
        break;
      case 'Ready':
        event = { type: 'ready', sessionId };
        break;
      case 'SessionCreated':
        event = { type: 'ready', sessionId };
        break;
      case 'Exit':
        event = { type: 'exit', sessionId, exitCode: payload.exit_code };
        break;
      case 'SessionDestroyed':
        // Backend-initiated terminal removal should both mark the terminal exited
        // and notify other UI surfaces to close tabs/scenes bound to this session.
        event = { type: 'exit', sessionId, exitCode: undefined };
        break;
      case 'Error':
        event = { type: 'error', sessionId, message: payload.message || payload.error };
        break;
      case 'CwdChanged':
        event = { type: 'cwd', sessionId, cwd: payload.cwd };
        break;
      case 'TitleChanged':
        event = { type: 'title', sessionId, title: payload.title };
        break;
      case 'Resized':
        event = { type: 'resize', sessionId, cols: payload.cols, rows: payload.rows };
        break;
      case 'CommandStarted':
      case 'CommandFinished':
        return;
      default:
        log.warn('Unknown event type', { eventType });
        return;
    }

    const sessionListeners = this.eventListeners.get(sessionId);
    if (sessionListeners) {
      sessionListeners.forEach(callback => {
        try {
          callback(event);
        } catch (error) {
          log.error('Event callback error', error);
        }
      });
    }

    this.globalListeners.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        log.error('Global callback error', error);
      }
    });

    if (isSessionDestroyed && sessionId) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('terminal-session-destroyed', { detail: { sessionId, surfaceId: getActiveSurfaceId() } })
        );
      }
      this.eventListeners.delete(sessionId);
    }
  }

  onSessionEvent(sessionId: string, callback: TerminalEventCallback): UnsubscribeFunction {
    let listeners = this.eventListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(sessionId, listeners);
    }
    listeners.add(callback);

    return () => {
      listeners?.delete(callback);
      if (listeners?.size === 0) {
        this.eventListeners.delete(sessionId);
      }
    };
  }

  onEvent(callback: TerminalEventCallback): UnsubscribeFunction {
    this.globalListeners.add(callback);
    return () => {
      this.globalListeners.delete(callback);
    };
  }

  async getAvailableShells(): Promise<ShellInfo[]> {
    try {
      const shells = await api.invoke<ShellInfo[]>('terminal_get_shells');
      return shells;
    } catch (error) {
      log.error('Failed to get available shells', error);
      throw error;
    }
  }

  private projectSession(surfaceId: string, session: SessionResponse): SessionResponse {
    const projected = this.originCache.project(surfaceId, session);
    if (projected.workspaceId) return projected;
    const state = workspaceManager.getState();
    return this.originCache.project(surfaceId, { ...projected,
      workspaceId: resolveLegacyTerminalWorkspace(projected,
        [...state.openedWorkspaces.values(), ...state.recentWorkspaces]),
    });
  }

  async createSession(request: CreateSessionRequest): Promise<SessionResponse> {
    const scope = getActiveSurfaceScope();
    try {
      let payload = request;
      if (request.workspaceId) {
        const reference = await workspaceIdRequest(request.workspaceId, 'workspacePath');
        if (!('workspaceId' in reference)) {
          payload = { ...request, workspaceId: undefined, connectionId: reference.remoteConnectionId ?? '' };
        }
      }
      scope.assertCurrent('resolve terminal workspace');
      const session = await api.invoke<SessionResponse>('terminal_create', { request: payload });
      scope.assertCurrent('terminal_create');
      log.debug('Session created', { sessionId: session.id });
      return this.projectSession(scope.surfaceId, {
        ...session, workspaceId: session.workspaceId || request.workspaceId, initialCwd: session.initialCwd || request.workingDirectory || session.cwd,
      });
    } catch (error) {
      log.error('Failed to create session', error);
      throw error;
    }
  }

  async getSession(sessionId: string): Promise<SessionResponse> {
    const scope = getActiveSurfaceScope();
    try {
      const session = await api.invoke<SessionResponse>('terminal_get', { sessionId });
      scope.assertCurrent('terminal_get');
      return this.projectSession(scope.surfaceId, session);
    } catch (error) {
      log.error('Failed to get session', { sessionId, error });
      throw error;
    }
  }

  async listSessions(): Promise<SessionResponse[]> {
    const scope = getActiveSurfaceScope();
    try {
      const sessions = await api.invoke<SessionResponse[]>('terminal_list');
      scope.assertCurrent('terminal_list');
      return sessions.map(session => this.projectSession(scope.surfaceId, session));
    } catch (error) {
      log.error('Failed to list sessions', error);
      throw error;
    }
  }

  async closeSession(sessionId: string, immediate: boolean = false): Promise<void> {
    try {
      const request: CloseSessionRequest = { sessionId, immediate };
      await api.invoke('terminal_close', { request });
      log.debug('Session closed', { sessionId });
      
      this.eventListeners.delete(sessionId);
    } catch (error) {
      log.error('Failed to close session', error);
      throw error;
    }
  }

  /**
   * Kill every PTY on the host. Never part of a device surface switch — use
   * `disconnect()` there; see the comment on it.
   */
  async shutdownAll(): Promise<void> {
    try {
      await api.invoke('terminal_shutdown_all');
      log.debug('All sessions closed');
      this.eventListeners.clear();
    } catch (error) {
      log.error('Failed to shutdown all sessions', error);
      throw error;
    }
  }

  async getHistory(sessionId: string): Promise<GetHistoryResponse> {
    try {
      const history = await api.invoke<GetHistoryResponse>('terminal_get_history', { sessionId });
      return history;
    } catch (error) {
      log.error('Failed to get history', error);
      throw error;
    }
  }

  async write(sessionId: string, data: string): Promise<void> {
    try {
      const request: WriteRequest = { sessionId, data };
      await api.invoke('terminal_write', { request });
    } catch (error) {
      log.error('Failed to write to session', { sessionId, error });
      throw error;
    }
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    try {
      const request: ResizeRequest = { sessionId, cols, rows };
      await api.invoke('terminal_resize', { request });
    } catch (error) {
      log.error('Failed to resize session', { sessionId, cols, rows, error });
      throw error;
    }
  }

  async signal(sessionId: string, signal: string): Promise<void> {
    try {
      const request: SignalRequest = { sessionId, signal };
      await api.invoke('terminal_signal', { request });
    } catch (error) {
      log.error('Failed to send signal', { sessionId, signal, error });
      throw error;
    }
  }

  async acknowledge(sessionId: string, charCount: number): Promise<void> {
    try {
      const request: AcknowledgeRequest = { sessionId, charCount };
      await api.invoke('terminal_ack', { request });
    } catch (error) {
      log.error('Failed to acknowledge data', { sessionId, charCount, error });
      throw error;
    }
  }

  async executeCommand(
    sessionId: string,
    command: string,
    options?: { timeoutMs?: number; preventHistory?: boolean }
  ): Promise<ExecuteCommandResponse> {
    try {
      const request: ExecuteCommandRequest = {
        sessionId,
        command,
        timeoutMs: options?.timeoutMs,
        preventHistory: options?.preventHistory,
      };
      const response = await api.invoke<ExecuteCommandResponse>('terminal_execute', { request });
      return response;
    } catch (error) {
      log.error('Failed to execute command', { sessionId, command, error });
      throw error;
    }
  }

  /**
   * Send a command without waiting for completion or shell integration.
   */
  async sendCommand(sessionId: string, command: string): Promise<void> {
    try {
      const request: SendCommandRequest = {
        sessionId,
        command,
      };
      await api.invoke('terminal_send_command', { request });
    } catch (error) {
      log.error('Failed to send command', { sessionId, command, error });
      throw error;
    }
  }

  async hasShellIntegration(sessionId: string): Promise<boolean> {
    try {
      const result = await api.invoke<boolean>('terminal_has_shell_integration', { sessionId });
      return result;
    } catch (error) {
      log.error('Failed to check shell integration', { sessionId, error });
      return false;
    }
  }

  async sendCtrlC(sessionId: string): Promise<void> {
    await this.signal(sessionId, 'SIGINT');
  }

  async sendCtrlD(sessionId: string): Promise<void> {
    await this.write(sessionId, '\x04');
  }

  async sendCtrlZ(sessionId: string): Promise<void> {
    await this.signal(sessionId, 'SIGTSTP');
  }
}

export function getTerminalService(): TerminalService {
  return TerminalService.getInstance();
}

