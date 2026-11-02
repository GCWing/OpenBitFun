import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import type { ImageServiceConfig } from '@/infrastructure/config/types';

/** Failure classes the settings page renders as distinct guidance. */
export type ImageGenerationErrorKind =
  | 'config'
  | 'auth'
  | 'rate_limited'
  | 'invalid_request'
  | 'content_filtered'
  | 'timeout'
  | 'transport'
  | 'provider'
  | 'empty_result';

/** Result of one real generation performed from the settings page. */
export interface ImageServiceTestOutcome {
  success: boolean;
  elapsed_ms: number;
  error_kind?: ImageGenerationErrorKind | null;
  message?: string | null;
  mime?: string | null;
  image_base64?: string | null;
}

/**
 * Media services own their own API surface: an image call is not a chat call, so
 * it does not go through the model router or the session's selected model.
 */

/**
 * Image providers routinely need tens of seconds to render, so the generic
 * 30 s IPC deadline would abort a healthy request while the backend keeps
 * waiting. Stay above the backend's own 180 s whole-request budget instead, so
 * the failing side is always the one that owns the HTTP call.
 */
const IMAGE_GENERATION_IPC_TIMEOUT_MS = 240_000;

export const mediaAPI = {
  /**
   * Runs one real generation with a draft service.
   *
   * This bills the user's provider, so the caller must present it as a real
   * generation rather than a free probe.
   */
  async testImageGenerationService(
    service: ImageServiceConfig,
    prompt?: string,
  ): Promise<ImageServiceTestOutcome> {
    try {
      return await api.invoke(
        'test_image_generation_service',
        { request: { service, prompt } },
        { timeout: IMAGE_GENERATION_IPC_TIMEOUT_MS },
      );
    } catch (error) {
      throw createTauriCommandError('test_image_generation_service', error, { service, prompt });
    }
  },
};
