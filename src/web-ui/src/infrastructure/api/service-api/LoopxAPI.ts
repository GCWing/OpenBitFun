import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import type {
  AiModelInfo,
  LoopxActionRequest,
  LoopxActionResponse,
  LoopxAttachRequest,
  LoopxAttachResponse,
  LoopxCreateTaskRequest,
  LoopxCreateTaskResponse,
  LoopxEventsSinceRequest,
  LoopxEventsSinceResponse,
  LoopxResolveIntakeRequest,
  LoopxResolveIntakeResponse,
  LoopxTurnOutputSinceRequest,
  LoopxTurnOutputSinceResponse,
} from './MiniAppAPI';

export type {
  LoopxActionKind,
  LoopxActionRequest,
  LoopxAttachRequest,
  LoopxCreateTaskRequest,
  LoopxEventsSinceRequest,
  LoopxIssueKey,
  LoopxItemKind,
  LoopxPermissionScope,
  LoopxResolveIntakeRequest,
  LoopxTurnOutputSinceRequest,
} from './MiniAppAPI';

/** Private client for the verified built-in LoopX product extension. */
class LoopxAPI {
  async attach(appId: string, request: LoopxAttachRequest = {}): Promise<LoopxAttachResponse> {
    try {
      return await api.invoke('miniapp_loopx_attach', {
        request: { appId, ...request },
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_loopx_attach', error, { appId });
    }
  }

  async listModels(appId: string): Promise<AiModelInfo[]> {
    try {
      return await api.invoke('miniapp_loopx_list_models', {
        request: { appId },
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_loopx_list_models', error, { appId });
    }
  }

  async resolveIntake(
    appId: string,
    request: LoopxResolveIntakeRequest,
  ): Promise<LoopxResolveIntakeResponse> {
    try {
      return await api.invoke('miniapp_loopx_resolve_intake', {
        request: { appId, ...request },
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_loopx_resolve_intake', error, { appId });
    }
  }

  async createTask(
    appId: string,
    request: LoopxCreateTaskRequest,
  ): Promise<LoopxCreateTaskResponse> {
    try {
      return await api.invoke('miniapp_loopx_create_task', {
        request: { appId, ...request },
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_loopx_create_task', error, {
        appId,
        clientRequestId: request.clientRequestId,
      });
    }
  }

  async action(appId: string, request: LoopxActionRequest): Promise<LoopxActionResponse> {
    try {
      return await api.invoke('miniapp_loopx_action', {
        request: { appId, ...request },
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_loopx_action', error, {
        appId,
        action: request.action,
        taskId: request.taskId,
        clientRequestId: request.clientRequestId,
      });
    }
  }

  async eventsSince(
    appId: string,
    request: LoopxEventsSinceRequest,
  ): Promise<LoopxEventsSinceResponse> {
    try {
      return await api.invoke('miniapp_loopx_events_since', {
        request: { appId, ...request },
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_loopx_events_since', error, {
        appId,
        streamId: request.streamId,
        afterCursor: request.afterCursor,
      });
    }
  }

  async turnOutputSince(
    appId: string,
    request: LoopxTurnOutputSinceRequest,
  ): Promise<LoopxTurnOutputSinceResponse> {
    try {
      return await api.invoke('miniapp_loopx_turn_output_since', {
        request: { appId, ...request },
      });
    } catch (error) {
      throw createTauriCommandError('miniapp_loopx_turn_output_since', error, {
        appId,
        taskId: request.taskId,
        afterCursor: request.afterCursor,
      });
    }
  }
}

export const loopxAPI = new LoopxAPI();
