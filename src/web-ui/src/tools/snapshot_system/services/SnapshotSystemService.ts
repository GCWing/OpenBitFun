import { snapshotAPI } from '../../../infrastructure/api/service-api/SnapshotAPI';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('SnapshotSystemService');

// Tool names as emitted by the backend snapshot system.
const FILE_OPERATION_TOOLS = ['Write', 'Edit', 'Delete'] as const;

export class SnapshotSystemService {
  private static instance: SnapshotSystemService;

  private constructor() {}

  public static getInstance(): SnapshotSystemService {
    if (!SnapshotSystemService.instance) {
      SnapshotSystemService.instance = new SnapshotSystemService();
    }
    return SnapshotSystemService.instance;
  }

  async getSessionStats(sessionId: string): Promise<{
    session_id: string;
    total_files: number;
    total_turns: number;
    total_changes: number;
  }> {
    try {
      return await snapshotAPI.getSessionStats(sessionId);
    } catch (error) {
      log.error('Failed to get session stats', { sessionId, error });
      throw error;
    }
  }

  async getOperationDiff(sessionId: string, filePath: string): Promise<{
    originalCode: string;
    modifiedCode: string;
    filePath: string;
  }> {
    try {
      const result = await snapshotAPI.getOperationDiff(sessionId, filePath);
      return {
        originalCode: result.originalContent || '',
        modifiedCode: result.modifiedContent || '',
        filePath: result.filePath || filePath
      };
    } catch (error) {
      log.error('Failed to get operation diff', { sessionId, filePath, error });
      throw error;
    }
  }
  async acceptSessionModifications(sessionId: string): Promise<void> {
    try {
      await snapshotAPI.acceptSessionModifications(sessionId);
    } catch (error) {
      log.error('Failed to accept session modifications', { sessionId, error });
      throw error;
    }
  }

  async rejectSessionModifications(sessionId: string): Promise<void> {
    try {
      await snapshotAPI.rejectSessionModifications(sessionId);
    } catch (error) {
      log.error('Failed to reject session modifications', { sessionId, error });
      throw error;
    }
  }

  async acceptFileModifications(sessionId: string, filePath: string): Promise<void> {
    try {
      await snapshotAPI.acceptFileModifications(sessionId, filePath);
    } catch (error) {
      log.error('Failed to accept file modifications', { sessionId, filePath, error });
      throw error;
    }
  }

  async rejectFileModifications(sessionId: string, filePath: string): Promise<void> {
    try {
      await snapshotAPI.rejectFileModifications(sessionId, filePath);
    } catch (error) {
      log.error('Failed to reject file modifications', { sessionId, filePath, error });
      throw error;
    }
  }

  async acceptDiffBlock(sessionId: string, filePath: string, blockId: string): Promise<void> {
    try {
      await snapshotAPI.acceptDiffBlock(sessionId, filePath, parseInt(blockId, 10));
    } catch (error) {
      log.error('Failed to accept diff block', { sessionId, filePath, blockId, error });
      throw error;
    }
  }

  async rejectDiffBlock(sessionId: string, filePath: string, blockId: string): Promise<void> {
    try {
      await snapshotAPI.rejectDiffBlock(sessionId, filePath, parseInt(blockId, 10));
    } catch (error) {
      log.error('Failed to reject diff block', { sessionId, filePath, blockId, error });
      throw error;
    }
  }

  isFileOperationTool(toolName: string): boolean {
    return (FILE_OPERATION_TOOLS as readonly string[]).includes(toolName);
  }
}
