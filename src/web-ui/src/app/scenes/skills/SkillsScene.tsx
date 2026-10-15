import {
  Button,
  ConfirmDialog,
  Empty,
  Icon,
  IconButton,
  LoadingState,
  OverflowText,
  ScrollArea,
  SearchField,
  Select,
  StatusPill,
  Switch,
  Tooltip,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, FolderOpen, ShieldAlert } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';

import type { SkillInfo, SkillMarketItem } from '@/infrastructure/config/types';
import { installedSkillMarketIds, isSkillMarketItemInstalled } from '@/infrastructure/config/skillMarketInstallation';
import {
  buildSkillCoverageSourceMap,
  canDeleteSkill,
  findSkillByKey,
  getSkillSourceLabel,
} from '@/infrastructure/config/skillSourcePresentation';
import { systemAPI, workspaceAPI } from '@/infrastructure/api';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { useNotification } from '@/shared/notification-system';
import { isRemoteWorkspace } from '@/shared/types';
import { createLogger } from '@/shared/utils/logger';
import { useInstalledSkills } from './hooks/useInstalledSkills';
import { useSkillsPagination } from './hooks/useSkillsPagination';
import { useSkillsPageLayout } from './hooks/useSkillsPageLayout';
import { SkillsPagination } from './components/SkillsPagination';
import { useSkillMarket } from './hooks/useSkillMarket';
import { SkillMarketSettings } from '@/infrastructure/config/components/SkillMarketSettings';
import SkillCard from './components/SkillCard';
import { SkillsGrid } from './components/SkillsGrid';
import { AddSkillDialog } from './components/AddSkillDialog';
import SkillGroupsView from './components/SkillGroupsView';
import { useUserSkillGroups } from '@/features/skill-groups/useUserSkillGroups';
import { resolveSkillGroups } from '@/features/skill-groups/skillGroups';
import './SkillsScene.scss';
import { useSkillsSceneStore, type SkillsView, type SkillTab } from './skillsSceneStore';
import { formatSkillDetailPath } from './skillDetailPath';
import { useGallerySceneAutoRefresh } from '@/app/hooks/useGallerySceneAutoRefresh';

const log = createLogger('SkillsScene');

interface CategoryInfo {
  id: SkillsView;
  labelKey: string;
  sourceLabel?: string;
}

const CATEGORIES: CategoryInfo[] = [
  {
    id: 'all',
    labelKey: 'filters.all',
  },
  {
    id: 'builtin',
    labelKey: 'filters.builtin',
  },
  {
    id: 'user',
    labelKey: 'filters.user',
  },
  {
    id: 'project',
    labelKey: 'filters.project',
  },
  {
    id: 'groups',
    labelKey: 'filters.groups',
  },
];

const SkillsScene: React.FC = () => {
  const { t, formatNumber } = useI18n('scenes/skills');
  const { t: tComponents } = useI18n('components');
  const { t: tSettings } = useI18n('settings/skills');
  const { t: tCommon } = useI18n('common');
  const notification = useNotification();
  const peerDevice = usePeerDeviceModeOptional();
  const remoteConnectionActive = peerDevice?.peerMode.active === true;
  const desktopConfigAvailable = isTauriRuntime() && !remoteConnectionActive;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const installedListRef = useRef<HTMLDivElement>(null);
  const marketListRef = useRef<HTMLDivElement>(null);
  const [marketPageSize, setMarketPageSize] = useState(10);
  const focusPage = useRef(false);
  const {
    nativeNavigationRequest,
    nativeNavigationTarget,
    searchDraft,
    marketQuery,
    installedView,
    isAddFormOpen,
    setSearchDraft,
    submitMarketQuery,
    setInstalledView,
    setAddFormOpen,
    toggleAddForm,
  } = useSkillsSceneStore();

  const [marketSettingsOpen, setMarketSettingsOpen] = useState(false);
  useEffect(() => { if (!desktopConfigAvailable) setMarketSettingsOpen(false); }, [desktopConfigAvailable]);
  const [activeTab, setActiveTab] = useState<SkillTab>('installed');
  const [deleteTarget, setDeleteTarget] = useState<SkillInfo | null>(null);
  const [installedSearch, setInstalledSearch] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [selectedDetail, setSelectedDetail] = useState<
    | { type: 'installed'; skillKey: string }
    | { type: 'market'; skill: SkillMarketItem }
    | null
  >(null);

  useEffect(() => {
    if (!nativeNavigationRequest) return;
    // Unsupported hosts use the installed panel's explicit availability message.
    setActiveTab(desktopConfigAvailable ? nativeNavigationTarget : 'installed');
    setInstalledSearch('');
    setSelectedDetail(null);
  }, [nativeNavigationRequest, nativeNavigationTarget, desktopConfigAvailable]);

  const installed = useInstalledSkills({
    searchQuery: installedSearch,
    activeFilter: installedView === 'groups' ? 'all' : installedView,
    enabled: desktopConfigAvailable,
  });

  useEffect(() => {
    setGroupSearch('');
  }, [activeTab, installedView, installed.catalogContextKey]);

  const skillGroups = useUserSkillGroups(desktopConfigAvailable);
  const groupSkills = useMemo(() => installed.catalogReady ? installed.skills.map(skill => ({
    ...skill,
    sourceLabel: getSkillSourceLabel(skill, t('list.item.unknownSource')),
    runtimeStatus: installed.globallyDisabledSkillKeys.has(skill.key)
      ? t('groups.globalDisabled')
      : skill.isShadowed ? t('list.item.shadowed') : undefined,
  })) : [], [installed.catalogReady, installed.skills, installed.globallyDisabledSkillKeys, t]);
  const skillGroupCount = useMemo(() => resolveSkillGroups(groupSkills, skillGroups.groups, {
    builtin: key => key, other: '',
  }).length, [groupSkills, skillGroups.groups]);

  const installedMarketIds = useMemo(
    () => installedSkillMarketIds(installed.skills),
    [installed.skills],
  );
  const coverageSourceBySkillKey = useMemo(
    () => buildSkillCoverageSourceMap(installed.skills, t('list.item.unknownSource')),
    [installed.skills, t],
  );
  const selectedInstalledSkill = useMemo(
    () => findSkillByKey(
      installed.skills,
      selectedDetail?.type === 'installed' ? selectedDetail.skillKey : null,
    ),
    [installed.skills, selectedDetail],
  );
  const selectedMarketSkill = selectedDetail?.type === 'market' ? selectedDetail.skill : null;
  const detailDescription = (selectedInstalledSkill?.description ?? selectedMarketSkill?.description)?.trim();
  const isSelectedMarketSkillInstalled = selectedMarketSkill
    ? isSkillMarketItemInstalled(selectedMarketSkill, installedMarketIds)
    : false;
  const selectedSkillPathSegments = formatSkillDetailPath(selectedInstalledSkill?.path ?? '')
    .split(/(?<=[\\/])/);

  useEffect(() => {
    if (selectedDetail?.type === 'installed' && !installed.loading && !selectedInstalledSkill) {
      setSelectedDetail(null);
    }
  }, [installed.loading, selectedDetail, selectedInstalledSkill]);

  useEffect(() => {
    if (desktopConfigAvailable) {
      return;
    }
    setActiveTab('installed');
    setAddFormOpen(false);
    setDeleteTarget(null);
    setSelectedDetail(null);
  }, [desktopConfigAvailable, setAddFormOpen]);

  const market = useSkillMarket({
    searchQuery: marketQuery,
    installedMarketIds,
    pageSize: marketPageSize,
    enabled: desktopConfigAvailable,
    onInstalledChanged: async () => {
      await installed.loadSkills(true);
    },
  });
  const installedSkillAriaLabel = useCallback((skill: SkillInfo) => {
    const source = getSkillSourceLabel(skill, t('list.item.unknownSource'));
    const scope = market.isRemoteWorkspace
      ? skill.level === 'user'
        ? t('list.item.localUser')
        : t('list.item.remoteProject')
      : skill.level === 'user'
        ? t('list.item.user')
        : t('list.item.project');
    return [
      skill.name,
      source,
      scope,
      installed.canToggleSkill(skill)
        ? installed.globallyDisabledSkillKeys.has(skill.key)
          ? t('list.item.globalDisabled')
          : t('list.item.globalEnabled')
        : null,
      skill.isShadowed
        ? t('list.item.shadowedTooltip', {
            source: coverageSourceBySkillKey.get(skill.key) ?? t('list.item.unknownSource'),
          })
        : null,
    ].filter(Boolean).join('. ');
  }, [coverageSourceBySkillKey, installed, market.isRemoteWorkspace, t]);

  const refetchSkillsScene = useCallback(async () => {
    await Promise.all([installed.loadSkills(true), market.refresh(), skillGroups.reload()]);
  }, [installed, market, skillGroups]);

  useGallerySceneAutoRefresh({
    sceneId: 'skills',
    refetch: refetchSkillsScene,
  });

  const canRevealSkillPath = !isRemoteWorkspace(workspaceManager.getState().currentWorkspace);

  const handleRevealSkillPath = useCallback(
    async (path: string) => {
      if (!canRevealSkillPath || !path.trim()) {
        return;
      }
      try {
        await workspaceAPI.revealInExplorer(path);
      } catch (error) {
        log.error('Failed to reveal skill path in explorer', { path, error });
        notification.error(t('messages.revealPathFailed', { error: String(error) }));
      }
    },
    [canRevealSkillPath, notification, t],
  );

  const handleCopySkillPath = useCallback(async (path: string) => {
    try {
      await systemAPI.setClipboard(path);
      notification.success(tCommon('contextMenu.status.copyPathSuccess'));
    } catch (error) {
      log.error('Failed to copy skill path', { path, error });
      notification.error(t('messages.copyPathFailed', { error: String(error) }));
    }
  }, [notification, t, tCommon]);

  const installedFiltered = installed.filteredSkills;
  const installedLoadFailed = Boolean(installed.error)
    || (installed.skills.length === 0 && installed.diagnostics.length > 0);
  const installedPageLayout = useSkillsPageLayout({
    viewportRef: scrollRef,
    contentRef,
    gridRef: installedListRef,
    total: installedFiltered.length,
    enabled: desktopConfigAvailable && activeTab === 'installed' && installedView !== 'groups'
      && !installed.loading && !installedLoadFailed,
  });

  const marketPageLayout = useSkillsPageLayout({
    viewportRef: scrollRef,
    contentRef,
    gridRef: marketListRef,
    total: market.totalLoaded,
    hasMore: market.hasMore,
    enabled: desktopConfigAvailable && activeTab === 'discover' && !market.marketLoading && !market.marketError,
  });
  useLayoutEffect(() => {
    setMarketPageSize(marketPageLayout.pageSize);
  }, [marketPageLayout.pageSize]);

  const installedPageKey = JSON.stringify([
    installed.catalogContextKey, installedView, installedSearch.trim().toLowerCase(),
    nativeNavigationRequest,
  ]);
  const installedPagination = useSkillsPagination(
    installedFiltered, installedPageKey, installed.catalogReady, installedPageLayout.pageSize,
  );
  const visibleMarketPage = activeTab === 'discover' ? market.currentPage : 0;
  const visibleInstalledPage = activeTab === 'installed' ? installedPagination.page : 0;
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (focusPage.current) {
      (activeTab === 'installed' ? installedListRef : marketListRef).current?.focus({ preventScroll: true });
      focusPage.current = false;
    }
  }, [activeTab, installedView, nativeNavigationRequest, visibleMarketPage, visibleInstalledPage]);

  const sourceCategories: CategoryInfo[] = installed.sourceGroups.map((group) => ({
    id: group.id,
    labelKey: 'filters.source',
    sourceLabel: group.label,
  }));
  const installedCategories = [...CATEGORIES, ...sourceCategories];
  const categorySections = [
    { title: t('nav.categories.installed'), categories: CATEGORIES },
    { title: t('list.columns.source'), categories: sourceCategories },
  ];
  const searchValue = activeTab === 'discover'
    ? searchDraft
    : installedView === 'groups' ? groupSearch : installedSearch;
  const handleSearchChange = activeTab === 'discover'
    ? setSearchDraft
    : installedView === 'groups' ? setGroupSearch : setInstalledSearch;
  const searchPlaceholder = t(activeTab === 'discover'
    ? 'market.searchPlaceholder'
    : installedView === 'groups' ? 'groups.search' : 'toolbar.searchPlaceholder');

  useEffect(() => {
    if (!installed.loading && !installed.error && installedView.startsWith('source:')
      && !installed.sourceGroups.some((group) => group.id === installedView)) {
      setInstalledView('all');
    }
  }, [installed.loading, installed.error, installed.sourceGroups, installedView, setInstalledView]);

  return (
    <div className="openbitfun-skills-scene" data-testid="agent-skill-panel" data-openbitfun-scene="skills" data-openbitfun-part="root" data-openbitfun-tab={activeTab}>
      <div className="skills-scene__actions" data-openbitfun-scene="skills" data-openbitfun-part="pageActions">
        <Button
          className="skills-scene__market-button"
          variant="text"
          size="sm"
          leadingIcon={<Icon name={activeTab === 'installed' ? 'search' : 'arrow-left'} size="sm" />}
          disabled={!desktopConfigAvailable}
          onClick={() => setActiveTab(activeTab === 'installed' ? 'discover' : 'installed')}
          data-testid="skills-market-button"
        >
          {t(activeTab === 'installed' ? 'nav.anchors.market' : 'nav.anchors.installed')}
        </Button>
      </div>
      <ScrollArea className="skills-scene__scroll" ref={scrollRef}>
        <div className="skills-scene__content" ref={contentRef}>
          <h1 className="skills-scene__title" data-openbitfun-scene="skills" data-openbitfun-part="header">
            {t(activeTab === 'installed' ? 'nav.title' : 'market.title')}
          </h1>
          {desktopConfigAvailable && (
            <div className="skills-controls" data-openbitfun-scene="skills" data-openbitfun-part="controls">
              <SearchField
                className="skills-controls__search"
                value={searchValue}
                onValueChange={handleSearchChange}
                onSearch={activeTab === 'discover' ? submitMarketQuery : undefined}
                leadingIcon={<Icon name="search" size="sm" aria-hidden />}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                size="sm"
                clearLabel={searchValue ? tComponents('search.clear') : undefined}
                onClear={searchValue ? () => {
                  handleSearchChange('');
                  if (activeTab === 'discover') submitMarketQuery();
                } : undefined}
              />
              {activeTab === 'installed' && (
                <Select
                  className="skills-controls__category"
                  size="sm"
                  value={installedView}
                  aria-label={t('nav.categories.installed')}
                  options={categorySections.flatMap((section) => section.categories.map((category) => {
                    const count = category.id === 'groups' ? skillGroupCount : installed.counts[category.id] ?? 0;
                    const countAvailable = category.id === 'groups'
                      ? skillGroups.ready && installed.catalogReady
                      : installed.catalogReady;
                    const label = t(category.labelKey, { source: category.sourceLabel });
                    return {
                      value: category.id,
                      label: countAvailable ? `${label} · ${formatNumber(count)}` : label,
                      group: section.title,
                    };
                  }))}
                  onValueChange={(value) => {
                    const category = installedCategories.find((candidate) => candidate.id === value);
                    if (category) setInstalledView(category.id);
                  }}
                />
              )}
              {activeTab === 'installed' ? (
                <Button
                  className="skills-controls__add"
                  variant="primary"
                  size="sm"
                  leadingIcon={<Icon name="plus" size="sm" />}
                  onClick={toggleAddForm}
                  data-testid="skills-add-skill-btn"
                >
                  {t('toolbar.addTooltip')}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setMarketSettingsOpen(true)}>
                  {tSettings('market.settings.title')}
                </Button>
              )}
            </div>
          )}

          <main className="skills-page" id="skills-page" data-openbitfun-scene="skills" data-openbitfun-part="content" data-openbitfun-tab={activeTab} data-openbitfun-category={activeTab === 'installed' ? installedView : undefined}>
            {activeTab === 'installed' && (
              <div className="skills-installed" id="skills-panel-installed" role="region" aria-label={t('installed.titleAll')} data-openbitfun-scene="skills" data-openbitfun-part="installed">
                <div className="skills-main" data-openbitfun-scene="skills" data-openbitfun-part="main">
                  {!desktopConfigAvailable ? (
                    <div className="skills-main__empty" data-testid="skills-management-unavailable" data-openbitfun-scene="skills" data-openbitfun-part="empty">
                      <Icon name="book-open" size="lg" />
                      <span>{t(remoteConnectionActive ? 'list.remoteUnavailable' : 'list.desktopUnavailable')}</span>
                    </div>
                  ) : installedView === 'groups' ? (
                    <SkillGroupsView
                      key={installed.catalogContextKey}
                      searchQuery={groupSearch}
                      skills={groupSkills}
                      collection={skillGroups}
                      catalogReady={installed.catalogReady}
                      catalogLoading={installed.loading}
                      catalogIncomplete={installed.diagnostics.length > 0 || !installed.diagnosticsAvailable}
                      onRefresh={() => { void installed.loadSkills(true); void skillGroups.reload(); }}
                    />
                  ) : (
                    <>
                      <div className="skills-main__list-shell">
                        {installed.loading && (
                          <div className="skills-main__table" role="group" aria-busy="true" aria-label={t('list.loading')} data-openbitfun-scene="skills" data-openbitfun-part="installedTable">
                            <div className="skills-main__loading" role="list">
                              {Array.from({ length: installedPageLayout.pageSize }).map((_, i) => (
                                <div
                                  key={`ins-sk-${i}`}
                                  className="skills-card-skeleton"
                                  style={{ '--surface-stagger-index': i } as React.CSSProperties}
                                  aria-hidden="true"
                                  data-openbitfun-scene="skills"
                                  data-openbitfun-part="skeleton"
                                >
                                  <div className="skills-card__top">
                                    <span className="skills-card-skeleton__icon" />
                                    <div className="skills-card__info">
                                      <span className="skills-card-skeleton__line skills-card-skeleton__line--title" />
                                      <span className="skills-card-skeleton__line" />
                                    </div>
                                  </div>
                                  <div className="skills-card__actions"><span className="skills-card-skeleton__line skills-card-skeleton__line--short" /></div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {!installed.loading && installedLoadFailed && (
                          <div className="skills-main__empty skills-main__empty--error" data-openbitfun-scene="skills" data-openbitfun-part="error">
                            <Icon name="book-open" size="lg" />
                            <span>{t('list.loadFailed')}</span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void installed.loadSkills(true)}
                            >
                              {t('list.retry')}
                            </Button>
                          </div>
                        )}

                        {!installed.loading && !installedLoadFailed && installedFiltered.length === 0 && (
                          <div className="skills-main__empty" data-testid="skill-list-empty" data-openbitfun-scene="skills" data-openbitfun-part="empty">
                            <Icon name="book-open" size="lg" />
                            <span>
                              {installed.skills.length === 0
                                ? t('list.empty.noSkills')
                                : t('list.empty.noMatch')}
                            </span>
                          </div>
                        )}

                        {!installed.loading && !installedLoadFailed && installedFiltered.length > 0 && (
                          <div
                            className="skills-main__table"
                            role="group"
                            aria-label={t('nav.title')}
                            data-openbitfun-scene="skills"
                            data-openbitfun-part="installedTable"
                          >
                            <SkillsGrid
                              rows={installedPageLayout.rows}
                              paginated={installedPagination.totalPages > 1}
                              id="skills-installed-list"
                              ref={installedListRef}
                              aria-label={t('pagination.page', { page: formatNumber(installedPagination.page) })}
                            >
                              {installedPagination.skills.map((skill) => (
                                <SkillCard
                                  key={skill.key}
                                  name={skill.name}
                                  description={skill.description}
                                  ariaLabel={installedSkillAriaLabel(skill)}
                                  onOpenDetails={() => setSelectedDetail({ type: 'installed', skillKey: skill.key })}
                                  level={skill.level}
                                  shadowed={skill.isShadowed}
                                  builtin={skill.isBuiltin}
                                  globallyDisabled={installed.globallyDisabledSkillKeys.has(skill.key)}
                                  data-testid="skill-list-item"
                                  data-skill-key={skill.key}
                                  data-skill-id={skill.key}
                                  data-skill-name={skill.name}
                                  data-skill-level={skill.level}
                                  data-skill-builtin={skill.isBuiltin ? 'true' : 'false'}
                                />
                              ))}
                            </SkillsGrid>
                            <SkillsPagination
                              pagination={installedPagination}
                              listId="skills-installed-list"
                              total={installedFiltered.length}
                              onPageChange={(page) => {
                                if (page === installedPagination.page) return;
                                focusPage.current = true;
                                installedPagination.goToPage(page);
                              }}
                            />
                          </div>
                        )}
                      </div>

                    </>
                  )}
                </div>
              </div>
            )}

            {desktopConfigAvailable && activeTab === 'discover' && (
              <div className="skills-discover" id="skills-panel-discover" role="region" aria-label={t('market.title')} data-openbitfun-scene="skills" data-openbitfun-part="discover">
                <div className="skills-discover__content">
                  {!market.marketLoading && market.sourceErrors.length > 0 && (
                    <div className="skills-discover__state" role="alert">
                      {market.sourceErrors.map(error => <p key={error}>{error}</p>)}
                    </div>
                  )}
                  {!market.marketLoading && !market.marketError && marketQuery && market.totalLoaded > 0 && (
                    <div className="skills-discover__results-info" data-openbitfun-scene="skills" data-openbitfun-part="resultsInfo" role="status">
                      <OverflowText>{t('market.resultsInfo', { query: marketQuery, count: market.totalLoaded })}</OverflowText>
                    </div>
                  )}
                  {market.marketLoading && (
                    <LoadingState className="skills-discover__state" role="status" size="sm" data-openbitfun-scene="skills" data-openbitfun-part="loading">
                      {t('market.loading')}
                    </LoadingState>
                  )}

                  {!market.marketLoading && market.marketError && (
                    <Empty
                      className="skills-discover__state"
                      role="alert"
                      icon={<Icon name="book-open" />}
                      description={market.marketError}
                      actions={<Button variant="outline" size="sm" onClick={() => void market.refresh()}>{t('list.retry')}</Button>}
                      data-openbitfun-scene="skills"
                      data-openbitfun-part="error"
                    />
                  )}

                  {!market.marketLoading && !market.marketError && !market.loadingMore && market.marketSkills.length === 0 && (
                    <Empty
                      className="skills-discover__state"
                      icon={<Icon name="book-open" />}
                      description={marketQuery ? t('market.empty.noMatch') : t('market.empty.noSkills')}
                      data-testid="skill-list-empty"
                      data-openbitfun-scene="skills"
                      data-openbitfun-part="empty"
                    />
                  )}

                  {!market.marketLoading && !market.marketError && market.marketSkills.length > 0 && (
                    <SkillsGrid
                      rows={marketPageLayout.rows}
                      paginated={market.totalPages > 1 || market.hasMore}
                      id="skills-market-list"
                      ref={marketListRef}
                      aria-label={t('pagination.page', { page: formatNumber(market.currentPage + 1) })}
                      aria-busy={market.loadingMore || undefined}
                    >
                      {market.marketSkills.map(skill => {
                        const isInstalled = isSkillMarketItemInstalled(skill, installedMarketIds);
                        const isDownloading = market.downloadingPackage === skill.installId;
                        return (
                          <SkillCard
                            key={skill.installId}
                            data-testid="skills-market-card"
                            data-skill-install-id={skill.installId}
                            data-skill-id={skill.installId}
                            data-skill-name={skill.name}
                            data-skill-installed={isInstalled ? 'true' : 'false'}
                            name={skill.name}
                            description={skill.description}
                            ariaLabel={[skill.name, skill.marketName, skill.source, isInstalled && t('market.item.installed')].filter(Boolean).join(', ')}
                            iconKind="market"
                            action={{
                              icon: <Icon name={isInstalled ? 'check-circle' : 'arrow-down'} size="sm" />,
                              label: isDownloading ? t('market.item.downloading') : isInstalled ? t('market.item.installed') : t('market.item.downloadProject'),
                              title: isInstalled ? t('market.item.installedTooltip') : t('market.item.downloadProject'),
                              loading: isDownloading,
                              disabled: isDownloading || !market.hasWorkspace || market.isRemoteWorkspace || isInstalled,
                              onClick: () => void market.handleDownload(skill, 'project'),
                            }}
                            onOpenDetails={() => setSelectedDetail({ type: 'market', skill })}
                          />
                        );
                      })}
                    </SkillsGrid>
                  )}
                  {!market.marketLoading && !market.marketError && market.marketSkills.length > 0 && (
                    <SkillsPagination
                      listId="skills-market-list"
                      pagination={{
                        page: market.currentPage + 1,
                        totalPages: market.totalPages,
                        start: market.currentPage * marketPageSize + 1,
                        end: Math.min((market.currentPage + 1) * marketPageSize, market.totalLoaded),
                      }}
                      total={market.totalLoaded}
                      hasMore={market.hasMore}
                      loading={market.loadingMore}
                      onPageChange={page => {
                        if (page === market.currentPage + 1) return;
                        focusPage.current = true;
                        void market.goToPage(page - 1);
                      }}
                    />
                  )}
                </div>
              </div>
            )}
          </main>
        </div>
      </ScrollArea>

      <Dialog open={marketSettingsOpen && desktopConfigAvailable} onOpenChange={setMarketSettingsOpen} size="md">
        <DialogHeader>
          <DialogHeading><DialogTitle>{tSettings('market.settings.title')}</DialogTitle></DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
          {marketSettingsOpen && desktopConfigAvailable && <SkillMarketSettings onSaved={() => setMarketSettingsOpen(false)} />}
        </DialogBody>
      </Dialog>

      <Dialog
        open={desktopConfigAvailable && Boolean(selectedDetail)}
        onOpenChange={(nextOpen) => { if (!nextOpen) setSelectedDetail(null); }}
        size="md"
        data-testid="skill-detail-panel"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle data-testid="skill-detail-title">
              {selectedInstalledSkill?.name ?? selectedMarketSkill?.name ?? ''}
            </DialogTitle>
            {selectedInstalledSkill || isSelectedMarketSkillInstalled ? (
              <div
                className="skills-detail__badges"
                data-openbitfun-scene="skills"
                data-openbitfun-part="detailBadges"
              >
                {selectedInstalledSkill ? (
                  <>
                    <StatusPill tone="neutral">
                      {selectedInstalledSkill.isBuiltin ? t('list.item.builtin') : t('list.item.userInstalled')}
                    </StatusPill>
                    <StatusPill tone="neutral">
                      {market.isRemoteWorkspace
                        ? selectedInstalledSkill.level === 'user'
                          ? t('list.item.localUser')
                          : t('list.item.remoteProject')
                        : selectedInstalledSkill.level === 'user'
                          ? t('list.item.user')
                          : t('list.item.project')}
                    </StatusPill>
                    {selectedInstalledSkill.isShadowed && (
                      <StatusPill tone="warning" leading={<Icon glyph={ShieldAlert} />}>
                        {t('list.item.shadowed')}
                      </StatusPill>
                    )}
                  </>
                ) : (
                  <StatusPill tone="success" leading={<Icon name="check-circle" size="2xs" />}>
                    {t('market.item.installed')}
                  </StatusPill>
                )}
              </div>
            ) : null}
          </DialogHeading>
          <DialogClose data-testid="skill-detail-close" />
        </DialogHeader>
        <DialogBody>
          <div className="skills-detail" data-openbitfun-scene="skills" data-openbitfun-part="detail">
            {detailDescription ? (
              <ScrollArea
                className="skills-detail__description-scroll"
                tabIndex={0}
                data-openbitfun-scene="skills"
                data-openbitfun-part="detailDescriptionViewport"
              >
                <p
                  className="skills-detail__description"
                  data-openbitfun-scene="skills"
                  data-openbitfun-part="detailDescription"
                  data-testid="skill-detail-description"
                >
                  {detailDescription}
                </p>
              </ScrollArea>
            ) : null}
            <dl className="skills-detail__fields" data-openbitfun-scene="skills" data-openbitfun-part="detailMetadata">
              {selectedInstalledSkill ? (
                <>
                  <div className="skills-detail__field">
                    <dt>{t('list.columns.source')}</dt>
                    <dd>{getSkillSourceLabel(selectedInstalledSkill, t('list.item.unknownSource'))}</dd>
                  </div>
                  {installed.canToggleSkill(selectedInstalledSkill) && (
                    <div className="skills-detail__field" data-openbitfun-scene="skills" data-openbitfun-part="detailStatus">
                      <dt>{t('list.columns.status')}</dt>
                      <dd className="skills-detail__availability">
                        <Switch
                          checked={!installed.globallyDisabledSkillKeys.has(selectedInstalledSkill.key)}
                          disabled={installed.savingGlobalSkillKey !== null}
                          aria-busy={installed.savingGlobalSkillKey === selectedInstalledSkill.key}
                          aria-label={t('list.item.globalToggleLabel', { name: selectedInstalledSkill.name })}
                          onChange={(event) => {
                            void installed.handleGlobalSkillToggle(selectedInstalledSkill, event.target.checked);
                          }}
                        />
                        <span>{t(installed.globallyDisabledSkillKeys.has(selectedInstalledSkill.key) ? 'list.item.globalDisabled' : 'list.item.globalEnabled')}</span>
                      </dd>
                    </div>
                  )}
                  {selectedInstalledSkill.isShadowed && (
                    <div className="skills-detail__field">
                      <dt>{t('list.item.shadowedLabel')}</dt>
                      <dd>
                        {t('list.item.shadowedDetail', {
                          source: coverageSourceBySkillKey.get(selectedInstalledSkill.key)
                            ?? t('list.item.unknownSource'),
                        })}
                      </dd>
                    </div>
                  )}
                  <div className="skills-detail__field" data-testid="skill-detail-capabilities-section">
                    <dt>{t('list.item.pathLabel')}</dt>
                    <dd className="skills-detail__location">
                      <Tooltip content={selectedInstalledSkill.path} trigger="hover-focus" interactive>
                        <span className="skills-detail__path" tabIndex={0}>
                          {selectedSkillPathSegments.map((segment, index) => (
                            <React.Fragment key={`${index}-${segment}`}>
                              {segment}<wbr />
                            </React.Fragment>
                          ))}
                        </span>
                      </Tooltip>
                      <Tooltip content={tCommon('file.copyPath')} trigger="hover-focus">
                        <IconButton
                          variant="quiet"
                          size="sm"
                          icon={<Icon glyph={Copy} size="sm" />}
                          aria-label={tCommon('file.copyPath')}
                          onClick={() => void handleCopySkillPath(selectedInstalledSkill.path)}
                          data-testid="skills-detail-copy-path-btn"
                        />
                      </Tooltip>
                      {canRevealSkillPath ? (
                        <Tooltip content={t('list.item.openPathInExplorer')} trigger="hover-focus">
                          <IconButton
                            variant="quiet"
                            size="sm"
                            icon={<Icon glyph={FolderOpen} size="sm" />}
                            aria-label={t('list.item.openPathInExplorer')}
                            onClick={() => void handleRevealSkillPath(selectedInstalledSkill.path)}
                            data-testid="skills-detail-path-btn"
                          />
                        </Tooltip>
                      ) : null}
                    </dd>
                  </div>
                </>
              ) : null}
              {selectedMarketSkill?.source ? (
                <div className="skills-detail__field" data-testid="skill-detail-capabilities-section">
                  <dt>{t('list.columns.source')}</dt>
                  <dd>{selectedMarketSkill.marketName ? `${selectedMarketSkill.marketName} · ${selectedMarketSkill.source}` : selectedMarketSkill.source}</dd>
                </div>
              ) : null}
              {selectedMarketSkill ? (
                <div className="skills-detail__field">
                  <dt>{t('market.detail.installsLabel')}</dt>
                  <dd>{formatNumber(selectedMarketSkill.installs ?? 0)}</dd>
                </div>
              ) : null}
              {selectedMarketSkill?.url ? (
                <div className="skills-detail__field">
                  <dt>{t('market.detail.linkLabel')}</dt>
                  <dd>
                    <a
                      href={selectedMarketSkill.url}
                      target="_blank"
                      rel="noreferrer"
                      className="skills-detail__link"
                      data-testid="skills-detail-external-link"
                    >
                      {selectedMarketSkill.url}
                    </a>
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
        </DialogBody>
        {selectedInstalledSkill && canDeleteSkill(selectedInstalledSkill) ? (
          <DialogFooter separator>
            <Button
              variant="text"
              tone="danger"
              size="sm"
              onClick={() => {
                setDeleteTarget(selectedInstalledSkill);
                setSelectedDetail(null);
              }}
              leadingIcon={<Icon name="delete" size="sm" />}
            >
              {t('deleteModal.delete')}
            </Button>
          </DialogFooter>
        ) : selectedMarketSkill && !isSelectedMarketSkillInstalled ? (
          <DialogFooter separator>
            <div className="skills-detail__actions">
              {!market.isRemoteWorkspace && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void market.handleDownload(selectedMarketSkill, 'project')}
                  disabled={market.downloadingPackage === selectedMarketSkill.installId || !market.hasWorkspace}
                >
                  {t('market.item.downloadProject')}
                </Button>
              )}
              <Button
                variant={market.isRemoteWorkspace ? 'primary' : 'outline'}
                size="sm"
                onClick={() => void market.handleDownload(selectedMarketSkill, 'user')}
                disabled={market.downloadingPackage === selectedMarketSkill.installId}
              >
                {t('market.item.downloadUser')}
              </Button>
            </div>
          </DialogFooter>
        ) : null}
      </Dialog>

      <AddSkillDialog
        open={desktopConfigAvailable && isAddFormOpen}
        onOpenChange={setAddFormOpen}
        installed={installed}
        onAdded={market.refresh}
      />

      <ConfirmDialog
        open={desktopConfigAvailable && Boolean(deleteTarget)}
        onOpenChange={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!desktopConfigAvailable || !deleteTarget || !canDeleteSkill(deleteTarget)) {
            setDeleteTarget(null);
            return;
          }
          const deleted = await installed.handleDelete(deleteTarget);
          if (deleted) {
            setDeleteTarget(null);
          }
        }}
        title={t('deleteModal.title')}
        message={t('deleteModal.message', { name: deleteTarget?.name ?? '' })}
        type="warning"
        confirmDanger
        confirmText={t('deleteModal.delete')}
        cancelText={t('deleteModal.cancel')}
      />
    </div>
  );
};

export default SkillsScene;
