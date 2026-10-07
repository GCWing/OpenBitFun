import { useSettingsDraftSnapshot } from '@/infrastructure/config/settingsDraftRegistry';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { getInteractionMotion } from '@/shared/utils/motionPreference';
import {
  Icon,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelHeader,
  NavigationPanelItem,
  NavigationPanelSection,
  OverflowText,
  SearchField,
} from '@openbitfun/ui';
import type { i18n as I18nApi } from 'i18next';
import React, {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import './SettingsNav.scss';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_PAGE_MANIFESTS,
  preloadSettingsPage,
  type SettingsSearchPhrase,
} from './settingsRegistry';
import { useSettingsStore } from './settingsStore';
import type { SettingsDestination, SettingsPageId } from './settingsTypes';

const SEARCH_DEBOUNCE_MS = 150;
type SettingsT = (key: string, options?: Record<string, unknown>) => unknown;

export interface SettingsSearchRow {
  destination: SettingsDestination;
  categoryLabel: string;
  pageLabel: string;
  targetLabel?: string;
  description: string;
  haystack: string;
}

function translateString(t: SettingsT, key: string, fallback: string): string {
  const value = t(key, { defaultValue: fallback });
  return typeof value === 'string' ? value : fallback;
}

function resolvePhrases(i18n: I18nApi, phrases: readonly SettingsSearchPhrase[]): string {
  const parts: string[] = [];
  for (const { namespace, key } of phrases) {
    const value = i18n.getFixedT(i18n.language, namespace)(key, { defaultValue: '' });
    if (typeof value === 'string' && value.trim() && value !== key) parts.push(value);
  }
  return parts.join(' ');
}

function buildSettingsSearchIndex(t: SettingsT, i18n: I18nApi): SettingsSearchRow[] {
  const categoryLabels = new Map(SETTINGS_CATEGORIES.map((category) => [
    category.id,
    translateString(t, category.labelKey, category.id),
  ]));

  return SETTINGS_PAGE_MANIFESTS.flatMap((page) => {
    const categoryLabel = categoryLabels.get(page.categoryId) ?? page.categoryId;
    const pageLabel = translateString(t, page.labelKey, page.id);
    const description = translateString(t, page.descriptionKey, '');
    const pageContent = resolvePhrases(i18n, page.searchPhrases);
    const base = [categoryLabel, pageLabel, description, page.id, ...page.keywords, pageContent];

    const targets = [
      ...(page.sections ?? []).map(section => ({ ...section, destination: { pageId: page.id, sectionId: section.id } })),
      ...(page.views ?? []).map(view => ({ ...view, destination: { pageId: page.id, viewId: view.id } })),
    ];
    return [
      {
        destination: { pageId: page.id },
        categoryLabel,
        pageLabel,
        description,
        haystack: base.join(' ').toLowerCase(),
      },
      ...targets.map((target) => {
        const targetLabel = translateString(t, target.labelKey, target.id);
        return {
          destination: target.destination,
          categoryLabel,
          pageLabel,
          targetLabel,
          description,
          haystack: [
            targetLabel,
            target.id,
            ...target.keywords,
            resolvePhrases(i18n, target.searchPhrases),
          ].join(' ').toLowerCase(),
        };
      }),
    ];
  });
}

function highlightFirstMatch(text: string, query: string): React.ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark
        className="openbitfun-settings-nav__search-highlight"
        data-openbitfun-component="settings-nav"
        data-openbitfun-part="highlight"
      >
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}

const SettingsNav: React.FC = () => {
  const { t, i18n } = useTranslation('settings');
  const { t: tComponents } = useI18n('components');
  const activePageId = useSettingsStore((state) => state.activePageId);
  const activeViewId = useSettingsStore((state) => state.activeViewId);
  const activeSectionId = useSettingsStore((state) => state.activeSectionId);
  const { resources: draftResources } = useSettingsDraftSnapshot();
  const openDestination = useSettingsStore((state) => state.openDestination);
  const searchQuery = useSettingsStore((state) => state.searchQuery);
  const setSearchQuery = useSettingsStore((state) => state.setSearchQuery);
  const [draftQuery, setDraftQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const activationRequestRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(draftQuery), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draftQuery, setSearchQuery]);

  const searchIndex = useMemo(() => buildSettingsSearchIndex(t, i18n), [i18n, t]);
  const results = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    const matches = searchIndex.filter((row) => row.haystack.includes(query));
    const matchedSections = new Set(matches
      .filter((row) => row.targetLabel)
      .map((row) => row.destination.pageId));
    return matches.filter((row) => row.targetLabel || !matchedSections.has(row.destination.pageId));
  }, [searchIndex, searchQuery]);
  const isSearchMode = draftQuery.trim().length > 0;
  const dirtyPageIds = useMemo(() => new Set(
    draftResources.filter(resource => resource.dirty).map(resource => resource.pageId),
  ), [draftResources]);

  const dirtyMarker = useCallback((pageId: SettingsPageId) => (
    dirtyPageIds.has(pageId) ? (
      <span
        className="openbitfun-settings-nav__dirty-marker"
        data-openbitfun-component="settings-nav"
        data-openbitfun-part="dirtyMarker"
        title={t('changeGuard.unsavedPage')}
        aria-label={t('changeGuard.unsavedPage')}
      />
    ) : null
  ), [dirtyPageIds, t]);

  useEffect(() => {
    setHighlightedIndex((current) => {
      if (!results.length) return -1;
      return current >= results.length ? results.length - 1 : current;
    });
  }, [results.length]);

  const clearSearch = useCallback(() => {
    setDraftQuery('');
    setSearchQuery('');
    setHighlightedIndex(-1);
  }, [setSearchQuery]);

  const activate = useCallback((destination: SettingsDestination, clear = false) => {
    const requestId = ++activationRequestRef.current;
    const motion = getInteractionMotion();
    const commit = () => {
      if (requestId !== activationRequestRef.current) return;
      startTransition(() => {
        openDestination(destination, motion);
        if (clear) clearSearch();
      });
    };
    void preloadSettingsPage(destination.pageId).then(commit, commit);
  }, [clearSearch, openDestination]);

  const preload = useCallback((pageId: SettingsPageId) => {
    void preloadSettingsPage(pageId).catch(() => undefined);
  }, []);

  const handleSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      clearSearch();
    } else if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setHighlightedIndex(0);
      queueMicrotask(() => resultsRef.current?.focus());
    } else if (event.key === 'Enter' && results.length === 1) {
      event.preventDefault();
      activate(results[0].destination, true);
    }
  }, [activate, clearSearch, results]);

  const handleResultsKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!results.length) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      clearSearch();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((index) => {
        if (index <= 0) {
          searchInputRef.current?.focus();
          return -1;
        }
        return index - 1;
      });
    } else if (event.key === 'Enter' && highlightedIndex >= 0) {
      event.preventDefault();
      activate(results[highlightedIndex].destination, true);
    }
  }, [activate, clearSearch, highlightedIndex, results]);

  return (
    <NavigationPanel
      className="openbitfun-settings-nav"
      data-testid="settings-nav"
      aria-label={t('shared:features.settings')}
      data-openbitfun-component="settings-nav"
      data-openbitfun-part="root"
    >
      <NavigationPanelHeader
        className="openbitfun-settings-nav__panel-header"
        data-openbitfun-component="settings-nav"
        data-openbitfun-part="header"
      >
        <div className="openbitfun-settings-nav__search" data-openbitfun-component="settings-nav" data-openbitfun-part="search">
          <SearchField
            ref={searchInputRef}
            className="openbitfun-settings-nav__search-field"
            size="sm"
            value={draftQuery}
            onValueChange={setDraftQuery}
            onClear={draftQuery ? () => {
              clearSearch();
              searchInputRef.current?.focus();
            } : undefined}
            clearLabel={draftQuery ? tComponents('search.clear') : undefined}
            onKeyDown={handleSearchKeyDown}
            leadingIcon={<Icon name="search" size="sm" />}
            placeholder={t('navigation.search.placeholder')}
            aria-label={t('navigation.search.placeholder')}
            aria-controls="settings-nav-results"
            aria-expanded={isSearchMode}
          />
        </div>
      </NavigationPanelHeader>
      <NavigationPanelBody>
        <NavigationPanelContent className="openbitfun-settings-nav__content">
          {isSearchMode ? (
            results.length ? (
              <div
                ref={resultsRef}
                id="settings-nav-results"
                className="openbitfun-settings-nav__search-results"
                data-openbitfun-component="settings-nav"
                data-openbitfun-part="searchResults"
                role="listbox"
                tabIndex={results.length ? 0 : undefined}
                onKeyDown={handleResultsKeyDown}
                aria-activedescendant={highlightedIndex >= 0
                  ? `settings-nav-result-${highlightedIndex}`
                  : undefined}
              >
                {results.map((row, index) => {
                  const active = activePageId === row.destination.pageId
                    && (!row.destination.viewId || row.destination.viewId === activeViewId)
                    && (!row.destination.sectionId || row.destination.sectionId === activeSectionId);
                  const selected = index === highlightedIndex;
                  const path = [row.categoryLabel, row.pageLabel, row.targetLabel].filter(Boolean).join(' › ');
                  return (
                    <NavigationPanelItem data-overflow-trigger
                      key={`${row.destination.pageId}:${row.destination.sectionId ?? row.destination.viewId ?? ''}`}
                      id={`settings-nav-result-${index}`}
                      role="option"
                      aria-selected={active}
                      selected={active}
                      data-openbitfun-component="settings-nav"
                      data-openbitfun-part="searchResult"
                      data-openbitfun-state={[active && 'active', selected && 'selected'].filter(Boolean).join(' ') || undefined}
                      className={[
                        'openbitfun-settings-nav__search-result-item',
                        selected && 'is-highlighted',
                        active && 'is-active',
                      ].filter(Boolean).join(' ')}
                      onClick={() => activate(row.destination, true)}
                      onMouseEnter={() => {
                        setHighlightedIndex(index);
                        preload(row.destination.pageId);
                      }}
                      onFocus={() => preload(row.destination.pageId)}
                    >
                      <span className="openbitfun-settings-nav__search-result-copy">
                        <OverflowText behavior="marquee" className="openbitfun-settings-nav__search-result-line">
                          {highlightFirstMatch(path, searchQuery)}
                        </OverflowText>
                        <OverflowText behavior="marquee" className="openbitfun-settings-nav__search-result-desc">
                          {highlightFirstMatch(row.description, searchQuery)}
                        </OverflowText>
                      </span>
                      {dirtyMarker(row.destination.pageId)}
                    </NavigationPanelItem>
                  );
                })}
              </div>
            ) : (
              <div className="openbitfun-settings-nav__search-empty" role="status" data-openbitfun-component="settings-nav" data-openbitfun-part="searchEmpty">
                {t('navigation.search.empty')}
              </div>
            )
          ) : SETTINGS_CATEGORIES.map((category) => (
            <NavigationPanelSection
              key={category.id}
              className="openbitfun-settings-nav__category"
              data-openbitfun-component="settings-nav"
              data-openbitfun-part="category"
              title={(
                <span
                  className="openbitfun-settings-nav__category-label"
                  data-openbitfun-component="settings-nav"
                  data-openbitfun-part="categoryHeader"
                >
                  {t(category.labelKey)}
                </span>
              )}
            >
              <div className="openbitfun-settings-nav__items" data-openbitfun-component="settings-nav" data-openbitfun-part="items">
                {category.pages.map((page) => (
                  <NavigationPanelItem data-overflow-trigger
                    key={page.id}
                    data-testid="settings-nav-page"
                    data-settings-page={page.id}
                    data-openbitfun-component="settings-nav"
                    data-openbitfun-part="item"
                    data-openbitfun-state={activePageId === page.id ? 'active' : undefined}
                    className="openbitfun-settings-nav__item"
                    selected={activePageId === page.id}
                    onClick={() => activate({ pageId: page.id })}
                    onPointerEnter={() => preload(page.id)}
                    onFocus={() => preload(page.id)}
                  >
                    <OverflowText className="openbitfun-settings-nav__item-label">{t(page.labelKey)}</OverflowText>
                    {dirtyMarker(page.id)}
                  </NavigationPanelItem>
                ))}
              </div>
            </NavigationPanelSection>
          ))}
        </NavigationPanelContent>
      </NavigationPanelBody>
    </NavigationPanel>
  );
};

export default SettingsNav;
