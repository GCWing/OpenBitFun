import {
  Button,
  Checkbox,
  ConfirmDialog,
  Empty,
  Field,
  Icon,
  IconButton,
  Input,
  LoadingState,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelHeader,
  NavigationPanelItem,
  NavigationPanelSection,
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
  type IconSource,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, FolderOpen, Layers, Package, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';

import type { SkillInfo, SkillLevel, SkillMarketItem } from '@/infrastructure/config/types';
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
import { useSkillMarket } from './hooks/useSkillMarket';
import { SkillMarketSettings } from '@/infrastructure/config/components/SkillMarketSettings';
import SkillCard from './components/SkillCard';
import SkillGroupsView from './components/SkillGroupsView';
import { useUserSkillGroups } from '@/features/skill-groups/useUserSkillGroups';
import { resolveSkillGroups } from '@/features/skill-groups/skillGroups';
import './SkillsScene.scss';
import { useSkillsSceneStore, type SkillsView } from './skillsSceneStore';
import { formatSkillDetailPath } from './skillDetailPath';
import { useGallerySceneAutoRefresh } from '@/app/hooks/useGallerySceneAutoRefresh';

const log = createLogger('SkillsScene');

type SkillTab = 'installed' | 'discover';

interface CategoryInfo {
  id: SkillsView;
  icon: IconSource;
  labelKey: string;
  titleKey: string;
  descKey: string;
  sourceLabel?: string;
}

const CATEGORIES: CategoryInfo[] = [
  {
    id: 'all',
    icon: { glyph: Layers },
    labelKey: 'filters.all',
    titleKey: 'installed.titleListAll',
    descKey: 'categories.all',
  },
  {
    id: 'builtin',
    icon: { glyph: ShieldCheck },
    labelKey: 'filters.builtin',
    titleKey: 'installed.titleBuiltin',
    descKey: 'categories.builtin',
  },
  {
    id: 'user',
    icon: { name: 'user' },
    labelKey: 'filters.user',
    titleKey: 'installed.titleUser',
    descKey: 'categories.user',
  },
  {
    id: 'project',
    icon: { glyph: FolderOpen },
    labelKey: 'filters.project',
    titleKey: 'installed.titleProject',
    descKey: 'categories.project',
  },
  {
    id: 'groups',
    icon: { glyph: Layers },
    labelKey: 'filters.groups',
    titleKey: 'groups.title',
    descKey: 'categories.groups',
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
  const {
    nativeNavigationRequest,
    searchDraft,
    marketQuery,
    installedView,
    hideDuplicates,
    isAddFormOpen,
    setSearchDraft,
    submitMarketQuery,
    setInstalledView,
    setHideDuplicates,
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
    setActiveTab('installed');
    setInstalledSearch('');
    setSelectedDetail(null);
  }, [nativeNavigationRequest]);

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
    pageSize: 15,
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

  const handleAddSkill = async () => {
    const added = await installed.handleAdd();
    if (added) {
      setAddFormOpen(false);
      await market.refresh();
    }
  };

  const installedFiltered = useMemo(() => {
    const list = hideDuplicates
      ? installed.filteredSkills.filter((s) => !s.isShadowed)
      : installed.filteredSkills;
    return list;
  }, [hideDuplicates, installed.filteredSkills]);

  const installedLoadFailed = Boolean(installed.error)
    || (installed.skills.length === 0 && installed.diagnostics.length > 0);

  const sourceCategories: CategoryInfo[] = installed.sourceGroups.map((group) => ({
    id: group.id,
    icon: { name: 'extension' },
    labelKey: 'filters.source',
    titleKey: 'installed.titleSource',
    descKey: 'categories.source',
    sourceLabel: group.label,
  }));
  const installedCategories = [...CATEGORIES, ...sourceCategories];
  const categorySections = [
    { title: t('nav.categories.installed'), categories: CATEGORIES },
    { title: t('list.columns.source'), categories: sourceCategories },
  ];
  const activeInstalledCategory = installedCategories.find((category) => category.id === installedView)
    ?? CATEGORIES[0];
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

  const installedListHeader = (
    <div
      className="skills-main__list-header"
      role="row"
      data-openbitfun-scene="skills"
      data-openbitfun-part="installedListHeader"
    >
      <div className="skills-main__list-heading" role="columnheader">
        <span data-openbitfun-scene="skills" data-openbitfun-part="installedListTitle">{t('nav.title')}</span>
        {!installed.loading && (
          <span className="skills-main__list-count" data-openbitfun-scene="skills" data-openbitfun-part="installedListCount">
            {formatNumber(installedFiltered.length)}
          </span>
        )}
      </div>
      <span className="skills-main__column-label" role="columnheader">{t('list.columns.source')}</span>
      <span className="skills-main__column-label" role="columnheader">{t('list.columns.status')}</span>
      <span className="skills-main__column-label skills-main__column-label--actions" role="columnheader">{t('list.columns.actions')}</span>
    </div>
  );

  return (
    <div className="openbitfun-skills-scene" data-testid="agent-skill-panel" data-openbitfun-scene="skills" data-openbitfun-part="root" data-openbitfun-tab={activeTab}>
      <NavigationPanel className="skills-sidebar" aria-label={t('nav.title')} data-openbitfun-scene="skills" data-openbitfun-part="sidebar">
        <NavigationPanelHeader className="skills-sidebar__header">
          <div data-openbitfun-scene="skills" data-openbitfun-part="sidebarHeader">
            <div className="skills-sidebar__title" data-openbitfun-scene="skills" data-openbitfun-part="sidebarTitle">{t('nav.title')}</div>
          </div>
          <div className="skills-sidebar__compact-picker">
            <Select
              size="sm"
              value={activeTab === 'discover' ? 'discover' : installedView}
              disabled={!desktopConfigAvailable}
              aria-label={t('nav.title')}
              options={[
                ...categorySections.flatMap((section) => section.categories.map((category) => ({
                  value: category.id,
                  label: t(category.labelKey, { source: category.sourceLabel }),
                  group: section.title,
                }))),
                { value: 'discover', label: t('market.title'), group: t('nav.categories.discover') },
              ]}
              onValueChange={(value) => {
                if (value === 'discover') {
                  setActiveTab('discover');
                  return;
                }
                const category = installedCategories.find((candidate) => candidate.id === value);
                if (category) {
                  setInstalledView(category.id);
                  setActiveTab('installed');
                }
              }}
            />
          </div>
          {desktopConfigAvailable && (
            <div className="skills-sidebar__search" data-openbitfun-scene="skills" data-openbitfun-part="sidebarSearch">
              <SearchField
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
            </div>
          )}
        </NavigationPanelHeader>
        <NavigationPanelBody>
          <div data-openbitfun-scene="skills" data-openbitfun-part="sidebarNav">
            <NavigationPanelContent>
              {categorySections.filter((section) => section.categories.length > 0).map((section) => (
                <NavigationPanelSection key={section.title} title={section.title}>
                  {section.categories.map((cat) => {
                    const count = cat.id === 'groups' ? skillGroupCount : installed.counts[cat.id] ?? 0;
                    const countAvailable = cat.id !== 'groups' || (skillGroups.ready && installed.catalogReady);
                    const isEmpty = count === 0;
                    const selected = activeTab === 'installed' && installedView === cat.id;
                    return (
                      <div
                        key={cat.id}
                        className="skills-sidebar__item"
                        data-openbitfun-scene="skills"
                        data-openbitfun-part="sidebarItem"
                        data-openbitfun-category={cat.id}
                        data-openbitfun-state={[
                          selected && 'active',
                          isEmpty && 'empty',
                        ].filter(Boolean).join(' ') || undefined}
                      >
                        <NavigationPanelItem
                          selected={selected}
                          disabled={!desktopConfigAvailable}
                          onClick={() => {
                            setInstalledView(cat.id);
                            setActiveTab('installed');
                          }}
                          title={t(cat.descKey, { source: cat.sourceLabel })}
                          leading={<span data-openbitfun-scene="skills" data-openbitfun-part="sidebarItemIcon"><Icon {...cat.icon} size="sm" /></span>}
                          metadata={countAvailable ? (
                            <span className="skills-sidebar__item-count" data-openbitfun-scene="skills" data-openbitfun-part="sidebarItemCount">
                              {formatNumber(count)}
                            </span>
                          ) : undefined}
                        >
                          <span data-openbitfun-scene="skills" data-openbitfun-part="sidebarItemLabel">{t(cat.labelKey, { source: cat.sourceLabel })}</span>
                        </NavigationPanelItem>
                      </div>
                    );
                  })}
                </NavigationPanelSection>
              ))}
              <NavigationPanelSection title={t('nav.categories.discover')}>
                <NavigationPanelItem
                  selected={activeTab === 'discover'}
                  disabled={!desktopConfigAvailable}
                  onClick={() => setActiveTab('discover')}
                  leading={<Icon glyph={Package} size="sm" />}
                >
                  {t('market.title')}
                </NavigationPanelItem>
              </NavigationPanelSection>
            </NavigationPanelContent>
          </div>
        </NavigationPanelBody>
      </NavigationPanel>

      <main className="skills-page" data-openbitfun-scene="skills" data-openbitfun-part="content" data-openbitfun-tab={activeTab}>
        {activeTab === 'installed' && (
          <div className="skills-installed" id="skills-panel-installed" role="region" aria-label={t('installed.titleAll')} data-openbitfun-scene="skills" data-openbitfun-part="installed">
            <div className="skills-main" data-openbitfun-scene="skills" data-openbitfun-part="main">
              {(!desktopConfigAvailable || installedView !== 'groups') && (
                <header className="skills-content-header" data-openbitfun-scene="skills" data-openbitfun-part="header">
                  <div className="skills-content-header__identity">
                    <div className="skills-content-header__copy">
                      <h1 className="skills-content-header__title">
                        <OverflowText>{t(activeInstalledCategory.titleKey, { source: activeInstalledCategory.sourceLabel })}</OverflowText>
                      </h1>
                      <p className="skills-content-header__description">
                        {t(activeInstalledCategory.descKey, { source: activeInstalledCategory.sourceLabel })}
                      </p>
                    </div>
                  </div>
                  {desktopConfigAvailable && (
                    <Button
                      className="skills-content-header__action"
                      variant="primary"
                      size="sm"
                      leadingIcon={<Icon name="plus" size="sm" />}
                      onClick={toggleAddForm}
                      data-testid="skills-add-skill-btn"
                    >
                      {t('toolbar.addTooltip')}
                    </Button>
                  )}
                </header>
              )}
              {!desktopConfigAvailable ? (
                <div className="skills-main__empty" data-testid="skills-management-unavailable" data-openbitfun-scene="skills" data-openbitfun-part="empty">
                  <Icon glyph={Package} size="lg" />
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
                  <div className="skills-main__toolbar" data-openbitfun-scene="skills" data-openbitfun-part="toolbar">
                    <div
                      className="skills-main__filter"
                      data-openbitfun-scene="skills"
                      data-openbitfun-part="filterAction"
                      data-openbitfun-state={hideDuplicates ? 'active' : undefined}
                    >
                      <Checkbox
                        checked={hideDuplicates}
                        onCheckedChange={setHideDuplicates}
                        size="sm"
                        label={t('toolbar.hideDuplicates')}
                      />
                    </div>
                  </div>

                  <div className="skills-main__list-shell">
                    {installed.loading && (
                      <div className="skills-main__table" role="table" aria-busy="true" aria-label={t('list.loading')} data-openbitfun-scene="skills" data-openbitfun-part="installedTable">
                        {installedListHeader}
                        <ScrollArea className="skills-main__loading" role="rowgroup">
                          {Array.from({ length: 8 }).map((_, i) => (
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
                                  <span className="skills-card-skeleton__line skills-card-skeleton__line--short" />
                                </div>
                              </div>
                              <div className="skills-card__meta">
                                <span className="skills-card-skeleton__line skills-card-skeleton__line--title" />
                                <span className="skills-card-skeleton__line skills-card-skeleton__line--short" />
                              </div>
                              <div className="skills-card__global-toggle"><span className="skills-card-skeleton__line skills-card-skeleton__line--short" /></div>
                              <div className="skills-card__actions"><span className="skills-card-skeleton__line skills-card-skeleton__line--short" /></div>
                            </div>
                          ))}
                        </ScrollArea>
                      </div>
                    )}

                    {!installed.loading && installedLoadFailed && (
                      <div className="skills-main__empty skills-main__empty--error" data-openbitfun-scene="skills" data-openbitfun-part="error">
                        <Icon glyph={Package} size="lg" />
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
                        <Icon glyph={Package} size="lg" />
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
                        role="table"
                        aria-label={t(activeInstalledCategory.titleKey, { source: activeInstalledCategory.sourceLabel })}
                        data-openbitfun-scene="skills"
                        data-openbitfun-part="installedTable"
                      >
                        {installedListHeader}
                        <ScrollArea
                          className="skills-main__grid"
                          role="rowgroup"
                          data-testid="skill-list"
                          data-openbitfun-scene="skills"
                          data-openbitfun-part="list"
                        >
                          {installedFiltered.map((skill) => (
                            <div
                              key={skill.key}
                              className={[
                                'skills-card',
                                skill.isShadowed && 'is-shadowed',
                                installed.globallyDisabledSkillKeys.has(skill.key)
                                  && 'is-globally-disabled',
                              ].filter(Boolean).join(' ')}
                              role="row"
                              data-overflow-trigger
                              data-testid="skill-list-item"
                              data-skill-key={skill.key}
                              data-skill-id={skill.key}
                              data-skill-name={skill.name}
                              data-skill-level={skill.level}
                              data-skill-builtin={skill.isBuiltin ? 'true' : 'false'}
                              data-openbitfun-scene="skills"
                              data-openbitfun-part="installedCard"
                              data-openbitfun-level={skill.level}
                              data-openbitfun-state={[
                                skill.isShadowed && 'shadowed',
                                skill.isBuiltin && 'builtin',
                              ].filter(Boolean).join(' ') || undefined}
                            >
                              <div className="skills-card__top" role="cell" data-openbitfun-scene="skills" data-openbitfun-part="installedCardTop">
                                <button
                                  type="button"
                                  className="skills-card__open"
                                  aria-label={installedSkillAriaLabel(skill)}
                                  onClick={() => setSelectedDetail({ type: 'installed', skillKey: skill.key })}
                                  data-openbitfun-scene="skills"
                                  data-openbitfun-part="installedCardOpen"
                                />
                                <div className="skills-card__icon" aria-hidden="true" data-openbitfun-scene="skills" data-openbitfun-part="installedCardIcon">
                                  <Icon name="extension" size="sm" />
                                </div>
                                <div className="skills-card__info" data-openbitfun-scene="skills" data-openbitfun-part="installedCardInfo">
                                  <div className="skills-card__title-row">
                                    <span className="skills-card__name" data-testid="skill-list-item-title" data-openbitfun-scene="skills" data-openbitfun-part="installedCardName">
                                      <OverflowText behavior="marquee" title="">{skill.name}</OverflowText>
                                    </span>
                                    {skill.isBuiltin && (
                                      <StatusPill tone="neutral">
                                        {t('list.item.builtin')}
                                      </StatusPill>
                                    )}
                                  </div>
                                  {skill.description?.trim() && (
                                    <OverflowText lines={2} title="" className="skills-card__desc" data-testid="skill-list-item-description" data-openbitfun-scene="skills" data-openbitfun-part="installedCardDescription">{skill.description}</OverflowText>
                                  )}
                                </div>
                              </div>

                              <div
                                className="skills-card__meta"
                                role="cell"
                                data-openbitfun-scene="skills"
                                data-openbitfun-part="installedCardMeta"
                              >
                                <span
                                  className="skills-card__source"
                                  data-openbitfun-scene="skills"
                                  data-openbitfun-part="installedCardSource"
                                >
                                  <OverflowText title="">
                                    {getSkillSourceLabel(skill, t('list.item.unknownSource'))}
                                  </OverflowText>
                                </span>
                                <span
                                  className="skills-card__level"
                                  data-openbitfun-scene="skills"
                                  data-openbitfun-part="installedCardLevel"
                                >
                                  {skill.level === 'user'
                                    ? <Icon name="user" size="xs" />
                                    : <Icon glyph={FolderOpen} size="xs" />}
                                  <OverflowText title="">
                                    {market.isRemoteWorkspace
                                      ? skill.level === 'user'
                                        ? t('list.item.localUser')
                                        : t('list.item.remoteProject')
                                      : skill.level === 'user'
                                        ? t('list.item.user')
                                        : t('list.item.project')}
                                  </OverflowText>
                                </span>
                              </div>

                              <div
                                className="skills-card__global-toggle"
                                role="cell"
                                data-openbitfun-scene="skills"
                                data-openbitfun-part="installedCardStatus"
                              >
                                {installed.canToggleSkill(skill) ? (
                                  <div className="skills-card__availability" title={t(installed.globallyDisabledSkillKeys.has(skill.key) ? 'list.item.globalDisabled' : 'list.item.globalEnabled')}>
                                    <Switch
                                      checked={!installed.globallyDisabledSkillKeys.has(skill.key)}
                                      disabled={installed.savingGlobalSkillKey !== null}
                                      aria-busy={installed.savingGlobalSkillKey === skill.key}
                                      aria-label={t('list.item.globalToggleLabel', { name: skill.name })}
                                      onChange={(event) => {
                                        void installed.handleGlobalSkillToggle(skill, event.target.checked);
                                      }}
                                    />
                                    <span className="skills-card__availability-label">
                                      {t(installed.globallyDisabledSkillKeys.has(skill.key) ? 'messages.disabled' : 'messages.enabled')}
                                    </span>
                                  </div>
                                ) : !skill.isShadowed && (
                                  <span className="skills-card__status-unavailable" aria-hidden="true">—</span>
                                )}
                                {skill.isShadowed && (
                                  <StatusPill tone="warning" title={t('list.item.shadowedTooltip', {
                                    source: coverageSourceBySkillKey.get(skill.key) ?? t('list.item.unknownSource'),
                                  })} leading={<Icon glyph={ShieldAlert} />}>
                                    {t('list.item.shadowed')}
                                  </StatusPill>
                                )}
                              </div>

                              <div
                                className="skills-card__actions"
                                role="cell"
                                data-openbitfun-scene="skills"
                                data-openbitfun-part="installedCardActions"
                              >
                                <IconButton
                                  size="sm"
                                  variant="quiet"
                                  tabIndex={-1}
                                  onClick={() => setSelectedDetail({ type: 'installed', skillKey: skill.key })}
                                  aria-label={t('list.item.detail')}
                                  title={t('list.item.detail')}
                                  data-openbitfun-scene="skills"
                                  data-openbitfun-part="installedCardDetails"
                                  icon={<Icon name="arrow-right" size="sm" />}
                                />
                                {canDeleteSkill(skill) && (
                                  <IconButton
                                    size="sm"
                                    variant="quiet"
                                    tone="danger"
                                    onClick={() => setDeleteTarget(skill)}
                                    aria-label={t('list.item.deleteTooltip')}
                                    title={t('list.item.deleteTooltip')}
                                    data-openbitfun-scene="skills"
                                    data-openbitfun-part="installedCardDelete"
                                    icon={<Icon name="delete" size="sm" />}
                                  />
                                )}
                              </div>
                            </div>
                          ))}
                        </ScrollArea>
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
            <header className="skills-content-header skills-discover__hero" data-openbitfun-scene="skills" data-openbitfun-part="discoverHero">
              <div className="skills-content-header__identity" data-openbitfun-scene="skills" data-openbitfun-part="discoverHeroContent">
                <div className="skills-content-header__copy">
                  <h1 className="skills-content-header__title" data-openbitfun-scene="skills" data-openbitfun-part="discoverTitle"><OverflowText>{t('market.title')}</OverflowText></h1>
                  <p className="skills-content-header__description" data-openbitfun-scene="skills" data-openbitfun-part="discoverSubtitle">
                    {t('market.subtitle')}
                  </p>
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => setMarketSettingsOpen(true)}>
                {tSettings('market.settings.title')}
              </Button>
            </header>

            <ScrollArea className="skills-discover__content">
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
              {(market.marketLoading || (!market.marketError && market.loadingMore)) && (
                <LoadingState className="skills-discover__state" role="status" size="sm" data-openbitfun-scene="skills" data-openbitfun-part="loading">
                  {t('market.loading')}
                </LoadingState>
              )}

              {!market.marketLoading && market.marketError && (
                <Empty
                  className="skills-discover__state"
                  role="alert"
                  icon={<Icon glyph={Package} />}
                  description={market.marketError}
                  actions={<Button variant="outline" size="sm" onClick={() => void market.refresh()}>{t('list.retry')}</Button>}
                  data-openbitfun-scene="skills"
                  data-openbitfun-part="error"
                />
              )}

              {!market.marketLoading && !market.marketError && !market.loadingMore && market.marketSkills.length === 0 && (
                <Empty
                  className="skills-discover__state"
                  icon={<Icon glyph={Package} />}
                  description={marketQuery ? t('market.empty.noMatch') : t('market.empty.noSkills')}
                  data-testid="skill-list-empty"
                  data-openbitfun-scene="skills"
                  data-openbitfun-part="empty"
                />
              )}

              {!market.marketLoading && !market.marketError && !market.loadingMore && market.marketSkills.length > 0 && (
                <div className="skills-discover__grid" data-testid="skill-list" data-openbitfun-scene="skills" data-openbitfun-part="list">
                  {market.marketSkills.map((skill, index) => {
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
                          description={skill.description || t('market.item.noDescription')}
                          source={skill.marketName ? `${skill.marketName} · ${skill.source}` : skill.source}
                          index={index}
                          accentSeed={skill.installId}
                          iconKind="market"
                          meta={(
                            <span className="openbitfun-skills-scene__market-meta" title={t('market.item.installs', { count: skill.installs ?? 0 })}>
                              <span>{t('market.detail.installsLabel')}</span>
                              <span>{formatNumber(skill.installs ?? 0)}</span>
                            </span>
                          )}
                          actions={[
                            {
                              id: 'download',
                              icon: isInstalled ? <Icon name="check-circle" size="xs" /> : <Icon name="arrow-down" size="xs" />,
                              ariaLabel: isInstalled ? t('market.item.installed') : t('market.item.downloadProject'),
                              label: isDownloading ? t('market.item.downloading') : undefined,
                              loading: isDownloading,
                              title: isDownloading
                                ? t('market.item.downloading')
                                : (isInstalled ? t('market.item.installedTooltip') : t('market.item.downloadProject')),
                              disabled:
                                isDownloading
                                || !market.hasWorkspace
                                || market.isRemoteWorkspace
                                || isInstalled,
                              tone: isInstalled ? 'muted' : 'primary',
                              onClick: () => void market.handleDownload(skill, 'project'),
                            },
                          ]}
                          onOpenDetails={() => setSelectedDetail({ type: 'market', skill })}
                        />
                    );
                  })}
                </div>
              )}
            </ScrollArea>

            {!market.marketLoading && !market.marketError && (market.totalPages > 1 || market.hasMore) && (
              <div className="skills-discover__pagination" data-openbitfun-scene="skills" data-openbitfun-part="pagination">
                <Button
                  size="sm"
                  variant="outline"
                  className="skills-discover__page-btn"
                  onClick={market.goToPrevPage}
                  disabled={market.currentPage === 0 || market.loadingMore}
                  data-openbitfun-scene="skills"
                  data-openbitfun-part="pageButton"
                  leadingIcon={<Icon name="chevron-left" size="sm" />}
                >
                  {t('market.pagination.prev')}
                </Button>
                <span className="skills-discover__page-info" data-openbitfun-scene="skills" data-openbitfun-part="pageInfo" aria-live="polite">
                  {market.hasMore
                    ? t('market.pagination.infoMore', { current: market.currentPage + 1 })
                    : t('market.pagination.info', { current: market.currentPage + 1, total: market.totalPages })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="skills-discover__page-btn"
                  onClick={() => void market.goToNextPage()}
                  disabled={(!market.hasMore && market.currentPage >= market.totalPages - 1) || market.loadingMore}
                  data-openbitfun-scene="skills"
                  data-openbitfun-part="pageButton"
                  trailingIcon={<Icon name="chevron-right" size="sm" />}
                >
                  {t('market.pagination.next')}
                </Button>
              </div>
            )}
          </div>
        )}
      </main>

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
                  <dd>{selectedMarketSkill.source}</dd>
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

      <Dialog
        open={desktopConfigAvailable && isAddFormOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            installed.resetForm();
            setAddFormOpen(false);
          }
        }}
        size="sm"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('form.title')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
        <div className="openbitfun-skills-scene__modal-form">
          <Field label={t('form.level.label')} controlWidth="fill">
            <Select
              options={[
                { label: t('form.level.user'), value: 'user' },
                {
                  label: `${t('form.level.project')}${installed.hasWorkspace && !installed.isRemoteWorkspace ? '' : t('form.level.projectDisabled')}`,
                  value: 'project',
                  disabled: !installed.hasWorkspace || installed.isRemoteWorkspace,
                },
              ]}
              value={installed.formLevel}
              onValueChange={(value) => installed.setFormLevel(value as SkillLevel)}
              size="md"
            />
          </Field>

          {installed.formLevel === 'project' && installed.hasWorkspace ? (
            <div className="openbitfun-skills-scene__form-hint">
              {t('form.level.selectedProjectPath', { path: installed.workspacePath })}
            </div>
          ) : null}

          <div className="openbitfun-skills-scene__path-input">
            <Field label={t('form.path.label')} controlWidth="fill">
              <Input
                placeholder={t('form.path.placeholder')}
                value={installed.formPath}
                onChange={(e) => installed.setFormPath(e.target.value)}
              />
            </Field>
            <IconButton
              size="md"
              onClick={installed.handleBrowse}
              aria-label={t('form.path.browseTooltip')}
              title={t('form.path.browseTooltip')}
              icon={<Icon glyph={FolderOpen} size="sm" />}
            />
          </div>
          <div className="openbitfun-skills-scene__path-hint">
            {t('form.path.hint')}
          </div>

          {installed.isValidating ? (
            <div className="openbitfun-skills-scene__validating">{t('form.validating')}</div>
          ) : null}

          {installed.validationResult ? (
            <div
              className={[
                'openbitfun-skills-scene__validation',
                installed.validationResult.valid ? 'is-valid' : 'is-invalid',
              ].filter(Boolean).join(' ')}
            >
              {installed.validationResult.valid ? (
                <>
                  <div className="openbitfun-skills-scene__validation-name">
                    {installed.validationResult.name}
                  </div>
                  <div className="openbitfun-skills-scene__validation-desc">
                    {installed.validationResult.description}
                  </div>
                </>
              ) : (
                <div className="openbitfun-skills-scene__validation-error">
                  {installed.validationResult.error}
                </div>
              )}
            </div>
          ) : null}

        </div>
        </DialogBody>
        <DialogFooter separator className="openbitfun-skills-scene__modal-form-actions">
            <Button
              variant="fill"
              size="sm"
              onClick={() => {
                installed.resetForm();
                setAddFormOpen(false);
              }}
            >
              {t('form.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleAddSkill}
              disabled={!installed.validationResult?.valid || installed.isAdding}
            >
              {installed.isAdding ? t('form.actions.adding') : t('form.actions.add')}
            </Button>
        </DialogFooter>
      </Dialog>

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
