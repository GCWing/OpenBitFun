import { modelSelectionsConfigPath, effectiveModelSelections } from '@/infrastructure/config/services/modelSelections';
/**
 * Session model-selection synchronization before a local dialog turn.
 *
 * Leaf module: shared by the local session driver and re-exported by
 * MessageModule for existing callers.
 */

import { modelPoolAPI, supportsModelPools } from '@/infrastructure/api/service-api/ModelPoolAPI';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { AIModelConfig, AgentModelDefaultsConfig, DefaultModelsConfig } from '@/infrastructure/config/types';
import { createLogger } from '@/shared/utils/logger';
import type { FlowChatContext } from '../services/flow-chat-manager/types';
import { resolveModelMaxTokens, resolveModelReference } from './modelResolution';
import { sessionProjectWorkspacePath, sessionWorkspaceId } from './sessionWorkspace';
import { shouldIncludeInternalModelSession } from './modelSelectionTarget';
import {
  getActiveSurfaceScope,
  type SurfaceScope,
} from '@/infrastructure/peer-device/deviceSurface';

const log = createLogger('ModelSync');

function normalizeModelSelection(
  modelId: string | undefined,
  models: AIModelConfig[],
  defaultModels: DefaultModelsConfig,
): string {
  const value = modelId?.trim();
  if (!value || value === 'primary') return 'primary';

  if (value === 'fast') {
    const matchedModel = models.find(
      model => model.enabled !== false && model.id === defaultModels.fast,
    );
    return matchedModel ? value : 'primary';
  }

  const matchedModel = resolveModelReference(models, value);
  if (!matchedModel?.id) {
    throw new Error(`Unknown, disabled, or ambiguous model configuration ID: ${value}`);
  }
  return matchedModel.id;
}

export async function syncSessionModelSelection(
  context: FlowChatContext,
  sessionId: string,
  agentType: string,
  surfaceScope: SurfaceScope = getActiveSurfaceScope(),
): Promise<void> {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session does not exist: ${sessionId}`);
  }

  let authoritativeModel: string | undefined;
  if (supportsModelPools()) {
    const targetScope = { sessionId, workspaceId: sessionWorkspaceId(session),
      workspacePath: sessionProjectWorkspacePath(session), remoteConnectionId: session.remoteConnectionId,
      remoteSshHost: session.remoteSshHost, includeInternal: shouldIncludeInternalModelSession(session) };
    const target = session.config.modelPoolSelectionPending && session.config.modelPoolId
      ? await modelPoolAPI.select(targetScope, { kind: 'pool', pool_id: session.config.modelPoolId })
      : await modelPoolAPI.target(targetScope);
    surfaceScope.assertCurrent('synchronize model pool selection');
    if (target.selection.kind === 'pool') {
      context.flowChatStore.updateSessionModelPool(sessionId, target.selection.pool_id, target.binding);
      return;
    }
    if (session.config.modelPoolId) authoritativeModel = target.selection.model_ref;
    if (session.config.modelPoolId || session.config.modelPoolSelectionPending) context.flowChatStore.updateSessionModelPool(sessionId, undefined);
  } else if (session.config.modelPoolId) {
    throw new Error('This host does not support model_pool_selection_v1');
  }

  const sessionModelId = authoritativeModel ?? session.config.modelName?.trim();
  const configData = (await configManager.getConfigs([
    ...(!sessionModelId ? [modelSelectionsConfigPath()] : []),
    'ai.models',
    'ai.default_models',
  ])) ?? {};
  surfaceScope.assertCurrent('load session model configuration');
  const agentModelDefaults = configData[modelSelectionsConfigPath()] as AgentModelDefaultsConfig | undefined;
  const allModels = (configData['ai.models'] as AIModelConfig[] | undefined) || [];
  const defaultModels = (configData['ai.default_models'] as DefaultModelsConfig | undefined) || {};

  const defaultSelection = !sessionModelId ? effectiveModelSelections(agentModelDefaults).mode : undefined;
  if (!sessionModelId && defaultSelection?.kind === 'pool') throw new Error('A model pool must be selected through the host session target');
  const requestedModelId = sessionModelId || (defaultSelection?.kind === 'model' ? defaultSelection.model_ref : undefined);
  const desiredModelId = normalizeModelSelection(requestedModelId, allModels, defaultModels);
  const desiredMaxContextTokens = resolveModelMaxTokens(desiredModelId, allModels, defaultModels);
  surfaceScope.assertCurrent('resolve session model context window');
  const shouldSyncContextWindow = session.maxContextTokens !== desiredMaxContextTokens;

  if (session.config.modelName?.trim() !== desiredModelId) {
    context.flowChatStore.updateSessionModelName(sessionId, desiredModelId);
  }
  if (shouldSyncContextWindow) {
    context.flowChatStore.updateSessionMaxContextTokens(sessionId, desiredMaxContextTokens);
  }
  await agentAPI.updateSessionModel({
    sessionId,
    modelName: desiredModelId,
    reasoningPreset: session.config.reasoningPreset ?? null,
    workspaceId: sessionWorkspaceId(session),
    workspacePath: sessionProjectWorkspacePath(session),
    remoteConnectionId: session.remoteConnectionId,
    remoteSshHost: session.remoteSshHost,
    includeInternal: shouldIncludeInternalModelSession(session),
  });
  surfaceScope.assertCurrent('synchronize session model');

  log.info('Session model synchronized before send', {
    sessionId,
    agentType,
    previousModelId: sessionModelId ?? null,
    nextModelId: desiredModelId,
    fallbackApplied: Boolean(requestedModelId?.trim() && requestedModelId.trim() !== desiredModelId),
  });
}
