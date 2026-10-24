import type { ModelCapability, ModelCategory } from '../types';

type ModelCapabilitySource = {
  id?: string | null;
  enabled?: boolean | null;
  category?: ModelCategory | string | null;
  capabilities?: readonly (ModelCapability | string)[] | null;
};

const MULTIMODAL_MODEL_HINTS = [
  'vision',
  'gpt-4o',
  'gpt-4-turbo',
  'claude-3',
  'gemini-pro-vision',
  'gemini-1.5',
  'kimi',
];

const SPEECH_RECOGNITION_MODEL_HINTS = [
  'asr',
  'transcribe',
  'transcription',
  'whisper',
  'speech',
];

const IMAGE_GENERATION_MODEL_HINTS = [
  'dall-e',
  'dalle',
  'image',
  'flux',
  'sdxl',
  'stable-diffusion',
  'midjourney',
  'imagen',
  'draw',
];

export function inferModelCategory(
  modelName: string,
  _provider?: string
): ModelCategory {
  const normalized = modelName.trim().toLowerCase();
  if (SPEECH_RECOGNITION_MODEL_HINTS.some(hint => normalized.includes(hint))) {
    return 'speech_recognition';
  }
  if (IMAGE_GENERATION_MODEL_HINTS.some(hint => normalized.includes(hint))) {
    return 'image_generation';
  }
  if (MULTIMODAL_MODEL_HINTS.some(hint => normalized.includes(hint))) {
    return 'multimodal';
  }
  return 'general_chat';
}

export function resolveModelCategory(
  modelName: string,
  category?: ModelCategory,
  provider?: string
): ModelCategory {
  const inferred = inferModelCategory(modelName, provider);

  if (category === 'multimodal') {
    return 'multimodal';
  }

  if (category === 'image_generation') {
    return 'image_generation';
  }

  if (category === 'speech_recognition') {
    return 'speech_recognition';
  }

  if (category === 'general_chat' && inferred === 'multimodal') {
    return 'multimodal';
  }

  if (category === 'general_chat' && inferred === 'speech_recognition') {
    return 'speech_recognition';
  }

  if (category === 'general_chat' && inferred === 'image_generation') {
    return 'image_generation';
  }

  return category ?? inferred;
}

export function getCapabilitiesByCategory(category?: ModelCategory | string | null): ModelCapability[] {
  switch (category) {
    case 'speech_recognition':
      return ['speech_recognition'];
    case 'image_generation':
      return ['image_generation'];
    case 'multimodal':
      return ['text_chat', 'image_understanding', 'function_calling'];
    case 'general_chat':
    default:
      return ['text_chat', 'function_calling'];
  }
}

/**
 * Resolve the capabilities of a persisted model without guessing from its
 * display name. Older configs may omit capabilities or persist an empty list;
 * those records retain the backend-compatible category defaults.
 */
export function getEffectiveModelCapabilities(model: ModelCapabilitySource): ModelCapability[] {
  const explicitCapabilities = Array.isArray(model.capabilities)
    ? model.capabilities.filter((capability): capability is ModelCapability => (
      capability === 'text_chat'
      || capability === 'function_calling'
      || capability === 'image_understanding'
      || capability === 'image_generation'
      || capability === 'speech_recognition'
    ))
    : [];

  return explicitCapabilities.length > 0
    ? explicitCapabilities
    : getCapabilitiesByCategory(model.category);
}

/** A configured model can be selected for a specific capability. */
export function isSelectableModelForCapability(
  model: ModelCapabilitySource,
  capability: ModelCapability,
): boolean {
  return Boolean(model.id?.trim())
    && model.enabled === true
    && getEffectiveModelCapabilities(model).includes(capability);
}

/** A model can be shown and selected for the normal text-chat composer. */
export function isSelectableTextChatModel(model: ModelCapabilitySource): boolean {
  return isSelectableModelForCapability(model, 'text_chat');
}

/** Preserve the caller's model shape while applying the canonical filter. */
export function filterSelectableTextChatModels<T extends ModelCapabilitySource>(
  models: readonly T[],
): T[] {
  return models.filter(isSelectableTextChatModel);
}
