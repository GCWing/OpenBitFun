/**
 * Terminal session types aligned with backend terminal_api.rs.
 */

export type SessionStatus = 'Running' | 'Stopped' | 'Exited' | 'Error';

export type TerminalSessionSource = 'manual' | 'agent';

export type ShellType = 
  | 'PowerShell' 
  | 'Cmd' 
  | 'Bash' 
  | 'Zsh' 
  | 'Fish' 
  | 'Sh';

export interface CreateSessionRequest {
  workspaceId?: string;
  sessionId?: string;
  name?: string;
  shellType?: ShellType | string;
  /** Stable identifier for an exact discovered shell executable. */
  shellId?: string;
  workingDirectory?: string;
  /** Open a remote PTY on this SSH connection without a registered workspace. */
  connectionId?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  source?: TerminalSessionSource;
}

export interface SessionResponse {
  workspaceId?: string;
  id: string;
  name: string;
  shellType: string;
  cwd: string;
  /** Immutable creation directory; omitted by older hosts. */
  initialCwd?: string;
  pid?: number;
  status: SessionStatus | string;
  cols: number;
  rows: number;
  connectionId?: string;
  source: TerminalSessionSource;
}

export interface ShellInfo {
  /** Stable identifier for a discovered executable. */
  id: string;
  shellType: string;
  name: string;
  path: string;
  version?: string;
  /** Discovery source reported by terminal-core, such as `path` or `systemInstall`. */
  discoverySource?: string;
  available: boolean;
}

export interface WriteRequest {
  sessionId: string;
  data: string;
}

export interface ResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface CloseSessionRequest {
  sessionId: string;
  immediate?: boolean;
}

export interface SignalRequest {
  sessionId: string;
  signal: string;
}

export interface AcknowledgeRequest {
  sessionId: string;
  charCount: number;
}

export interface ExecuteCommandRequest {
  sessionId: string;
  command: string;
  timeoutMs?: number;
  preventHistory?: boolean;
}

export interface ExecuteCommandResponse {
  command: string;
  commandId: string;
  output: string;
  exitCode?: number;
  completionReason: 'completed' | 'timedOut';
}

export interface SendCommandRequest {
  sessionId: string;
  command: string;
}

export interface TerminalReplayEvent {
  /** PTY column count to apply before writing data. */
  cols: number;
  /** PTY row count to apply before writing data. */
  rows: number;
  /** Raw terminal data to write at the specified dimensions. */
  data: string;
}

export interface GetHistoryResponse {
  sessionId: string;
  /** Ordered resize/data events for terminal recovery. */
  events?: TerminalReplayEvent[];
  data: string;
  /** Current history size in bytes. */
  historySize: number;
  /** PTY column count when history was captured. */
  cols: number;
  /** PTY row count when history was captured. */
  rows: number;
}

export type TerminalEventType = 
  | 'ready'
  | 'output'
  | 'exit'
  | 'error'
  | 'resize'
  | 'title'
  | 'cwd';

export interface TerminalEventBase {
  type: TerminalEventType;
  sessionId: string;
  /** Optional timestamp. */
  timestamp?: number;
}

export interface TerminalReadyEvent extends TerminalEventBase {
  type: 'ready';
}

export interface TerminalOutputEvent extends TerminalEventBase {
  type: 'output';
  data: string;
}

export interface TerminalExitEvent extends TerminalEventBase {
  type: 'exit';
  exitCode?: number;
}

export interface TerminalErrorEvent extends TerminalEventBase {
  type: 'error';
  message: string;
}

export interface TerminalResizeEvent extends TerminalEventBase {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface TerminalTitleEvent extends TerminalEventBase {
  type: 'title';
  title: string;
}

export interface TerminalCwdEvent extends TerminalEventBase {
  type: 'cwd';
  cwd: string;
}

export type TerminalEvent = 
  | TerminalReadyEvent
  | TerminalOutputEvent
  | TerminalExitEvent
  | TerminalErrorEvent
  | TerminalResizeEvent
  | TerminalTitleEvent
  | TerminalCwdEvent;

export type TerminalEventCallback = (event: TerminalEvent) => void;

export type UnsubscribeFunction = () => void;
