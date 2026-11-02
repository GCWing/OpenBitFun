import type { AIModelConfig } from '@/infrastructure/config/types';
import { getEffectiveModelCapabilities, isSelectableTextChatModel } from '@/infrastructure/config/services/modelCategory';

/** Every native image route must accept the draft before automatic selection. */
export function modelSelectionImageLimit(
  models: readonly AIModelConfig[],
  primary?: AIModelConfig | null,
  poolMemberIds?: readonly string[],
): number | undefined {
  const roots = poolMemberIds ? models.filter(model => model.id && poolMemberIds.includes(model.id)) : primary ? [primary] : [];
  const candidateIds = roots.filter(isSelectableTextChatModel).flatMap(model => model.channel_routing?.manual_channel
    ? [model.channel_routing.manual_channel]
    : [model.id, ...(model.channel_routing?.fallback_model_ids ?? [])]);
  const limits = models.filter(model => candidateIds.includes(model.id)
    && isSelectableTextChatModel(model) && getEffectiveModelCapabilities(model).includes('image_understanding'))
    .map(model => model.max_images_per_request)
    .filter((limit): limit is number => typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0);
  return limits.length > 0 ? Math.min(...limits) : undefined;
}
