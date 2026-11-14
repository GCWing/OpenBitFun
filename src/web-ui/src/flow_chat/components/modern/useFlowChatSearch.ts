/**
 * FlowChat message search hook.
 * Searches user + model text and reports every occurrence of the query, so a
 * turn containing several hits contributes several navigable matches.
 * Each match also keeps the concrete rendered source so navigation can land on
 * the matching text instead of only centering a potentially very tall turn.
 */

import { useState, useMemo, useCallback } from 'react';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import { getCachedInlineFlowGroupData, getProjectedModelRoundGroups } from '../../grouping/roundGroups';

interface SearchableFlowItem {
  id?: string;
  type: string;
  content?: string;
}

export interface SearchMatch {
  /** Virtual index of the item containing this occurrence. */
  virtualItemIndex: number;
  turnId: string;
  type: VirtualItem['type'];
  /** Rendered FlowItem containing this occurrence, when applicable. */
  flowItemId?: string;
  /** Zero-based occurrence of the query within this source's text. */
  occurrenceIndex: number;
  /** Collapsible containers that must be opened, from outermost to innermost. */
  expandableIds?: readonly string[];
}

export interface UseFlowChatSearchReturn {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  matches: SearchMatch[];
  /** Concrete text sources grouped once for the rendered rows. */
  matchesByVirtualIndex: ReadonlyMap<number, readonly SearchMatch[]>;
  /** Only virtual items that contain a match, never their non-matching turn siblings. */
  matchIndices: ReadonlySet<number>;
  currentMatchIndex: number;
  currentMatchVirtualIndex: number;
  goToNext: () => void;
  goToPrev: () => void;
  clearSearch: () => void;
}

interface SearchableSource {
  foldedContent: string;
  flowItemId?: string;
  expandableIds?: readonly string[];
}

function flowItemSearchSources(
  items: readonly SearchableFlowItem[],
  outerExpandableId?: string,
): SearchableSource[] {
  return items.flatMap(item => {
    if (item.type !== 'text' && item.type !== 'thinking') {
      return [];
    }

    const expandableIds = [
      ...(outerExpandableId ? [outerExpandableId] : []),
      ...(item.type === 'thinking' && item.id ? [item.id] : []),
    ];
    const content = item.content ?? '';

    return [{
      foldedContent: content.toLowerCase(),
      flowItemId: item.id,
      expandableIds: expandableIds.length > 0 ? expandableIds : undefined,
    }];
  });
}

function getVirtualItemSearchSources(item: VirtualItem): SearchableSource[] {
  let sources: SearchableSource[];
  if (item.type === 'background-run') {
    const userContent = item.turn.userMessage.content;
    sources = [
      { foldedContent: userContent.toLowerCase() },
      ...flowItemSearchSources(item.turn.modelRounds.flatMap(round => round.items)),
    ];
  } else if (item.type === 'user-message' || item.type === 'user-steering-message') {
    const content = item.data?.content ?? '';
    sources = [{ foldedContent: content.toLowerCase() }];
  } else if (item.type === 'model-round') {
    sources = getProjectedModelRoundGroups(item).flatMap(group => group.type !== 'critical'
      ? flowItemSearchSources(group.items, getCachedInlineFlowGroupData(item.data, group).groupId)
      : flowItemSearchSources([group.item]));
  } else if (item.type === 'explore-group') {
    sources = flowItemSearchSources(item.data.allItems, item.data.groupId);
  } else if (item.type === 'turn-completion-notice') {
    const content = item.data.reasonCode;
    sources = [{ foldedContent: content.toLowerCase() }];
  } else if (item.type === 'turn-failure-notice') {
    const content = [
      item.data.error,
      item.data.errorDetail?.provider,
      item.data.errorDetail?.providerCode,
      item.data.errorDetail?.providerMessage,
      item.data.errorDetail?.requestId,
    ].filter(Boolean).join(' ');
    sources = [{ foldedContent: content.toLowerCase() }];
  } else {
    sources = [];
  }
  return sources;
}

function countFoldedQueryOccurrences(foldedContent: string, foldedQuery: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const index = foldedContent.indexOf(foldedQuery, from);
    if (index < 0) {
      return count;
    }
    count += 1;
    from = index + foldedQuery.length;
  }
}

const emptySearchMatches: SearchMatch[] = [];
type SearchMatchCache = WeakMap<VirtualItem, {
  query: string;
  virtualItemIndex: number;
  matches: readonly SearchMatch[];
}>;

export function buildFlowChatSearchMatches(
  virtualItems: readonly VirtualItem[],
  searchQuery: string,
  cache?: SearchMatchCache,
): SearchMatch[] {
  const trimmed = searchQuery.trim();
  if (!trimmed) return emptySearchMatches;
  const query = trimmed.toLowerCase();
  const matches: SearchMatch[] = [];

  for (let virtualItemIndex = 0; virtualItemIndex < virtualItems.length; virtualItemIndex += 1) {
    const item = virtualItems[virtualItemIndex];
    const cached = cache?.get(item);
    if (cached && cached.query === query && cached.virtualItemIndex === virtualItemIndex) {
      for (let i = 0; i < cached.matches.length; i += 1) {
        matches.push(cached.matches[i]);
      }
      continue;
    }
    const itemMatches: SearchMatch[] = [];
    for (const source of getVirtualItemSearchSources(item)) {
      const occurrenceCount = countFoldedQueryOccurrences(source.foldedContent, query);
      for (let occurrenceIndex = 0; occurrenceIndex < occurrenceCount; occurrenceIndex += 1) {
        itemMatches.push({
          virtualItemIndex,
          turnId: item.turnId,
          type: item.type,
          flowItemId: source.flowItemId,
          occurrenceIndex,
          expandableIds: source.expandableIds,
        });
      }
    }
    cache?.set(item, { query, virtualItemIndex, matches: itemMatches });
    for (let i = 0; i < itemMatches.length; i += 1) {
      matches.push(itemMatches[i]);
    }
  }

  return matches;
}

/** Cache only match metadata while this view searches; folded text is temporary. */
export function createFlowChatSearchMatcher() {
  let cache: SearchMatchCache = new WeakMap();
  return (items: readonly VirtualItem[], query: string): SearchMatch[] => {
    if (!query.trim()) {
      cache = new WeakMap();
      return emptySearchMatches;
    }
    return buildFlowChatSearchMatches(items, query, cache);
  };
}

export function useFlowChatSearch(virtualItems: VirtualItem[]): UseFlowChatSearchReturn {
  const [searchQuery, setSearchQuery] = useState('');
  const [findMatches] = useState(createFlowChatSearchMatcher);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const matches = useMemo<SearchMatch[]>(() => (
    findMatches(virtualItems, searchQuery)
  ), [virtualItems, searchQuery, findMatches]);

  const resolvedCurrentMatchIndex = matches.length > 0
    ? Math.min(currentMatchIndex, matches.length - 1)
    : 0;

  const matchesByVirtualIndex = useMemo(() => {
    const grouped = new Map<number, SearchMatch[]>();
    for (const match of matches) {
      const row = grouped.get(match.virtualItemIndex);
      if (row) row.push(match);
      else grouped.set(match.virtualItemIndex, [match]);
    }
    return grouped;
  }, [matches]);

  const matchIndices = useMemo<ReadonlySet<number>>(() => (
    new Set(matchesByVirtualIndex.keys())
  ), [matchesByVirtualIndex]);

  const currentMatchVirtualIndex = matches[resolvedCurrentMatchIndex]?.virtualItemIndex ?? -1;

  const onSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    setCurrentMatchIndex(0);
  }, []);

  const goToNext = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(prev => {
      const current = Math.min(prev, matches.length - 1);
      return (current + 1) % matches.length;
    });
  }, [matches.length]);

  const goToPrev = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(prev => {
      const current = Math.min(prev, matches.length - 1);
      return (current - 1 + matches.length) % matches.length;
    });
  }, [matches.length]);

  const clearSearch = useCallback(() => {
    findMatches([], '');
    setSearchQuery('');
    setCurrentMatchIndex(0);
  }, [findMatches]);

  return {
    searchQuery,
    onSearchChange,
    matches,
    matchesByVirtualIndex,
    matchIndices,
    currentMatchIndex: resolvedCurrentMatchIndex,
    currentMatchVirtualIndex,
    goToNext,
    goToPrev,
    clearSearch,
  };
}
