/**
 * Optional MiniApp agent bridge client.
 *
 * A MiniApp that wants to expose bounded JSON state (Canvas apps, games, custom
 * renderers) announces `openbitfun:miniapp-agent-ready` from its frame and
 * answers `openbitfun:miniapp-agent-request` messages. The host never inspects
 * a MiniApp's internals on its own: capability and payload shape are the app's
 * declaration, and the host only pairs requests by `requestId` with a timeout.
 */

import {
  MINIAPP_AGENT_BRIDGE_READY_TYPE,
  MINIAPP_AGENT_BRIDGE_REQUEST_TYPE,
  MINIAPP_AGENT_BRIDGE_RESPONSE_TYPE,
  MINIAPP_AGENT_BRIDGE_TIMEOUT_MS,
  MINIAPP_AGENT_MAX_ACTION_NAME_CHARS,
  MINIAPP_AGENT_MAX_BRIDGE_ACTIONS,
  MINIAPP_AGENT_MAX_BRIDGE_CAPABILITIES,
  MINIAPP_AGENT_SCHEMA_VERSION,
  surfaceError,
  assertMiniAppAgentBridgePayload,
  type MiniAppAgentBridgeAnnouncement,
  type MiniAppAgentBridgeResponse,
} from './miniAppAgentProtocol';

export interface MiniAppAgentBridgeSurface {
  appId: string;
  iframe: HTMLIFrameElement;
}

export type MiniAppAgentBridgeMethod = 'observe' | 'act';

interface PendingRequest {
  resolve: (response: MiniAppAgentBridgeResponse) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function normalizeCapabilities(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const capability = value.trim().toLowerCase();
    if (!capability || capability.length > 32) continue;
    if (!/^[\x20-\x7e]+$/.test(capability)) continue;
    if (normalized.includes(capability)) continue;
    normalized.push(capability);
    if (normalized.length >= MINIAPP_AGENT_MAX_BRIDGE_CAPABILITIES) break;
  }
  return normalized;
}

/**
 * Declared action names stay case-sensitive: the app decides what they mean, so
 * normalizing case here would invent a name the app does not answer.
 */
function normalizeActions(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const normalized: string[] = [];
  for (const value of values) {
    const raw = typeof value === 'string'
      ? value
      : (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
        ? (value as { type: string }).type
        : '');
    const action = raw.trim();
    if (!action || action.length > MINIAPP_AGENT_MAX_ACTION_NAME_CHARS) continue;
    if (!/^[\x20-\x7e]+$/.test(action)) continue;
    if (normalized.includes(action)) continue;
    normalized.push(action);
    if (normalized.length >= MINIAPP_AGENT_MAX_BRIDGE_ACTIONS) break;
  }
  return normalized;
}

export class MiniAppAgentBridge {
  private announcement: MiniAppAgentBridgeAnnouncement | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private listening = false;
  private readonly handler = (event: MessageEvent) => this.onMessage(event);

  constructor(private readonly surface: MiniAppAgentBridgeSurface) {}

  start(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('message', this.handler);
  }

  stop(): void {
    if (this.listening) {
      window.removeEventListener('message', this.handler);
      this.listening = false;
    }
    this.rejectPending(surfaceError('SURFACE_UNAVAILABLE', 'The MiniApp surface detached.'));
  }

  get announced(): boolean {
    return this.announcement !== null;
  }

  get capabilities(): string[] {
    return this.announcement ? [...this.announcement.capabilities] : [];
  }

  /**
   * Action types the app declared for `act`. Empty means it declared nothing,
   * so the names are unknown rather than nonexistent.
   */
  get actions(): string[] {
    return this.announcement ? [...this.announcement.actions] : [];
  }

  async observe(requestId: string, timeoutMs = MINIAPP_AGENT_BRIDGE_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const value = await this.request(requestId, 'observe', undefined, timeoutMs);
    // The injected runtime answers with one envelope: the app's own declaration
    // under `state` and its automatic observation under `auto`.
    const envelope = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    return {
      state: envelope.state ?? null,
      auto: envelope.auto ?? null,
      capabilities: this.capabilities,
      actions: this.actions,
    };
  }

  async act(
    requestId: string,
    action: unknown,
    timeoutMs = MINIAPP_AGENT_BRIDGE_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const value = await this.request(requestId, 'act', action, timeoutMs);
    return { result: value ?? null, capabilities: this.capabilities, actions: this.actions };
  }

  private async request(
    requestId: string,
    method: MiniAppAgentBridgeMethod,
    action: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!requestId.trim()) {
      throw surfaceError('INVALID_PARAMS', 'The bridge request is missing its requestId.');
    }
    if (!this.announced) {
      throw surfaceError(
        'BRIDGE_UNAVAILABLE',
        "This MiniApp did not announce an agent bridge, so its internal state is not observable. DOM actions require a readable frame instead.",
      );
    }
    // `auto-observe` ships with the injected runtime, so observation works for an
    // app that declares nothing; only `act` needs an explicit declaration.
    const declared = this.capabilities.includes(method)
      || (method === 'observe' && this.capabilities.includes('auto-observe'));
    if (!declared) {
      throw surfaceError(
        'BRIDGE_UNAVAILABLE',
        `This MiniApp does not declare the '${method}' agent bridge capability.`,
      );
    }
    const target = this.surface.iframe.contentWindow;
    if (!target) {
      throw surfaceError('SURFACE_UNAVAILABLE', 'The MiniApp frame is not mounted.');
    }
    const payload: Record<string, unknown> = {
      type: MINIAPP_AGENT_BRIDGE_REQUEST_TYPE,
      schemaVersion: MINIAPP_AGENT_SCHEMA_VERSION,
      requestId,
      method,
    };
    if (method === 'act') payload.action = action;
    assertMiniAppAgentBridgePayload(payload);

    const response = await new Promise<MiniAppAgentBridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(surfaceError(
          'BRIDGE_TIMEOUT',
          `The MiniApp did not answer the '${method}' bridge request in ${timeoutMs}ms.`,
        ));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        target.postMessage(payload, '*');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(surfaceError('HOST_ERROR', `Failed to deliver the bridge request: ${String(error)}`));
      }
    });

    if (!response.ok) {
      throw surfaceError(
        'BRIDGE_REJECTED',
        response.error?.trim() || 'The MiniApp rejected the bridge action.',
      );
    }
    return response.value;
  }

  private onMessage(event: MessageEvent): void {
    // Opaque-origin frames cannot be verified by origin, so the frame's own
    // window is the identity check.
    if (event.source !== this.surface.iframe.contentWindow) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return;
    if (data.type === MINIAPP_AGENT_BRIDGE_READY_TYPE) {
      this.acceptAnnouncement(data);
      return;
    }
    if (data.type === MINIAPP_AGENT_BRIDGE_RESPONSE_TYPE) {
      this.acceptResponse(data);
    }
  }

  private acceptAnnouncement(data: Record<string, unknown>): void {
    const appId = typeof data.appId === 'string' ? data.appId.trim() : '';
    // A frame may only speak for the app it is hosting.
    if (!appId || appId !== this.surface.appId) return;
    const schemaVersion = typeof data.schemaVersion === 'string' ? data.schemaVersion.trim() : '';
    if (schemaVersion !== MINIAPP_AGENT_SCHEMA_VERSION) {
      // Keep `announced` false: an unknown schema is not a usable bridge.
      this.announcement = null;
      return;
    }
    this.announcement = {
      appId,
      schemaVersion,
      capabilities: normalizeCapabilities(data.capabilities),
      actions: normalizeActions(data.actions),
    };
  }

  private acceptResponse(data: Record<string, unknown>): void {
    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    try {
      assertMiniAppAgentBridgePayload(data, 'BRIDGE_REJECTED');
    } catch (error) {
      pending.reject(error);
      return;
    }
    pending.resolve({
      requestId,
      ok: data.ok === true,
      value: data.value,
      error: typeof data.error === 'string' ? data.error : undefined,
    });
  }

  private rejectPending(error: unknown): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }
}
