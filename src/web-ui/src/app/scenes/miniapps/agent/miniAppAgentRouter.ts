/**
 * Routes one host request to the right surface runtime.
 *
 * This is the seam between the transport (a native event plus a result command)
 * and the surface capabilities (DOM runtime, bridge client, presentation). It
 * holds no React state and no Tauri calls, so both the hook and a plain test can
 * drive it with explicit dependencies.
 */

import {
  canReadSurfaceDocument,
  clickNode,
  findNodes,
  inspectDocument,
  pressKey,
  readNode,
  scrollSurface,
  typeIntoNode,
  type MiniAppAgentDomSurface,
} from './miniAppAgentDomRuntime';
import { captureSurface } from './miniAppAgentCapture';
import {
  getMiniAppAgentSurface,
  updateMiniAppAgentSurfaceStatus,
  waitForMiniAppAgentSurface,
  type MiniAppAgentSurfaceEntry,
} from './miniAppAgentSurfaceRegistry';
import {
  MINIAPP_AGENT_DEFAULT_CAPTURE_EDGE,
  MINIAPP_AGENT_ELEMENT_POSITION_CLICK,
  MINIAPP_AGENT_MAX_NAME_CHARS,
  MINIAPP_AGENT_MAX_TEXT_CHARS,
  MINIAPP_AGENT_SURFACE_REQUEST_ACTION,
  surfaceError,
  type MiniAppAgentLocator,
  type MiniAppAgentSurfaceInfo,
} from './miniAppAgentProtocol';

/** Default budget for mounting a tab and its frame. */
export const MINIAPP_AGENT_OPEN_TIMEOUT_MS = 60_000;

export interface MiniAppAgentRequestPayload {
  requestId: string;
  expiresAt?: number;
  action: string;
  appId?: string;
  name?: string;
  strictRuntime?: boolean;
  command?: {
    appId: string;
    instanceId?: string;
    method: string;
    params?: Record<string, unknown> | null;
  };
}

export interface MiniAppAgentRouterDeps {
  /**
   * Present the app in a surface this window can read. Must throw a typed
   * surface error when the app is shown somewhere the controller cannot reach.
   */
  presentApp(appId: string): Promise<{ instanceId?: string; presentedFrom?: 'window' | 'tab' }>;
  openTimeoutMs?: number;
  signal?: AbortSignal;
}

function readString(source: Record<string, unknown>, key: string, limit = MINIAPP_AGENT_MAX_NAME_CHARS): string | undefined {
  const value = source[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function requireString(source: Record<string, unknown>, key: string, action: string): string {
  const value = readString(source, key, MINIAPP_AGENT_MAX_TEXT_CHARS);
  if (!value) throw surfaceError('INVALID_PARAMS', `${action} requires '${key}'.`);
  return value;
}

function requireNodeKey(source: Record<string, unknown>, action: string): string {
  const value = requireString(source, 'nodeKey', action);
  return value;
}

function numberParam(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function sanitizeLocator(value: unknown): MiniAppAgentLocator {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const locator: MiniAppAgentLocator = {};
  const testId = readString(source, 'testId');
  if (testId) locator.testId = testId;
  const role = readString(source, 'role', 40);
  if (role) locator.role = role.toLowerCase();
  const name = readString(source, 'name');
  if (name) locator.name = name;
  const text = readString(source, 'text', MINIAPP_AGENT_MAX_TEXT_CHARS);
  if (text) locator.text = text;
  const selector = readString(source, 'selector');
  if (selector) locator.selector = selector;
  if (source.exact === true) locator.exact = true;
  return locator;
}

function parseRequest(raw: unknown): MiniAppAgentRequestPayload {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const requestId = readString(source, 'requestId', 128);
  if (!requestId) {
    throw surfaceError('INVALID_PARAMS', 'The host request is missing its requestId.');
  }
  const action = readString(source, 'action', 32) ?? '';
  const payload: MiniAppAgentRequestPayload = {
    requestId,
    expiresAt: typeof source.expiresAt === 'number' && Number.isFinite(source.expiresAt)
      ? source.expiresAt : undefined,
    action,
    appId: readString(source, 'appId'),
    name: readString(source, 'name'),
    strictRuntime: source.strictRuntime === true,
  };
  const command = source.command as Record<string, unknown> | undefined;
  if (command && typeof command === 'object') {
    const appId = readString(command, 'appId');
    const method = readString(command, 'method', 40);
    if (appId && method) {
      payload.command = {
        appId,
        instanceId: readString(command, 'instanceId', 128),
        method,
        params: (command.params && typeof command.params === 'object'
          ? command.params
          : {}) as Record<string, unknown>,
      };
    }
  }
  return payload;
}

function requireSurface(appId: string, instanceId?: string): MiniAppAgentSurfaceEntry {
  const entry = getMiniAppAgentSurface(appId);
  if (!entry || !entry.ready) {
    throw surfaceError(
      'SURFACE_UNAVAILABLE',
      `The MiniApp '${appId}' is not ready in this window. Wait for it to load or open it again from this surface.`,
    );
  }
  if (instanceId && entry.instanceId && instanceId !== entry.instanceId) {
    throw surfaceError(
      'SURFACE_UNAVAILABLE',
      `The MiniApp '${appId}' is now running as a different instance. Open it again before acting.`,
    );
  }
  return entry;
}

function surfaceSize(entry: MiniAppAgentSurfaceEntry): { width?: number; height?: number } {
  const rect = entry.iframe.getBoundingClientRect?.();
  const width = rect && rect.width > 0 ? Math.round(rect.width) : undefined;
  const height = rect && rect.height > 0 ? Math.round(rect.height) : undefined;
  return { width, height };
}

async function openSurface(
  payload: MiniAppAgentRequestPayload,
  deps: MiniAppAgentRouterDeps,
): Promise<MiniAppAgentSurfaceInfo> {
  const appId = payload.appId;
  if (!appId) {
    throw surfaceError('INVALID_PARAMS', 'open requires appId.');
  }
  const presented = await deps.presentApp(appId);
  const entry = await waitForMiniAppAgentSurface(appId, deps.openTimeoutMs ?? MINIAPP_AGENT_OPEN_TIMEOUT_MS, deps.signal);
  if (payload.expiresAt !== undefined && Date.now() >= payload.expiresAt) {
    throw surfaceError('TIMEOUT', 'The MiniApp surface request expired while opening the surface.');
  }
  if (presented.instanceId) {
    updateMiniAppAgentSurfaceStatus(appId, { instanceId: presented.instanceId });
  }

  // A readable frame is the only reason to promise DOM control. Anything else
  // must be answered honestly instead of guessed from the runtime profile.
  const readable = canReadSurfaceDocument(entry);
  const { width, height } = surfaceSize(entry);
  return {
    appId,
    instanceId: presented.instanceId ?? entry.instanceId,
    strictRuntime: entry.strictRuntime,
    width,
    height,
    capabilities: readable ? ['dom', 'accessibility', 'input', MINIAPP_AGENT_ELEMENT_POSITION_CLICK] : [],
    bridgeCapabilities: entry.bridge.capabilities,
    declaredActions: entry.bridge.actions,
    ...(presented.presentedFrom ? { presentedFrom: presented.presentedFrom } : {}),
  };
}

function domSurface(entry: MiniAppAgentSurfaceEntry): MiniAppAgentDomSurface {
  return { appId: entry.appId, iframe: entry.iframe };
}

async function executeSurface(
  payload: MiniAppAgentRequestPayload,
): Promise<Record<string, unknown>> {
  const command = payload.command;
  if (!command) {
    throw surfaceError('INVALID_PARAMS', 'execute requires a command.');
  }
  if (payload.expiresAt !== undefined && Date.now() >= payload.expiresAt) {
    throw surfaceError('TIMEOUT', 'The MiniApp surface request expired before execution.');
  }
  const entry = requireSurface(command.appId, command.instanceId);
  const params = command.params ?? {};
  const dom = domSurface(entry);

  switch (command.method) {
    case 'inspect':
      return inspectDocument(dom, {
        maxNodes: numberParam(params, 'maxNodes'),
        maxDepth: numberParam(params, 'maxDepth'),
      }) as unknown as Record<string, unknown>;
    case 'find':
      return { matches: findNodes(dom, sanitizeLocator(params.locator)) };
    case 'read':
      return readNode(dom, requireNodeKey(params, 'read'), readString(params, 'attribute', 80)) as unknown as Record<string, unknown>;
    case 'click':
      return clickNode(dom, requireNodeKey(params, 'click'), params.position) as unknown as Record<string, unknown>;
    case 'type':
      if (typeof params.text !== 'string') {
        throw surfaceError('INVALID_PARAMS', "type requires 'text' to be a string.");
      }
      return typeIntoNode(
        dom,
        requireNodeKey(params, 'type'),
        params.text,
        params.clear !== false,
      ) as unknown as Record<string, unknown>;
    case 'key':
      return (await pressKey(dom, requireString(params, 'key', 'key'), {
        modifiers: Array.isArray(params.modifiers)
          ? params.modifiers.filter((modifier): modifier is string => typeof modifier === 'string')
          : [],
        holdMs: numberParam(params, 'holdMs') ?? 0,
      })) as unknown as Record<string, unknown>;
    case 'scroll':
      return scrollSurface(
        dom,
        readString(params, 'nodeKey', 128),
        numberParam(params, 'deltaX') ?? 0,
        numberParam(params, 'deltaY') ?? 0,
      );
    case 'capture':
      return (await captureSurface(
        dom,
        numberParam(params, 'maxEdge') ?? MINIAPP_AGENT_DEFAULT_CAPTURE_EDGE,
      )) as unknown as Record<string, unknown>;
    case 'bridge_observe':
      return entry.bridge.observe(requireString(params, 'requestId', 'bridge_observe'));
    case 'bridge_act':
      return entry.bridge.act(
        requireString(params, 'requestId', 'bridge_act'),
        params.action,
      );
    case 'bridge_watch':
      throw surfaceError(
        'INVALID_PARAMS',
        'bridge_watch is no longer a surface method: sampling is a bounded loop over bridge_observe in the tool.');
    default:
      throw surfaceError('INVALID_PARAMS', `Unsupported MiniApp surface method: ${command.method}`);
  }
}

/** Handle one host request and return the value to report back. */
export async function handleMiniAppAgentRequest(
  raw: unknown,
  deps: MiniAppAgentRouterDeps,
): Promise<Record<string, unknown>> {
  if (deps.signal?.aborted) {
    throw surfaceError('SURFACE_UNAVAILABLE', 'The MiniApp device surface is no longer active.');
  }
  const payload = parseRequest(raw);
  if (payload.expiresAt !== undefined && Date.now() >= payload.expiresAt) {
    throw surfaceError('TIMEOUT', 'The MiniApp surface request expired before handling.');
  }
  switch (payload.action) {
    case MINIAPP_AGENT_SURFACE_REQUEST_ACTION.open:
      return openSurface(payload, deps) as unknown as Record<string, unknown>;
    case MINIAPP_AGENT_SURFACE_REQUEST_ACTION.execute:
      return executeSurface(payload);
    default:
      throw surfaceError('INVALID_PARAMS', `Unsupported MiniApp surface action: ${payload.action || '(empty)'}`);
  }
}
