import { api } from './ApiClient';
import { supportsBtwModelPools, type ModelSelection } from './ModelPoolAPI';
import { createTauriCommandError } from '../errors/TauriCommandError';
import type { ImageContextData as ImageInputContextData } from './ImageContextTypes';

export interface BtwInitialModelTarget {
  selection: ModelSelection;
  reasoningPreset?: string;
}

export interface BtwAskStreamRequest {
  requestId: string;
  sessionId: string;
  question: string;
  modelId?: string;
  childSessionId: string;
  childSessionName?: string;
  parentDialogTurnId?: string;
  parentTurnIndex?: number;
  imageContexts?: ImageInputContextData[];
  /** Optional UI metadata; question always contains the complete readable fallback. */
  userMessageMetadata?: Record<string, unknown>;
  /** Negotiated on peers; omission retains the parent's model/reasoning policy. */
  initialModelSelection?: { modelId: string; reasoningPreset?: string };
  /** Requires btw_model_pool_selection_v1. Omit to inherit the parent's binding. */
  initialModelTarget?: BtwInitialModelTarget;
}

export interface BtwAskStreamResponse {
  ok: boolean;
}

export interface BtwCancelRequest {
  requestId: string;
}

export class BtwAPI {
  async askStream(request: BtwAskStreamRequest): Promise<BtwAskStreamResponse> {
    try {
      if (request.initialModelTarget && !supportsBtwModelPools()) {
        throw new Error('This host does not support btw_model_pool_selection_v1');
      }
      return await api.invoke<BtwAskStreamResponse>('btw_ask_stream', { request });
    } catch (error) {
      throw createTauriCommandError('btw_ask_stream', error, request);
    }
  }

  async cancel(request: BtwCancelRequest): Promise<void> {
    try {
      await api.invoke<void>('btw_cancel', { request });
    } catch (error) {
      throw createTauriCommandError('btw_cancel', error, request);
    }
  }
}

export const btwAPI = new BtwAPI();
