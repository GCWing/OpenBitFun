import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { ProjectDefaultsConfig } from '../types';
import { configManager } from './ConfigManager';

export const PROJECT_DEFAULTS_PATH = 'app.project_defaults';
type ProjectDefaults = Record<string, ProjectDefaultsConfig>;

export function parseProjectDefaults(value: unknown): ProjectDefaults | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project defaults');
  for (const defaults of Object.values(value)) {
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)
      || ['primary_model', 'fast_model', 'mode'].some(key => defaults[key] != null && typeof defaults[key] !== 'string')) {
      throw new Error('Invalid project defaults');
    }
  }
  return value as ProjectDefaults;
}

export async function readProjectDefaults(projectId: string) {
  const scope = getActiveSurfaceScope();
  const defaults = parseProjectDefaults(await configAPI.getConfig(PROJECT_DEFAULTS_PATH, { skipRetryOnNotFound: true }));
  scope.assertCurrent('read project defaults');
  return { supported: defaults !== undefined, defaults: defaults?.[projectId] ?? {} };
}

export async function saveProjectDefault(projectId: string, field: 'primary_model' | 'fast_model' | 'mode', value: string) {
  const updated = await configManager.updateConfig<ProjectDefaults>(PROJECT_DEFAULTS_PATH, current => {
    const defaults = parseProjectDefaults(current);
    if (!defaults) throw new Error('Project defaults are unsupported by this host');
    return { ...defaults, [projectId]: { ...defaults[projectId], [field]: value || null } };
  });
  return updated[projectId];
}
