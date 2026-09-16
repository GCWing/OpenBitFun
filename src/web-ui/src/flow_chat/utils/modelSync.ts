/**
 * Session model-selection synchronization before a local dialog turn.
 *
 * Leaf module: shared by the local session driver and re-exported by
 * MessageModule for existing callers.
 */

import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { AIModelConfig, AgentModelDefaultsConfig, DefaultModelsConfig } from '@/infrastructure/config/types';
import { createLogger } from '@/shared/utils/logger';
import type { FlowChatContext } from '../services/flow-chat-manager/types';
import { getModelMaxTokens, resolveModelReference } from './modelResolution';
import { sessionProjectWorkspacePath } from './sessionWorkspace';
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

  const configData = (await configManager.getConfigs([
    'ai.agent_model_defaults',
    'ai.models',
    'ai.default_models',
  ])) ?? {};
  surfaceScope.assertCurrent('load session model configuration');
  const agentModelDefaults = configData['ai.agent_model_defaults'] as AgentModelDefaultsConfig | undefined;
  const allModels = (configData['ai.models'] as AIModelConfig[] | undefined) || [];
  const defaultModels = (configData['ai.default_models'] as DefaultModelsConfig | undefined) || {};

  const sessionModelId = session.config.modelName?.trim();
  const requestedModelId = sessionModelId || agentModelDefaults?.mode;
  const desiredModelId = normalizeModelSelection(requestedModelId, allModels, defaultModels);
  const desiredMaxContextTokens = await getModelMaxTokens(desiredModelId, agentType);
  surfaceScope.assertCurrent('resolve session model context window');
  const shouldSyncContextWindow = session.maxContextTokens !== desiredMaxContextTokens;

  if (sessionModelId !== desiredModelId) {
    context.flowChatStore.updateSessionModelName(sessionId, desiredModelId);
  }
  if (shouldSyncContextWindow) {
    context.flowChatStore.updateSessionMaxContextTokens(sessionId, desiredMaxContextTokens);
  }
  await agentAPI.updateSessionModel({
    sessionId,
    modelName: desiredModelId,
    reasoningPreset: session.config.reasoningPreset ?? null,
    workspacePath: sessionProjectWorkspacePath(session),
    remoteConnectionId: session.remoteConnectionId,
    remoteSshHost: session.remoteSshHost,
    includeInternal: session.sessionKind === 'subagent',
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
