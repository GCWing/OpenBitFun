/**
 * Wire contract for driving a MiniApp surface from the Agent.
 *
 * Mirrors `openbitfun_product_domains::miniapp::web_surface`. The Rust side owns
 * the authoritative limits and error taxonomy; this module only re-declares the
 * subset the Web UI must honor, so the surface runtime cannot drift silently.
 *
 * Errors cross the transport as `"<CODE>: <message>"` strings; the host port
 * classifies them by that prefix instead of parsing prose.
 */

export const MINIAPP_AGENT_SCHEMA_VERSION = 'agent.v1';
/** Opt-in extension: older hosts must never silently treat a positioned click as a plain click. */
export const MINIAPP_AGENT_ELEMENT_POSITION_CLICK = 'element-position-click-v1';

export const MINIAPP_AGENT_MAX_NODES = 320;
export const MINIAPP_AGENT_MAX_DEPTH = 12;
export const MINIAPP_AGENT_MAX_NAME_CHARS = 120;
export const MINIAPP_AGENT_MAX_TEXT_CHARS = 400;
export const MINIAPP_AGENT_MAX_BRIDGE_BYTES = 32 * 1024;
export const MINIAPP_AGENT_MAX_BRIDGE_CAPABILITIES = 8;
/** Declared action names are advisory: bounded so a verbose app cannot flood the turn. */
export const MINIAPP_AGENT_MAX_BRIDGE_ACTIONS = 32;
export const MINIAPP_AGENT_MAX_ACTION_NAME_CHARS = 48;
export const MINIAPP_AGENT_BRIDGE_TIMEOUT_MS = 5_000;
export const MINIAPP_AGENT_MAX_MATCHES = 20;
export const MINIAPP_AGENT_MAX_CAPTURE_EDGE = 1024;
export const MINIAPP_AGENT_DEFAULT_CAPTURE_EDGE = 900;
export const MINIAPP_AGENT_MAX_CAPTURE_BYTES = 1_500_000;
export const MINIAPP_AGENT_MAX_KEY_HOLD_MS = 2_000;
/** Sampling window bounds for `watch`: one call replaces a per-turn observe loop. */
export const MINIAPP_AGENT_MAX_WATCH_MS = 120_000;
export const MINIAPP_AGENT_MIN_WATCH_POLL_MS = 250;
export const MINIAPP_AGENT_DEFAULT_WATCH_MS = 20_000;
export const MINIAPP_AGENT_DEFAULT_WATCH_POLL_MS = 1_000;
export const MINIAPP_AGENT_MAX_WATCH_SAMPLES = 120;
/** Total serialized budget for one watch timeline; sampling stops before it overflows. */
export const MINIAPP_AGENT_MAX_WATCH_SAMPLE_BUDGET = 24 * 1024;

export const MINIAPP_AGENT_BRIDGE_READY_TYPE = 'openbitfun:miniapp-agent-ready';
export const MINIAPP_AGENT_BRIDGE_REQUEST_TYPE = 'openbitfun:miniapp-agent-request';
export const MINIAPP_AGENT_BRIDGE_RESPONSE_TYPE = 'openbitfun:miniapp-agent-response';

export const MINIAPP_AGENT_SURFACE_REQUEST_ACTION = {
  open: 'open',
  execute: 'execute',
} as const;

export type MiniAppAgentErrorCode =
  | 'INVALID_PARAMS'
  | 'UNKNOWN_APP'
  | 'UNKNOWN_SESSION'
  | 'UNKNOWN_TARGET'
  | 'STALE_TARGET'
  | 'SURFACE_UNAVAILABLE'
  | 'CAPABILITY_MISSING'
  | 'BRIDGE_UNAVAILABLE'
  | 'BRIDGE_TIMEOUT'
  | 'BRIDGE_REJECTED'
  | 'TIMEOUT'
  | 'HOST_ERROR';

/** A typed surface failure. `message` already carries the `CODE: ` prefix. */
export class MiniAppAgentSurfaceError extends Error {
  readonly code: MiniAppAgentErrorCode;

  constructor(code: MiniAppAgentErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MiniAppAgentSurfaceError';
    this.code = code;
  }
}

export function surfaceError(code: MiniAppAgentErrorCode, message: string): MiniAppAgentSurfaceError {
  return new MiniAppAgentSurfaceError(code, message);
}

/** Requests and responses share the same serialized UTF-8 byte contract. */
export function assertMiniAppAgentBridgePayload(
  payload: unknown,
  code: MiniAppAgentErrorCode = 'INVALID_PARAMS',
): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw surfaceError(code, 'The bridge payload must be JSON-serializable.');
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MINIAPP_AGENT_MAX_BRIDGE_BYTES) {
    throw surfaceError(code, 'The bridge payload exceeds the 32 KiB limit.');
  }
}

/** Locator axes in resolution priority order. */
export const MINIAPP_AGENT_LOCATOR_PRIORITY = ['testId', 'roleName', 'text', 'selector'] as const;

export interface MiniAppAgentLocator {
  testId?: string;
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  exact?: boolean;
}

/** One observed node. `nodeKey` is host-internal and never reaches the model. */
export interface MiniAppAgentNode {
  nodeKey?: string;
  role?: string;
  name?: string;
  tag?: string;
  testId?: string;
  value?: string;
  text?: string;
  enabled?: boolean;
  checked?: boolean;
  children?: MiniAppAgentNode[];
}

export interface MiniAppAgentSurfaceInfo {
  appId: string;
  instanceId?: string;
  strictRuntime: boolean;
  width?: number;
  height?: number;
  capabilities: string[];
  bridgeCapabilities: string[];
  /** Action types declared by the MiniApp's optional agent bridge. */
  declaredActions: string[];
  /**
   * Where the app was presented before this request, when the surface had to
   * move it. `window` means the app was open in its own window and was
   * transferred into the tab the user is watching.
   */
  presentedFrom?: 'window' | 'tab';
}

export interface MiniAppAgentBridgeAnnouncement {
  appId: string;
  schemaVersion: string;
  capabilities: string[];
  /** Action types the app's `act` handler answers, when it chose to declare them. */
  actions: string[];
}

export interface MiniAppAgentBridgeResponse {
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export function isMiniAppAgentError(error: unknown): error is MiniAppAgentSurfaceError {
  return error instanceof MiniAppAgentSurfaceError;
}

/** Normalize an arbitrary thrown value into the transport's error string. */
export function miniAppAgentErrorMessage(error: unknown): string {
  if (isMiniAppAgentError(error)) return error.message;
  if (error instanceof Error) {
    return error.message?.trim() ? error.message : 'HOST_ERROR: MiniApp surface action failed';
  }
  const text = typeof error === 'string' ? error.trim() : '';
  return text || 'HOST_ERROR: MiniApp surface action failed';
}

/** Unique across Web UI reloads; getRandomValues also works on HTTP web surfaces. */
export function createMiniAppDocumentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
