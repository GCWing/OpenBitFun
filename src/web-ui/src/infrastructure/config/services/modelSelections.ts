import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { AgentModelDefaultsConfig, AgentModelSelections, AgentModelTargetSelection, ModelTargetSelection, SubagentModelSelection } from '../types';
import { configManager } from './ConfigManager';
import { supportsModelPools } from '@/infrastructure/api/service-api/ModelPoolAPI';

function isSelection(value: unknown, allowInherit: boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  const choice = value as Record<string, unknown>;
  return (allowInherit && choice.kind === 'inherit')
    || (choice.kind === 'model' && typeof choice.model_ref === 'string' && Boolean(choice.model_ref.trim()))
    || (choice.kind === 'pool' && typeof choice.pool_id === 'string' && Boolean(choice.pool_id.trim()));
}

export function effectiveModelSelections(config?: AgentModelDefaultsConfig | AgentModelSelections | null, path = modelSelectionsConfigPath()): AgentModelSelections {
  if (path === 'ai.agent_model_selections') {
    const value = config as AgentModelSelections;
    if (!value || !isSelection(value.mode, false) || !value.subagents
      || !isSelection(value.subagents.default, true) || !isSelection(value.subagents.fork, true)
      || !value.subagents.builtin || typeof value.subagents.builtin !== 'object' || Array.isArray(value.subagents.builtin)
      || !Object.values(value.subagents.builtin).every(choice => isSelection(choice, true))) {
      throw new Error('Invalid ai.agent_model_selections');
    }
    return value;
  }
  const defaults = config as AgentModelDefaultsConfig | undefined;
  const convert = (selection: SubagentModelSelection): AgentModelTargetSelection => selection.kind === 'inherit'
    ? { kind: 'inherit' } : { kind: 'model', model_ref: selection.model_id };
  return {
    mode: { kind: 'model', model_ref: defaults?.mode?.trim() || 'primary' },
    subagents: {
      default: convert(defaults?.subagents?.default ?? { kind: 'fixed', model_id: 'fast' }),
      builtin: Object.fromEntries(Object.entries(defaults?.subagents?.builtin ?? {}).map(([id, choice]) => [id, convert(choice)])),
      fork: convert(defaults?.subagents?.fork ?? { kind: 'inherit' }),
    },
  };
}

export function modelSelectionsConfigPath(): 'ai.agent_model_selections' | 'ai.agent_model_defaults' {
  return getActiveSurfaceScope().surfaceId === 'local' || supportsModelPools()
    ? 'ai.agent_model_selections' : 'ai.agent_model_defaults';
}

export async function readModelSelections(): Promise<AgentModelSelections> {
  // Strict read, including waiting for queued related writes. Read failures must
  // not replace a remembered pool with a synthesized single-model default.
  const scope = getActiveSurfaceScope();
  const path = modelSelectionsConfigPath();
  const defaults = await configManager.getOptionalConfig<AgentModelDefaultsConfig | AgentModelSelections>(path);
  scope.assertCurrent('read model selections');
  if (!defaults) throw new Error('Agent model defaults are unavailable');
  return effectiveModelSelections(defaults, path);
}

export function rememberModeSelection(selection: ModelTargetSelection): Promise<void> {
  if (selection.kind === 'pool' && !supportsModelPools()) return Promise.reject(new Error('This host does not support model_pool_selection_v1'));
  if (modelSelectionsConfigPath() === 'ai.agent_model_defaults') {
    if (selection.kind === 'pool') return Promise.reject(new Error('This host does not support model_pool_selection_v1'));
    return configManager.setConfig('ai.agent_model_defaults.mode', selection.model_ref);
  }
  return configManager.setConfig('ai.agent_model_selections.mode', selection);
}
