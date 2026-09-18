 

import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import type {
  ExecuteToolRequest,
  GetToolInfoRequest,
  ValidateToolInputRequest
} from './tauri-commands';
import { createLogger } from '@/shared/utils/logger';
import type { ToolInfo } from '@/shared/types/agent-api';

const log = createLogger('ToolAPI');

export class ToolAPI {
   
  async getAllToolsInfo(): Promise<ToolInfo[]> {
    try {
      return await api.invoke('get_all_tools_info');
    } catch (error) {
      throw createTauriCommandError('get_all_tools_info', error);
    }
  }

   
  async getToolInfo(toolName: string): Promise<ToolInfo | null> {
    try {
      const request: GetToolInfoRequest = { toolName };
      return await api.invoke('get_tool_info', { 
        request
      });
    } catch (error) {
      throw createTauriCommandError('get_tool_info', error, { toolName });
    }
  }

   
  async validateToolInput(request: ValidateToolInputRequest): Promise<any> {
    try {
      return await api.invoke('validate_tool_input', { 
        request
      });
    } catch (error) {
      throw createTauriCommandError('validate_tool_input', error, request);
    }
  }

   
  async executeTool(request: ExecuteToolRequest): Promise<any> {
    try {
      return await api.invoke('execute_tool', { 
        request: {
          toolName: request.toolName,
          input: request.parameters,
          workspaceId: request.workspaceId,
        }
      });
    } catch (error) {
      throw createTauriCommandError('execute_tool', error, request);
    }
  }

   
  /**
   * Submit user answers.
   */
  async startUserQuestionInteraction(toolId: string, sessionId: string): Promise<void> {
    await api.invoke('start_user_question_interaction', { request: { toolId, sessionId } });
  }

  async submitUserAnswers(
    toolId: string,
    answers: Record<string, string | string[]>,
    sessionId?: string,
  ): Promise<void> {
    try {
      await api.invoke('submit_user_answers', { 
        toolId,
        answers,
        ...(sessionId ? { sessionId } : {}),
      });
    } catch (error) {
      log.error('Failed to submit user answers', { toolId, sessionId, error });
      throw createTauriCommandError('submit_user_answers', error, { toolId, sessionId, answers });
    }
  }
}


export const toolAPI = new ToolAPI();
