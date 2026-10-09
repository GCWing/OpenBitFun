import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { OverflowText,
  ActionCard,
  TabGroup,
  Icon,
  KeyHint,
  SearchField,
  type IconSource,
  ScrollArea,
  Dialog,
  DialogBody,
} from '@openbitfun/ui';
import { BarChart3, Blocks, CheckSquare2, FileText, Keyboard, MessageSquareText, MessagesSquare, Network, Users } from 'lucide-react';
import { useShortcut } from '@/infrastructure/hooks/useShortcut';
import { useI18n } from '@/infrastructure/i18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { useMyAgentStore } from '@/app/scenes/my-agent/myAgentStore';
import { useNurseryStore } from '@/app/scenes/profile/nurseryStore';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { activateGlobalSearchTarget } from './globalSearchActivator';
import { runFederatedSearch } from './federatedSearchEngine';
import { globalSearchRegistry } from './globalSearchRegistry';
import {
  getGlobalSearchShortcutLabel,
  GLOBAL_SEARCH_SHORTCUT,
  splitGlobalSearchShortcutLabel,
  subscribeGlobalSearchShortcut,
} from './globalSearchShortcut';
import { useGlobalSearchStore } from './globalSearchStore';
import {
  PRODUCT_ACTION_CATALOG,
  type ProductActionIcon,
  type ProductActionId,
} from './productActionCatalog';
import {
  buildGlobalSearchResultPresentation,
  type GlobalSearchDrilldownGroupId,
} from './globalSearchResultPresentation';
import { parseGlobalSearchQuery } from './searchMatching';
import {
  type GlobalSearchGroupId,
  type GlobalSearchItem,
  type GlobalSearchScope,
  type GlobalSearchSnapshot,
} from './types';
import './GlobalSearchRoot.scss';

const log = createLogger('GlobalSearch');
const SEARCH_DEBOUNCE_MS = 90;
const SEARCH_LIMIT_PER_GROUP = 20;
const SEARCH_QUERY_MAX_LENGTH = 512;

const EMPTY_SNAPSHOT: GlobalSearchSnapshot = {
  items: [],
  providerStatus: {},
  diagnostics: [],
  isSearching: false,
  truncated: false,
};

const ACTION_ICONS: Record<ProductActionIcon, IconSource> = {
  'message-circle': { name: 'side-chat' },
  folder: { name: 'folder' },
  plus: { name: 'plus' },
  globe: { name: 'browser' },
  terminal: { name: 'terminal' },
  files: { glyph: FileText },
  users: { glyph: Users },
  'book-open': { name: 'book-open' },
  blocks: { glyph: Blocks },
  'check-square': { glyph: CheckSquare2 },
  chart: { glyph: BarChart3 },
  gear: { name: 'gear' },
  keyboard: { glyph: Keyboard },
  network: { glyph: Network },
};

type GlobalSearchActionIconRole =
  | 'new-session'
  | 'open-browser'
  | 'open-terminal'
  | 'open-project'
  | 'new-project'
  | 'open-files';

/**
 * Global Search uses color to distinguish its six primary actions. Role names
 * keep the mapping stable without leaking the current hues into product data.
 */
const GLOBAL_SEARCH_ACTION_ICON_ROLES: Partial<Record<ProductActionId, GlobalSearchActionIconRole>> = {
  'session.new': 'new-session',
  'surface.browser.open': 'open-browser',
  'surface.terminal.open': 'open-terminal',
  'project.open': 'open-project',
  'project.new': 'new-project',
  'surface.files.open': 'open-files',
};

const GROUP_ICONS: Record<Exclude<GlobalSearchGroupId, 'actions'>, IconSource> = {
  messages: { glyph: MessageSquareText },
  sessions: { glyph: MessagesSquare },
  files: { glyph: FileText },
  workspaces: { name: 'folder' },
  assistants: { name: 'user' },
  capabilities: { glyph: Blocks },
  settings: { name: 'gear' },
};

const SEARCH_ICON: IconSource = { name: 'search' };
const USER_ICON: IconSource = { name: 'user' };

function iconForItem(item: GlobalSearchItem): IconSource {
  if (item.target.kind === 'action') {
    const actionId = item.target.actionId;
    const action = PRODUCT_ACTION_CATALOG.find((candidate) => candidate.id === actionId);
    return action ? ACTION_ICONS[action.icon] : SEARCH_ICON;
  }
  if (item.target.kind === 'assistant') return USER_ICON;
  return GROUP_ICONS[item.group as Exclude<GlobalSearchGroupId, 'actions'>] ?? SEARCH_ICON;
}

function resultVariant(group: GlobalSearchGroupId): 'action' | 'entity' | 'standard' {
  if (group === 'actions') return 'action';
  if (group === 'workspaces' || group === 'assistants') return 'entity';
  return 'standard';
}

export interface GlobalSearchContentProps {
  /** Suspend provider work while the owning surface is not active. */
  active?: boolean;
  /** Focus the query field when this surface is mounted. */
  autoFocus?: boolean;
  /** Query supplied by the owning entry point. */
  initialQuery?: string;
  /** Runs before a result is activated, for example to dismiss a modal. */
  onBeforeActivate?: () => void;
  /** Adapts the shared search content to its host surface. */
  variant?: 'modal' | 'embedded';
}

export const GlobalSearchContent: React.FC<GlobalSearchContentProps> = ({
  active = true,
  autoFocus = false,
  initialQuery = '',
  onBeforeActivate,
  variant = 'embedded',
}) => {
  const { t: tCommon } = useI18n('common');
  const { t: tSettings } = useI18n('settings');
  const {
    currentWorkspace,
    openedWorkspacesList,
    setActiveWorkspace,
  } = useWorkspaceContext();
  const selectAssistantWorkspace = useMyAgentStore((state) => state.setSelectedAssistantWorkspaceId);
  const openAssistant = useNurseryStore((state) => state.openAssistant);
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState<GlobalSearchScope>('all');
  const [snapshot, setSnapshot] = useState<GlobalSearchSnapshot>(EMPTY_SNAPSHOT);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drilldownGroup, setDrilldownGroup] = useState<GlobalSearchDrilldownGroupId | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputCompositionActiveRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId().replace(/:/g, '');
  const instanceId = `global-search-${generatedId || 'content'}`;
  const resultsId = `${instanceId}-results`;
  const testIdPrefix = variant === 'modal' ? 'global-search' : 'embedded-global-search';
  const providers = useSyncExternalStore(
    globalSearchRegistry.subscribe,
    globalSearchRegistry.getSnapshot,
    globalSearchRegistry.getSnapshot,
  );
  const searchShortcutLabel = useSyncExternalStore(
    subscribeGlobalSearchShortcut,
    getGlobalSearchShortcutLabel,
    getGlobalSearchShortcutLabel,
  );
  const searchShortcutHint = splitGlobalSearchShortcutLabel(searchShortcutLabel);

  useEffect(() => {
    if (!active) return;
    setQuery(initialQuery);
    setScope('all');
    setActiveId(null);
    setDrilldownGroup(null);
    setSnapshot(EMPTY_SNAPSHOT);
  }, [active, initialQuery]);

  const parsedQuery = useMemo(() => parseGlobalSearchQuery(query, scope), [query, scope]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const delay = parsedQuery.query ? SEARCH_DEBOUNCE_MS : 0;
    const timer = window.setTimeout(() => {
      void runFederatedSearch(
        providers,
        {
          rawQuery: query,
          query: parsedQuery.query,
          scope: parsedQuery.scope,
          workspaces: openedWorkspacesList,
          currentWorkspace,
          limitPerGroup: SEARCH_LIMIT_PER_GROUP,
          tCommon,
          tSettings,
        },
        controller.signal,
        setSnapshot,
      );
    }, delay);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    active,
    currentWorkspace,
    openedWorkspacesList,
    parsedQuery.query,
    parsedQuery.scope,
    providers,
    query,
    tCommon,
    tSettings,
  ]);

  const items = snapshot.items;
  const resultPresentation = useMemo(
    () => buildGlobalSearchResultPresentation(items, {
      hasQuery: Boolean(parsedQuery.query),
      drilldownGroup,
    }),
    [drilldownGroup, items, parsedQuery.query],
  );
  const navigableItems = resultPresentation.navigableItems;
  const activeIndex = activeId
    ? navigableItems.findIndex((item) => item.id === activeId)
    : -1;

  useEffect(() => {
    if (activeId && !navigableItems.some((item) => item.id === activeId)) {
      setActiveId(null);
    }
  }, [activeId, navigableItems]);

  useEffect(() => {
    if (!activeId) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-search-result-id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const activateItem = useCallback(async (item: GlobalSearchItem) => {
    onBeforeActivate?.();
    try {
      await activateGlobalSearchTarget(item.target, {
        setActiveWorkspace,
        selectAssistantWorkspace,
        openAssistant,
        tCommon,
      });
    } catch (error) {
      log.warn('Failed to activate global search target', {
        providerId: item.providerId,
        targetKind: item.target.kind,
        error,
      });
      notificationService.error(tCommon('nav.search.errors.activationFailed'), { duration: 5000 });
    }
  }, [onBeforeActivate, openAssistant, selectAssistantWorkspace, setActiveWorkspace, tCommon]);

  const handleInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      (event.key === 'Enter' || event.key === 'Escape')
      && isImeOwnedKeyboardEvent(event, inputCompositionActiveRef.current)
    ) {
      event.stopPropagation();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = Math.min(navigableItems.length - 1, Math.max(0, activeIndex + 1));
      setActiveId(navigableItems[nextIndex]?.id ?? null);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = Math.max(0, activeIndex <= 0 ? 0 : activeIndex - 1);
      setActiveId(navigableItems[nextIndex]?.id ?? null);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveId(navigableItems[0]?.id ?? null);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveId(navigableItems.at(-1)?.id ?? null);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = navigableItems[activeIndex >= 0 ? activeIndex : 0];
      if (item) void activateItem(item);
    }
  }, [activateItem, activeIndex, navigableItems]);

  const focusSearchInput = useCallback(() => {
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const openGroupDetails = useCallback((groupId: GlobalSearchDrilldownGroupId) => {
    setDrilldownGroup(groupId);
    setActiveId(null);
    listRef.current?.scrollTo({ top: 0 });
    focusSearchInput();
  }, [focusSearchInput]);

  const closeGroupDetails = useCallback(() => {
    setDrilldownGroup(null);
    setActiveId(null);
    listRef.current?.scrollTo({ top: 0 });
    focusSearchInput();
  }, [focusSearchInput]);

  const handleRootKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeOwnedKeyboardEvent(event, inputCompositionActiveRef.current)) return;
    if (event.key !== 'Escape' || !drilldownGroup) return;
    event.preventDefault();
    event.stopPropagation();
    closeGroupDetails();
  }, [closeGroupDetails, drilldownGroup]);

  const effectiveScope = parsedQuery.scope;
  const emptyLabel = effectiveScope === 'content' && parsedQuery.query.length < 2
    ? tCommon('nav.search.typeMoreForContent')
    : tCommon('nav.search.empty');

  return (
      <div
        className={`global-search global-search--${variant}`}
        data-openbitfun-component="global-search"
        data-openbitfun-part="root"
        data-search-surface={variant}
        data-search-view={drilldownGroup ?? 'overview'}
        data-testid={variant === 'embedded' ? 'embedded-global-search' : undefined}
        onKeyDownCapture={handleRootKeyDownCapture}
      >
        <header className="global-search__header">
          <div
            className="global-search__query-system-shell"
            data-openbitfun-component="global-search"
            data-openbitfun-part="query"
          >
            <SearchField
              ref={inputRef}
              className="global-search__query global-search__query--system"
              value={query}
              onValueChange={(nextQuery) => {
                setQuery(nextQuery);
                setDrilldownGroup(null);
              }}
              onKeyDown={handleInputKeyDown}
              onCompositionStart={() => {
                inputCompositionActiveRef.current = true;
              }}
              onCompositionEnd={() => {
                inputCompositionActiveRef.current = false;
              }}
              onClear={query ? () => {
                setQuery('');
                setDrilldownGroup(null);
                inputRef.current?.focus();
              } : undefined}
              clearLabel={query ? tCommon('nav.search.clear') : undefined}
              leadingIcon={<Icon name="search" />}
              shortcut={query ? undefined : (
                <KeyHint icon={searchShortcutHint.modifier}>
                  {searchShortcutHint.key}
                </KeyHint>
              )}
              size={variant === 'modal' ? 'sm' : 'md'}
              placeholder={tCommon('nav.search.inputPlaceholder')}
              aria-label={tCommon('nav.search.inputLabel')}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={resultsId}
              aria-activedescendant={activeId ? `${instanceId}-option-${activeId}` : undefined}
              maxLength={SEARCH_QUERY_MAX_LENGTH}
              autoFocus={autoFocus}
            />
          </div>

          <div className="global-search__scope-bar" data-openbitfun-component="global-search" data-openbitfun-part="scopeBar">
            <TabGroup
              className="global-search__scopes"
              size="sm"
              value={effectiveScope}
              items={(['all', 'actions', 'content'] as const).map((candidate) => ({
                value: candidate,
                label: tCommon(`nav.search.scopes.${candidate}`),
                disabled: parsedQuery.scopeForcedByPrefix && candidate !== 'actions',
              }))}
              onValueChange={(candidate) => {
                setScope(candidate as GlobalSearchScope);
                setDrilldownGroup(null);
              }}
            />
          </div>
        </header>

        <ScrollArea
          ref={listRef}
          id={resultsId}
          className="global-search__results"
          role="listbox"
          aria-label={tCommon('nav.search.resultsLabel')}
          data-openbitfun-component="global-search"
          data-openbitfun-part="results"
          data-search-state={parsedQuery.query ? 'query' : 'default'}
          data-search-view={drilldownGroup ?? 'overview'}
        >
          {navigableItems.length === 0 ? (
            <div className="global-search__empty" role="status">
              {snapshot.isSearching ? tCommon('nav.search.searching') : emptyLabel}
            </div>
          ) : resultPresentation.groups.map((groupView) => {
            const groupId = groupView.id;
            const groupItems = groupView.items;
            const labelId = `${instanceId}-group-${groupId}`;
            const defaultActionGroup = groupId === 'actions' && !parsedQuery.query;
            const groupLabel = defaultActionGroup
              ? tCommon('nav.search.groups.frequentActions')
              : tCommon(`nav.search.groups.${groupId}`);
            const groupDetailPage = drilldownGroup === groupId;
            return (
              <section
                key={groupId}
                className={`global-search__group global-search__group--${groupId}${groupDetailPage ? ' global-search__group--detail' : ''}`}
                role="group"
                aria-labelledby={labelId}
                data-openbitfun-component="global-search"
                data-openbitfun-part="group"
                data-search-group={groupId}
                data-testid={groupDetailPage
                  ? `${testIdPrefix}-group-page-${groupId}`
                  : `${testIdPrefix}-group-${groupId}`}
              >
                {groupDetailPage ? (
                  <div className="global-search__detail-header">
                    <button
                      type="button"
                      className="global-search__detail-back"
                      onClick={closeGroupDetails}
                      aria-label={tCommon('nav.search.backToOverview')}
                      data-testid={`${testIdPrefix}-group-back`}
                    >
                      <Icon name="chevron-left" size="lg" aria-hidden="true" style={{ width: 15, height: 15 }} />
                      <span>{tCommon('nav.search.back')}</span>
                    </button>
                    <div className="global-search__detail-heading">
                      <span id={labelId} className="global-search__group-title">{groupLabel}</span>
                      <span className="global-search__group-count">
                        {tCommon('nav.search.resultCount', { count: groupView.totalCount })}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div id={labelId} className="global-search__group-label">
                    <span className="global-search__group-title">{groupLabel}</span>
                    <span className="global-search__group-meta">
                      {groupView.canOpenDetails ? (
                        <button
                          type="button"
                          className="global-search__group-drilldown"
                          onClick={() => openGroupDetails(groupId as GlobalSearchDrilldownGroupId)}
                          aria-label={tCommon('nav.search.openGroup', {
                            group: groupLabel,
                            count: groupView.totalCount,
                          })}
                          data-testid={`${testIdPrefix}-group-drilldown-${groupId}`}
                        >
                          <span>{tCommon('nav.search.resultCount', { count: groupView.totalCount })}</span>
                          <Icon name="chevron-right" size="sm" aria-hidden="true" />
                        </button>
                      ) : (
                        <span aria-hidden="true">
                          {tCommon('nav.search.resultCount', { count: groupView.totalCount })}
                        </span>
                      )}
                    </span>
                  </div>
                )}
                <div className="global-search__group-items">
                  {groupItems.map((item) => {
                    const itemIcon = iconForItem(item);
                    const selected = item.id === activeId;
                    const itemVariant = resultVariant(item.group);
                    const entity = itemVariant === 'entity';
                    const actionIconRole = item.target.kind === 'action'
                      ? GLOBAL_SEARCH_ACTION_ICON_ROLES[item.target.actionId]
                      : undefined;
                    const resultCopy = (
                      <span className="global-search__result-copy">
                        <span className="global-search__result-title-row">
                          <OverflowText className="global-search__result-title">{item.title}</OverflowText>
                          {item.badge ? <span className="global-search__badge">{item.badge}</span> : null}
                        </span>
                        {item.subtitle && !(defaultActionGroup && itemVariant === 'action') ? (
                          <OverflowText className="global-search__result-subtitle">{item.subtitle}</OverflowText>
                        ) : null}
                      </span>
                    );

                    if (itemVariant === 'action') {
                      return (
                        <ActionCard
                          key={item.id}
                          id={`${instanceId}-option-${item.id}`}
                          data-search-result-id={item.id}
                          role="option"
                          aria-selected={selected}
                          className="global-search__action-card"
                          onClick={() => void activateItem(item)}
                          data-openbitfun-state={selected ? 'selected' : undefined}
                          description={item.subtitle && !defaultActionGroup ? item.subtitle : undefined}
                          leading={(
                            <Icon
                              {...itemIcon}
                              className="global-search__action-icon"
                              data-icon-role={actionIconRole}
                            />
                          )}
                          selected={selected}
                          size="sm"
                        >
                          <span className="global-search__action-card-title-row">
                            <span>{item.title}</span>
                            {item.badge ? <span className="global-search__badge">{item.badge}</span> : null}
                          </span>
                        </ActionCard>
                      );
                    }

                    if (entity) {
                      return (
                        <ActionCard
                          key={item.id}
                          id={`${instanceId}-option-${item.id}`}
                          data-search-result-id={item.id}
                          role="option"
                          aria-selected={selected}
                          className="global-search__action-card"
                          onClick={() => void activateItem(item)}
                          data-openbitfun-state={selected ? 'selected' : undefined}
                          description={item.subtitle}
                          leading={<Icon {...itemIcon} />}
                          selected={selected}
                          size="md"
                        >
                          <span className="global-search__action-card-title-row">
                            <span>{item.title}</span>
                            {item.badge ? <span className="global-search__badge">{item.badge}</span> : null}
                          </span>
                        </ActionCard>
                      );
                    }

                    return (
                      <button data-overflow-trigger
                        key={item.id}
                        id={`${instanceId}-option-${item.id}`}
                        data-search-result-id={item.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`global-search__result global-search__result--${itemVariant}${selected ? ' is-selected' : ''}`}
                        onClick={() => void activateItem(item)}
                        data-openbitfun-component="global-search"
                        data-openbitfun-part="result"
                        data-openbitfun-state={selected ? 'selected' : undefined}
                      >
                        <span className="global-search__result-icon" aria-hidden="true">
                          <Icon {...itemIcon} size="md" />
                        </span>
                        {resultCopy}
                        {item.context ? (
                          <OverflowText className="global-search__result-context">{item.context}</OverflowText>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </ScrollArea>

        {(Boolean(parsedQuery.query)
          || Boolean(drilldownGroup)
          || snapshot.diagnostics.length > 0) ? (
        <footer className="global-search__footer" data-openbitfun-component="global-search" data-openbitfun-part="footer">
          {snapshot.diagnostics.length > 0 ? (
            <OverflowText
              className="global-search__footer-status"
              role="status"
              data-testid={`${testIdPrefix}-partial-status`}
            >
              {tCommon('nav.search.partialUnavailable')}
            </OverflowText>
          ) : null}
          <span className="global-search__footer-keys" aria-hidden="true">
            <KeyHint>↑↓</KeyHint> {tCommon('nav.search.footer.navigate')}
            <KeyHint>↵</KeyHint> {tCommon('nav.search.footer.open')}
            {variant === 'modal' || drilldownGroup ? (
              <>
                <KeyHint>Esc</KeyHint>{' '}
                {tCommon(drilldownGroup ? 'nav.search.footer.back' : 'nav.search.footer.close')}
              </>
            ) : null}
          </span>
        </footer>
        ) : null}
      </div>
  );
};

const GlobalSearchRoot: React.FC = () => {
  const { t: tCommon } = useI18n('common');
  const open = useGlobalSearchStore((state) => state.open);
  const initialQuery = useGlobalSearchStore((state) => state.initialQuery);
  const closeSearch = useGlobalSearchStore((state) => state.closeSearch);
  const toggleSearch = useGlobalSearchStore((state) => state.toggleSearch);

  useShortcut(
    GLOBAL_SEARCH_SHORTCUT.id,
    GLOBAL_SEARCH_SHORTCUT.config,
    toggleSearch,
    { priority: 20, description: GLOBAL_SEARCH_SHORTCUT.descriptionKey },
  );

  useEffect(() => {
    const handleSecondaryShortcut = (event: KeyboardEvent) => {
      if (
        !event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || event.key.toLocaleLowerCase() !== 'f'
      ) {
        return;
      }
      event.preventDefault();
      toggleSearch();
    };
    document.addEventListener('keydown', handleSecondaryShortcut);
    return () => document.removeEventListener('keydown', handleSecondaryShortcut);
  }, [toggleSearch]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) closeSearch(); }}
      size="xl"
      aria-label={tCommon('nav.search.dialogLabel')}
      className="global-search-dialog"
      data-testid="global-search-dialog"
    >
      <DialogBody className="global-search-modal-content">
        <GlobalSearchContent
          active={open}
          autoFocus
          initialQuery={initialQuery}
          onBeforeActivate={closeSearch}
          variant="modal"
        />
      </DialogBody>
    </Dialog>
  );
};

export default GlobalSearchRoot;
