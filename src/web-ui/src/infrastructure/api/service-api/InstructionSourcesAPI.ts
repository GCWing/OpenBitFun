import { ExternalSourceApiError, invokeExternalSourceCommand, normalizeOptionalWorkspaceId } from './ExternalSourcesAPI';

export interface InstructionSourceEntry {
  ecosystemId: string;
  name: string;
  path: string;
  scope: 'user' | 'project';
  pathPatterns: string[];
}

export interface InstructionSourceCatalog {
  schemaVersion: 1;
  entries: InstructionSourceEntry[];
  failedEcosystems: string[];
}

export const instructionSourcesAPI = {
  async getCatalog(workspaceId?: string): Promise<InstructionSourceCatalog> {
    const value = await invokeExternalSourceCommand<InstructionSourceCatalog>('get_instruction_source_catalog', {
      request: { workspaceId: normalizeOptionalWorkspaceId(workspaceId) },
    });
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.entries)
      || !Array.isArray(value.failedEcosystems) || !value.failedEcosystems.every((id) => typeof id === 'string')
      || !value.entries.every((entry) => entry && typeof entry.ecosystemId === 'string'
        && typeof entry.name === 'string' && typeof entry.path === 'string'
        && ['user', 'project'].includes(entry.scope) && Array.isArray(entry.pathPatterns)
        && entry.pathPatterns.every((pattern) => typeof pattern === 'string'))) {
      throw new ExternalSourceApiError('invalid_response', 'The host returned an unsupported instruction source catalog', false);
    }
    return value;
  },
};
