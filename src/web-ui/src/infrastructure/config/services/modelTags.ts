import type { AIModelConfig } from '../types';

const USER_TAGS_KEY = 'user_tags';
export const MAX_MODEL_USER_TAGS = 3;

function checkedMetadata(model: Pick<AIModelConfig, 'metadata'>): Record<string, unknown> {
  if (model.metadata != null
    && (typeof model.metadata !== 'object' || Array.isArray(model.metadata))) {
    throw new Error('Cannot update model annotations with unsupported metadata');
  }
  return model.metadata ?? {};
}

export function normalizeModelTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim())
    .filter(Boolean))];
}

export function getModelUserTags(model: Pick<AIModelConfig, 'metadata'>): string[] {
  return normalizeModelTags(model.metadata?.[USER_TAGS_KEY]);
}

export function getModelTags(model: Pick<AIModelConfig, 'metadata' | 'recommended_for'>): string[] {
  return normalizeModelTags([
    ...getModelUserTags(model),
    ...normalizeModelTags(model.recommended_for),
  ]);
}

/** User labels are annotations, never model capabilities or default selectors. */
export function withModelUserTags(model: AIModelConfig, tags: readonly string[]): AIModelConfig {
  const normalizedTags = normalizeModelTags(tags);
  const existingTags = new Set(getModelUserTags(model));
  // Preserve older configurations above the limit and allow their tags to be removed.
  if (normalizedTags.length > MAX_MODEL_USER_TAGS
    && normalizedTags.some(tag => !existingTags.has(tag))) {
    throw new Error(`Models support up to ${MAX_MODEL_USER_TAGS} custom tags`);
  }
  return {
    ...model,
    metadata: { ...checkedMetadata(model), [USER_TAGS_KEY]: normalizedTags },
  };
}

/** Keep each model's annotations unless its own draft explicitly edits user tags. */
export function preserveModelAnnotations(
  current: AIModelConfig | undefined,
  next: AIModelConfig,
  userTags?: readonly string[],
): AIModelConfig {
  const metadata = { ...checkedMetadata(next) };
  delete metadata[USER_TAGS_KEY];
  const currentMetadata = current ? checkedMetadata(current) : {};
  if (Object.prototype.hasOwnProperty.call(currentMetadata, USER_TAGS_KEY)) {
    metadata[USER_TAGS_KEY] = currentMetadata[USER_TAGS_KEY];
  }
  const preserved = {
    ...next,
    recommended_for: current?.recommended_for ?? [],
    metadata,
  };
  return userTags === undefined ? preserved : withModelUserTags(preserved, userTags);
}
