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
  Button,
  TabGroup,
  Icon,
  KeyHint,
  SearchField,
  type IconSource,
  ScrollArea,
  Dialog,
  DialogBody,
  Portal,
} from '@openbitfun/ui';
import { AlertCircle, BarChart3, Blocks, CheckSquare2, FileText, Keyboard, MessageSquareText, MessagesSquare, Network, Users } from 'lucide-react';
import { useShortcut } from '@/infrastructure/hooks/useShortcut';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { useMyAgentStore } from '@/app/scenes/my-agent/myAgentStore';
import { useNurseryStore } from '@/app/scenes/profile/nurseryStore';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
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
  if (group === 'workspaces' || group === 'assistants' || group === 'settings' || group === 'capabilities') return 'entity';
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
  const { t: tCapabilities } = useI18n('scenes/capabilities');
  const {
    currentWorkspace,
    openedWorkspacesList,
    setActiveWorkspace,
  } = useWorkspaceContext();
  const selectAssistantWorkspace = useMyAgentStore((state) => state.setSelectedAssistantWorkspaceId);
  const openAssistant = useNurseryStore((state) => state.openAssistant);
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState<GlobalSearchScope>('all');
  const surfaceScope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const peerDevice = usePeerDeviceModeOptional();
  const hostLabel = peerDevice?.peerMode.active
    ? peerDevice.peerMode.deviceName : tCommon('accountLogin.thisDevice');
  const [snapshotState, setSnapshotState] = useState({ epoch: surfaceScope.epoch, value: EMPTY_SNAPSHOT });
  const snapshot = snapshotState.epoch === surfaceScope.epoch ? snapshotState.value : EMPTY_SNAPSHOT;
  const setSnapshot = useCallback((value: GlobalSearchSnapshot) => {
    if (surfaceScope.isCurrent()) setSnapshotState({ epoch: surfaceScope.epoch, value });
  }, [surfaceScope]);
  const [retryRevision, setRetryRevision] = useState(0);
  const retryRef = useRef<{ context: string; providerId: string; previous: GlobalSearchSnapshot } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drilldownGroup, setDrilldownGroup] = useState<GlobalSearchDrilldownGroupId | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnosticsTriggerRef = useRef<HTMLButtonElement>(null);
  const diagnosticsPanelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputCompositionActiveRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId().replace(/:/g, '');
  const instanceId = `global-search-${generatedId || 'content'}`;
  const resultsId = `${instanceId}-results`;
  const diagnosticsId = `${instanceId}-diagnostics`;
  const diagnosticsTriggerId = `${diagnosticsId}-trigger`;
  const diagnosticsVisible = active && diagnosticsOpen && snapshot.diagnostics.length > 0;
  const diagnosticsLayout = useAnchoredPopoverPosition({
    open: diagnosticsVisible,
    anchorRef: diagnosticsTriggerRef,
    popoverRef: diagnosticsPanelRef,
    preferredPlacement: 'top',
    gap: 8,
    layoutRevision: snapshot.diagnostics,
  });
  const diagnosticsPositioned = diagnosticsLayout !== null;
  useEffect(() => {
    if (diagnosticsVisible && diagnosticsPositioned) diagnosticsPanelRef.current?.focus();
  }, [diagnosticsVisible, diagnosticsPositioned]);
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
  }, [active, initialQuery, setSnapshot]);

  const parsedQuery = useMemo(() => parseGlobalSearchQuery(query, scope), [query, scope]);

  const searchContext = JSON.stringify([
    surfaceScope.epoch, query, parsedQuery.scope, currentWorkspace?.id,
    openedWorkspacesList.map(workspace => [workspace.id, workspace.rootPath, workspace.connectionId]),
  ]);
  const retryProvider = (providerId: string) => {
    if (!surfaceScope.isCurrent() || snapshot.isSearching) return;
    retryRef.current = { context: searchContext, providerId, previous: snapshot };
    setRetryRevision(revision => revision + 1);
  };

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    surfaceScope.signal.addEventListener('abort', abort, { once: true });
    const requestedRetry = retryRef.current;
    retryRef.current = null;
    const retry = requestedRetry?.context === searchContext
      ? { previous: requestedRetry.previous, providerIds: [requestedRetry.providerId] } : undefined;
    const delay = parsedQuery.query ? SEARCH_DEBOUNCE_MS : 0;
    const timer = window.setTimeout(() => {
      if (!surfaceScope.isCurrent()) return;
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
          tCapabilities,
        },
        controller.signal,
        value => { if (!controller.signal.aborted) setSnapshot(value); },
        retry,
      );
    }, delay);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      surfaceScope.signal.removeEventListener('abort', abort);
    };
  }, [
    active,
    surfaceScope,
    searchContext,
    setSnapshot,
    retryRevision,
    currentWorkspace,
    openedWorkspacesList,
    parsedQuery.query,
    parsedQuery.scope,
    providers,
    query,
    tCommon,
    tSettings,
    tCapabilities,
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

  useEffect(() => {
    if (!active || snapshot.diagnostics.length === 0) {
      setDiagnosticsOpen(false);
    }
  }, [active, snapshot.diagnostics.length]);

  const handleRootKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    // The diagnostics layer owns Escape before the underlying group or dialog.
    if (diagnosticsVisible || isImeOwnedKeyboardEvent(event, inputCompositionActiveRef.current)) return;
    if (event.key !== 'Escape' || !drilldownGroup) return;
    event.preventDefault();
    event.stopPropagation();
    closeGroupDetails();
  }, [closeGroupDetails, diagnosticsVisible, drilldownGroup]);

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
              aria-haspopup="grid"
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
          role="grid"
          aria-busy={snapshot.isSearching}
          aria-label={tCommon('nav.search.resultsLabel')}
          data-openbitfun-component="global-search"
          data-openbitfun-part="results"
          data-search-state={parsedQuery.query ? 'query' : 'default'}
          data-search-view={drilldownGroup ?? 'overview'}
        >
          {navigableItems.length === 0 ? (
            <div role="row"><div role="gridcell">
              <div className="global-search__empty" role="status">
                {snapshot.isSearching ? tCommon('nav.search.searching') : emptyLabel}
              </div>
            </div></div>
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
                role="rowgroup"
                aria-labelledby={labelId}
                data-openbitfun-component="global-search"
                data-openbitfun-part="group"
                data-search-group={groupId}
                data-testid={groupDetailPage
                  ? `${testIdPrefix}-group-page-${groupId}`
                  : `${testIdPrefix}-group-${groupId}`}
              >
                <div role="row"><div role="columnheader">
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
                </div></div>
                <div
                  className="global-search__group-items"
                  role="presentation"
                  data-search-layout={parsedQuery.query && resultVariant(groupId) !== 'standard' ? 'cards' : undefined}
                >
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

                    // Grid cells keep executable buttons in the native accessibility tree.
                    // Listbox options flatten interactive descendants in WebKit.
                    const resultRow = (content: React.ReactNode) => (
                      <div role="row" key={item.id} className="global-search__result-row">
                        <div
                          role="gridcell"
                          id={`${instanceId}-option-${item.id}`}
                          data-search-result-id={item.id}
                          aria-selected={selected}
                          aria-label={[item.title, item.subtitle, item.context].filter(Boolean).join('. ')}
                        >{content}</div>
                      </div>
                    );

                    if (itemVariant === 'action') {
                      return resultRow(
                        <ActionCard
                          tabIndex={-1}
                          aria-label={item.title}
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
                      return resultRow(
                        <ActionCard
                          tabIndex={-1}
                          aria-label={item.title}
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

                    return resultRow(
                      <button data-overflow-trigger
                        type="button"
                        tabIndex={-1}
                        aria-label={item.title}
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
            <div
              className="global-search__diagnostics"
              data-testid={`${testIdPrefix}-partial-status`}
            >
              <Button
                ref={diagnosticsTriggerRef}
                id={diagnosticsTriggerId}
                className="global-search__diagnostics-summary"
                variant="text"
                size="xs"
                aria-haspopup="dialog"
                aria-expanded={diagnosticsVisible}
                aria-controls={diagnosticsVisible ? diagnosticsId : undefined}
                leadingIcon={<AlertCircle size={13} aria-hidden="true" className="global-search__diagnostics-icon" />}
                onClick={() => setDiagnosticsOpen(open => !open)}
              >
                {tCommon('nav.search.partialUnavailable')}
              </Button>
              {diagnosticsVisible ? (
                <Portal
                  ownerRef={diagnosticsTriggerRef}
                  surfaceRef={diagnosticsPanelRef}
                  open={diagnosticsVisible}
                  dismissOnPointerOutside
                  onDismiss={(reason) => {
                    if (reason === 'escape-key') diagnosticsTriggerRef.current?.focus();
                    setDiagnosticsOpen(false);
                  }}
                >
                  <div
                    ref={diagnosticsPanelRef}
                    id={diagnosticsId}
                    role="dialog"
                    aria-labelledby={diagnosticsTriggerId}
                    tabIndex={-1}
                    className="global-search__diagnostics-panel"
                    data-openbitfun-native-webview-occlusion
                    style={{
                      left: diagnosticsLayout?.left ?? 0,
                      top: diagnosticsLayout?.top ?? 0,
                      visibility: diagnosticsLayout ? 'visible' : 'hidden',
                    }}
                  >
                    <div className="global-search__diagnostic-target">
                      {tCommon('nav.search.diagnosticTarget', { host: hostLabel })}
                    </div>
                    {snapshot.diagnostics.map((diagnostic, index) => (
                      <div className="global-search__diagnostic" key={`${diagnostic.providerId}:${diagnostic.code}:${index}`}>
                        <div className="global-search__diagnostic-header">
                          <strong>{providers.find(provider => provider.id === diagnostic.providerId)?.groups
                            .map(group => tCommon(`nav.search.groups.${group}`)).join(' / ') ?? diagnostic.providerId}</strong>
                          {diagnostic.workspaceName ? <div>{diagnostic.workspaceName} · {diagnostic.hostLabel ?? hostLabel}</div> : null}
                        </div>
                        {diagnostic.workspacePath ? <div className="global-search__diagnostic-path">{diagnostic.workspacePath}</div> : null}
                        <p>{diagnostic.message}</p>
                        {diagnostic.retryable !== false ? (
                          <Button size="sm" variant="outline" disabled={snapshot.isSearching}
                            onClick={() => retryProvider(diagnostic.providerId)}>
                            {tCommon('nav.search.retrySource')}
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </Portal>
              ) : null}
            </div>
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
      overlayProps={{ className: 'global-search-overlay' }}
      data-testid="global-search-dialog"
    >
      <div className="global-search-dialog__material" aria-hidden="true" />
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
