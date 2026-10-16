import { invokeExternalSourceCommand } from './ExternalSourcesAPI';

export type ExternalSessionEcosystem = 'codex' | 'zcode';
export interface RemovedExternalSession {
  ecosystemId: ExternalSessionEcosystem;
  sessionId: string;
  sessionName: string;
  workspaceId: string;
  workspaceName: string;
}
export const externalSessionImportAPI = {
  async listRemoved(ecosystemId: ExternalSessionEcosystem): Promise<RemovedExternalSession[]> {
    const entries = await invokeExternalSourceCommand<unknown>('list_removed_external_sessions', {
      request: { ecosystemId },
    });
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== 'object'
      || entry.ecosystemId !== ecosystemId
      || !['sessionId', 'sessionName', 'workspaceId', 'workspaceName'].every(key => typeof entry[key] === 'string')
      || !entry.sessionId || !entry.workspaceId)) {
      throw new Error('Invalid removed source session response');
    }
    return entries as RemovedExternalSession[];
  },

  restoreRemoved(sessionId: string, targetWorkspaceId: string, ecosystemId: ExternalSessionEcosystem): Promise<void> {
    return invokeExternalSourceCommand('restore_removed_external_session', {
      request: { sessionId, targetWorkspaceId, ecosystemId },
    });
  },
};
