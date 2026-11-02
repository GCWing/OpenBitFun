import { api } from '@/infrastructure/api/service-api/ApiClient';
import { appearanceService } from '@/infrastructure/appearance';
import { configManager } from '@/infrastructure/config';
import { i18nService, type LocaleId } from '@/infrastructure/i18n';
import { notifyMcpConfigChanged } from '@/infrastructure/mcp/configEvents';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { listenForCreationRequests } from '@/infrastructure/creation/creationBridge';
import { activateInteractiveCapability } from './interactiveCapabilityActivator';
import { activateProductAction } from './productActionActivator';
import { getInteractiveCapability, getInteractiveControlDefinition } from './interactiveCapabilityCatalog';

const log = createLogger('OpenBitFunControlBridge');
const REQUEST_EVENT = 'agentic://openbitfun-control-request';
const APPLIED_EVENT = 'agentic://openbitfun-control-applied';
const EFFECT_EVENT = 'agentic://openbitfun-control-effect';

type OpenBitFunControlAction = 'list' | 'search' | 'get' | 'open' | 'execute' | 'configure';

export interface OpenBitFunControlRequest {
  requestId: string;
  action: OpenBitFunControlAction;
  capabilityId?: string;
  itemId?: string;
  operationId?: string;
}

interface OpenBitFunControlResponse {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface OpenBitFunControlAppliedEvent {
  capabilityId: string;
  operationId?: string;
  optionId?: string;
  changedPaths: string[];
  value?: unknown;
}

export interface OpenBitFunControlEffectEvent extends OpenBitFunControlAppliedEvent {
  requestId: string;
  phase: 'commit' | 'rollback';
}

let requestUnlisten: (() => void) | null = null;
let appliedUnlisten: (() => void) | null = null;
let effectUnlisten: (() => void) | null = null;
let creationUnlisten: (() => void) | null = null;
let detachListenerInstalled = false;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'OpenBitFunControl presentation request failed';
}

/**
 * The Web UI owns presentation only. Discovery, validation, state reads and
 * mutations stay in the native ProductControl executor shared with the Agent.
 */
export async function executeOpenBitFunPresentationRequest(
  request: OpenBitFunControlRequest,
): Promise<unknown> {
  if (!request.capabilityId) throw new Error('capabilityId is required');
  if (request.action === 'open') {
    await activateInteractiveCapability(request.capabilityId, { itemId: request.itemId });
    return {
      capabilityId: request.capabilityId,
      itemId: request.itemId,
      opened: true,
      surface: 'desktop',
    };
  }
  if (request.action === 'execute') {
    const capability = getInteractiveCapability(request.capabilityId);
    if (!capability) throw new Error(`Unknown OpenBitFun capability: ${request.capabilityId}`);
    const operation = capability.operations.find(({ id }) => id === request.operationId);
    if (!operation) {
      throw new Error(`Unknown operation for ${capability.id}: ${request.operationId ?? ''}`);
    }
    const definition = getInteractiveControlDefinition(
      `${capability.id}:operation:${operation.id}`,
    );
    if (!definition || definition.presentationTarget.kind !== 'action') {
      throw new Error(
        `Operation ${capability.id}:${operation.id} is not a presentation action`,
      );
    }
    await activateProductAction(definition.presentationTarget.actionId);
    return { capabilityId: capability.id, operationId: operation.id, executed: true };
  }
  throw new Error(
    `The Web UI presentation adapter cannot execute ${request.action}; use the native ProductControl executor`,
  );
}

async function reportResponse(response: OpenBitFunControlResponse): Promise<void> {
  await api.invoke('report_openbitfun_control_result', { request: response });
}

async function handleRequest(request: OpenBitFunControlRequest): Promise<void> {
  try {
    const result = await executeOpenBitFunPresentationRequest(request);
    await reportResponse({ requestId: request.requestId, success: true, result });
  } catch (error) {
    try {
      await reportResponse({
        requestId: request.requestId,
        success: false,
        error: errorMessage(error),
      });
    } catch (reportError) {
      log.warn('Failed to report OpenBitFunControl presentation result', {
        requestId: request.requestId,
        error: reportError,
      });
    }
  }
}

function appearanceAlreadyApplied(event: OpenBitFunControlAppliedEvent): boolean {
  if (!event.changedPaths.includes('appearance.selection') || typeof event.value !== 'string') {
    return false;
  }
  return appearanceService.getSnapshot().selectedAppearanceId === event.value
    || appearanceService.hasAppliedPendingSelection(event.value);
}

function languageAlreadyApplied(event: OpenBitFunControlAppliedEvent): boolean {
  return event.changedPaths.includes('app.language')
    && typeof event.value === 'string'
    && i18nService.getCurrentLocale() === event.value;
}

/** Apply a persisted native transaction to the live presentation runtime. */
export async function applyOpenBitFunControlEffect(
  event: OpenBitFunControlAppliedEvent,
): Promise<{ status: 'applied' | 'alreadyApplied' }> {
  const appearanceReady = appearanceAlreadyApplied(event);
  const languageReady = languageAlreadyApplied(event);
  if (appearanceReady || languageReady) {
    return { status: 'alreadyApplied' };
  }

  await configManager.applyExternalReload();
  if (event.changedPaths.includes('appearance.selection')) {
    await appearanceService.reconcilePersistedState();
  }
  if (event.changedPaths.includes('app.language')) {
    if (typeof event.value !== 'string') {
      throw new Error('Persisted language effect did not carry a locale ID');
    }
    await i18nService.applyPersistedLanguage(event.value as LocaleId);
  }
  return { status: 'applied' };
}

async function handleEffect(event: OpenBitFunControlEffectEvent): Promise<void> {
  try {
    const result = await applyOpenBitFunControlEffect(event);
    await reportResponse({ requestId: event.requestId, success: true, result });
  } catch (error) {
    await reportResponse({
      requestId: event.requestId,
      success: false,
      error: errorMessage(error),
    }).catch(reportError => {
      log.warn('Failed to report OpenBitFunControl runtime effect', {
        requestId: event.requestId,
        phase: event.phase,
        error: reportError,
      });
    });
  }
}

async function handleAppliedEvent(event: OpenBitFunControlAppliedEvent): Promise<void> {
  const scope = getActiveSurfaceScope();
  try {
    await configManager.applyExternalReload();
    if (event.capabilityId === 'setting.tools.mcp' && event.changedPaths.includes('mcp_servers')) {
      notifyMcpConfigChanged(scope);
    }
  } catch (error) {
    if (isSurfaceChangedError(error)) return;
    log.warn('Failed to reload a non-transactional ProductControl projection', {
      capabilityId: event.capabilityId,
      operationId: event.operationId,
      optionId: event.optionId,
      error,
    });
  }
}

function markSurfaceDetached(): void {
  void api.invoke('mark_openbitfun_control_surface_unready').catch(error => {
    log.debug('ProductControl surface was already detached', { error });
  });
}

export async function initializeOpenBitFunControlBridge(): Promise<void> {
  if (requestUnlisten) return;
  creationUnlisten = listenForCreationRequests();
  requestUnlisten = api.listen<OpenBitFunControlRequest>(REQUEST_EVENT, request => {
    void handleRequest(request);
  });
  appliedUnlisten = api.listen<OpenBitFunControlAppliedEvent>(APPLIED_EVENT, event => {
    void handleAppliedEvent(event);
  });
  effectUnlisten = api.listen<OpenBitFunControlEffectEvent>(EFFECT_EVENT, event => {
    void handleEffect(event);
  });
  if (!detachListenerInstalled && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', markSurfaceDetached);
    detachListenerInstalled = true;
  }
  try {
    await api.invoke('mark_openbitfun_control_surface_ready', { request: { creationApiVersion: 1 } });
  } catch (error) {
    creationUnlisten?.();
    creationUnlisten = null;
    requestUnlisten();
    requestUnlisten = null;
    appliedUnlisten?.();
    appliedUnlisten = null;
    effectUnlisten?.();
    effectUnlisten = null;
    throw error;
  }
}
