/**
 * Workspace Git initializer
 * 
 * Responsibilities:
 * - Monitor workspace open/close/switch events
 * - Auto-refresh/cleanup Git state
 * - Keep Git state synced with workspace changes
 */

import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { gitStateManager } from '../state/GitStateManager';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('WorkspaceGitInitializer');

class WorkspaceGitInitializer {
  private static instance: WorkspaceGitInitializer | null = null;
  private removeListener: (() => void) | null = null;
  private currentWorkspaceId: string | null = null;

  private constructor() {}

  static getInstance(): WorkspaceGitInitializer {
    if (!this.instance) {
      this.instance = new WorkspaceGitInitializer();
    }
    return this.instance;
  }

  start(): void {
    if (this.removeListener) {
      return;
    }

    this.removeListener = workspaceManager.addEventListener(async (event) => {
      switch (event.type) {
        case 'workspace:opened':
          await this.handleWorkspaceOpened(event.workspace.id);
          break;

        case 'workspace:closed':
          await this.handleWorkspaceClosed(event.workspaceId);
          break;

        case 'workspace:switched':
          await this.handleWorkspaceSwitched(event.workspace.id);
          break;
      }
    });

    const currentState = workspaceManager.getState();
    if (currentState.currentWorkspace) {
      this.handleWorkspaceOpened(currentState.currentWorkspace.id);
    }
  }

  stop(): void {
    if (this.removeListener) {
      this.removeListener();
      this.removeListener = null;
    }
  }

  private async handleWorkspaceOpened(workspaceId: string): Promise<void> {
    try {
      this.currentWorkspaceId = workspaceId;
      await gitStateManager.refresh({ workspaceId }, {
        layers: ['basic'],
        reason: 'mount',
        force: true,
        source: 'workspace_git_initializer',
      });
    } catch (error) {
      log.error('Failed to initialize Git state', { workspaceId, error });
    }
  }

  private async handleWorkspaceClosed(workspaceId: string): Promise<void> {
    try {
      if (this.currentWorkspaceId) {
        gitStateManager.invalidateCache({ workspaceId: this.currentWorkspaceId }, ['basic', 'status', 'detailed']);
      }
      this.currentWorkspaceId = null;
    } catch (error) {
      log.error('Failed to cleanup Git state', { workspaceId, error });
    }
  }

  private async handleWorkspaceSwitched(workspaceId: string): Promise<void> {
    try {
      if (this.currentWorkspaceId && this.currentWorkspaceId !== workspaceId) {
        gitStateManager.invalidateCache({ workspaceId: this.currentWorkspaceId }, ['basic', 'status', 'detailed']);
      }
      this.currentWorkspaceId = workspaceId;
      await gitStateManager.refresh({ workspaceId }, {
        layers: ['basic'],
        reason: 'mount',
        force: true,
        source: 'workspace_git_initializer',
      });
    } catch (error) {
      log.error('Failed to initialize Git state for switched workspace', { workspaceId, error });
    }
  }
}

export const workspaceGitInitializer = WorkspaceGitInitializer.getInstance();
