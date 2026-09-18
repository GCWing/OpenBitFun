import type { GitWorkspaceScope } from '@/infrastructure/api/service-api/GitAPI';
/**
 * Git diff service
 * Uses unified DiffService for diff computation
 */

import { gitAPI } from '@/infrastructure/api';
import { diffService } from '@/tools/editor/services';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('gitDiffService');

export interface DiffStats {
  additions: number;
  deletions: number;
  oldSize: number;
  newSize: number;
  changes: number;
}

export async function calculateDiffStats(originalContent: string, modifiedContent: string): Promise<DiffStats> {
  try {
    const result = await diffService.computeDiff(originalContent, modifiedContent);
    const stats = result.stats;
    
    return {
      additions: stats.additions,
      deletions: stats.deletions,
      oldSize: new Blob([originalContent]).size,
      newSize: new Blob([modifiedContent]).size,
      changes: stats.totalChanges
    };
  } catch (error) {
    log.warn('DiffService calculation failed, using fallback', { error });
    return calculateDiffStatsFallback(originalContent, modifiedContent);
  }
}

export function calculateDiffStatsFallback(originalContent: string, modifiedContent: string): DiffStats {
  const originalLines = originalContent.split('\n');
  const modifiedLines = modifiedContent.split('\n');
  
  let additions = 0;
  let deletions = 0;
  
  const maxLength = Math.max(originalLines.length, modifiedLines.length);
  
  for (let i = 0; i < maxLength; i++) {
    const oldLine = originalLines[i];
    const newLine = modifiedLines[i];
    
    if (oldLine === undefined) {
      additions++;
    } else if (newLine === undefined) {
      deletions++;
    } else if (oldLine !== newLine) {
      deletions++;
      additions++;
    }
  }
  
  return {
    additions,
    deletions,
    oldSize: new Blob([originalContent]).size,
    newSize: new Blob([modifiedContent]).size,
    changes: additions + deletions
  };
}

export async function stageFile(repositoryPath: GitWorkspaceScope, filePath: string): Promise<void> {
  try {
    await gitAPI.addFiles(repositoryPath, {
      files: [filePath],
      all: false
    });
  } catch (error) {
    log.error('Failed to stage file', { repositoryPath, filePath, error });
    throw new Error(`Failed to stage file: ${error}`);
  }
}

export async function discardFileChanges(repositoryPath: GitWorkspaceScope, filePath: string): Promise<void> {
  try {
    await gitAPI.resetFiles(repositoryPath, [filePath], false);
  } catch (error) {
    log.error('Failed to discard file changes', { repositoryPath, filePath, error });
    throw new Error(`Failed to discard file changes: ${error}`);
  }
}

export async function getFileDiffStats(
  repositoryPath: GitWorkspaceScope,
  filePath: string
): Promise<DiffStats | null> {
  try {
    const diffOutput = await gitAPI.getDiff(repositoryPath, {
      filePath: filePath,
      staged: false
    });
    
    const match = diffOutput.match(/(\d+)\s+insertion.*?(\d+)\s+deletion/i);
    
    if (match) {
      return {
        additions: parseInt(match[1]) || 0,
        deletions: parseInt(match[2]) || 0,
        oldSize: 0,
        newSize: 0,
        changes: (parseInt(match[1]) || 0) + (parseInt(match[2]) || 0)
      };
    }
    
    return null;
  } catch (error) {
    log.error('Failed to get diff stats', { repositoryPath, filePath, error });
    return null;
  }
}

export class GitDiffService {
  static async getHeadContent(repositoryPath: GitWorkspaceScope, filePath: string): Promise<string> {
    try {
      return await gitAPI.getFileContent(repositoryPath, filePath, 'HEAD');
    } catch (error) {
      log.debug('Failed to get HEAD content, file might be new', { repositoryPath, filePath, error });
      return '';
    }
  }

  /**
   * Accept all changes and stage the file.
   */
  static async acceptAllChanges(repositoryPath: GitWorkspaceScope, filePath: string): Promise<void> {
    await stageFile(repositoryPath, filePath);
  }

  /**
   * Reject all changes and discard the file.
   */
  static async rejectAllChanges(repositoryPath: GitWorkspaceScope, filePath: string): Promise<void> {
    await discardFileChanges(repositoryPath, filePath);
  }

  /**
   * Calculate diff stats (async, shared diff implementation).
   */
  static async calculateStats(originalContent: string, modifiedContent: string): Promise<DiffStats> {
    return calculateDiffStats(originalContent, modifiedContent);
  }

  /**
   * Calculate diff stats (sync fallback).
   */
  static calculateStatsSync(originalContent: string, modifiedContent: string): DiffStats {
    return calculateDiffStatsFallback(originalContent, modifiedContent);
  }

  /**
   * Get real-time stats from Git.
   */
  static async getRealTimeStats(repositoryPath: GitWorkspaceScope, filePath: string): Promise<DiffStats | null> {
    return getFileDiffStats(repositoryPath, filePath);
  }
}

export default GitDiffService;
