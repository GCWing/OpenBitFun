import {
  INTERACTIVE_CAPABILITY_CATALOG,
  getInteractiveCapabilityCatalog,
  isInteractiveCapabilityDestinationAvailable,
  type InteractiveCapability,
} from '../interactiveCapabilityCatalog';
import { scoreTextMatch } from '../searchMatching';
import type { GlobalSearchProvider } from '../types';

function matchingItem(capability: InteractiveCapability, query: string) {
  const queryTokens = query.trim().split(/[\s._/\\:-]+/u).filter(Boolean);
  return capability.items
    .map((item) => {
      const directScore = scoreTextMatch(query, [item.titleZh, item.titleEn]);
      const partialScore = Math.max(0, ...queryTokens.map((token) =>
        scoreTextMatch(token, [item.titleZh, item.titleEn])));
      return {
        item,
        score: directScore > 0 ? 100 + directScore : Math.floor(partialScore / 2),
      };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)[0]?.item;
}

export const interactiveCapabilitySearchProvider: GlobalSearchProvider = {
  id: 'interactive-capabilities',
  groups: ['capabilities', 'settings'],
  search: (request) => {
    if (request.scope === 'content' || !request.query) return { items: [] };

    const t = request.tCapabilities;
    const catalog = request.currentWorkspace?.workspaceKind === 'remote'
      ? getInteractiveCapabilityCatalog(false)
      : INTERACTIVE_CAPABILITY_CATALOG;
    const items = catalog.capabilities
      .flatMap((capability) => {
        const item = matchingItem(capability, request.query);
        if (!isInteractiveCapabilityDestinationAvailable(item?.destination ?? capability.destination)) {
          return [];
        }
        const textScore = scoreTextMatch(request.query, [
          capability.id,
          capability.titleZh,
          capability.titleEn,
          ...capability.searchTerms,
        ]);
        const directControlBonus = Math.min(
          8,
          capability.operations.length + capability.options.length,
        );
        const delegatedControlBonus = capability.items.some(({ control }) =>
          control.kind === 'delegate') ? 4 : 0;
        return {
          id: `capability:${capability.id}`,
          providerId: 'interactive-capabilities',
          group: capability.kind === 'setting' ? 'settings' as const : 'capabilities' as const,
          title: t(`search.capabilities.${capability.id}.title`),
          subtitle: item
            ? t(`search.capabilities.${capability.id}.items.${item.id}`)
            : t(`search.capabilities.${capability.id}.summary`),
          context: t(`search.categories.${capability.categoryId}`),
          badge: t(`search.kinds.${capability.kind}`),
          // Control coverage only breaks ties between equal textual matches.
          // New operations must not outrank a more relevant capability.
          score: textScore > 0 ? textScore + (directControlBonus + delegatedControlBonus) / 100 : 0,
          target: {
            kind: 'capability' as const,
            capabilityId: capability.id,
            itemId: item?.id,
          },
        };
      })
      .filter((item) => item.score > 0);

    return { items };
  },
};
