import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  FolderPlus,
  Gamepad2,
  House,
  LayoutGrid,
  Lightbulb,
  PackagePlus,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useSceneManager } from '@/app/hooks/useSceneManager';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { flowChatSessionConfigForCurrentWorkspace } from '@/app/utils/projectSessionWorkspace';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { isRemoteWorkspace } from '@/shared/types';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import MiniAppCard from '../components/MiniAppCard';
import MiniAppDetailModal from '../components/MiniAppDetailModal';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { miniAppAPI } from '@/infrastructure/api/service-api/MiniAppAPI';
import {
  miniAppMarketAPI,
  type MarketPackageInspection,
} from '@/infrastructure/api/service-api/MiniAppMarketAPI';
import { createLogger } from '@/shared/utils/logger';
import { subscribeOverlayInteraction, createOverlayPortal,
  ConfirmDialog,
  Icon,
  IconButton,
  Menu,
  MenuItem,
  NumberBadge,
  SearchField,
  SegmentedControl,
} from '@openbitfun/ui';

import {
  GalleryEmpty,
  GalleryGrid,
  GalleryLayout,
  GalleryPageHeader,
  GallerySkeleton,
  GalleryZone,
} from '@/app/components';
import { loadInstalledMarketOrigins } from '../utils/loadInstalledMarketOrigins';
import { pickLocalizedString, pickLocalizedTags } from '../utils/pickLocalizedString';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useMiniAppStore } from '../miniAppStore';
import { useI18n } from '@/infrastructure/i18n';
import { useGallerySceneAutoRefresh } from '@/app/hooks/useGallerySceneAutoRefresh';
import { useNotification } from '@/shared/notification-system';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { getMiniAppSceneId, stopMiniAppActivity } from '../miniAppActivity';
import { useMiniAppActivity } from '../hooks/useMiniAppActivity';
import './MiniAppGalleryView.scss';


const log = createLogger('MiniAppGalleryView');
const MINIAPP_CARD_MIN_WIDTH = 280;

interface MiniAppGalleryViewProps {
  tabs?: React.ReactNode;
}

const MiniAppGalleryView: React.FC<MiniAppGalleryViewProps> = ({ tabs }) => {
  const apps = useMiniAppStore((state) => state.apps);
  const loading = useMiniAppStore((state) => state.loading);
  const customizingAppIds = useMiniAppStore((state) => state.customizingAppIds);
  const marketOrigins = useMiniAppStore((state) => state.marketOrigins);
  const setApps = useMiniAppStore((state) => state.setApps);
  const setLoading = useMiniAppStore((state) => state.setLoading);
  const setMarketOrigins = useMiniAppStore((state) => state.setMarketOrigins);
  const setRunningWorkerIds = useMiniAppStore((state) => state.setRunningWorkerIds);
  const markWorkerStopped = useMiniAppStore((state) => state.markWorkerStopped);
  const { workspace, workspacePath } = useCurrentWorkspace();
  const notification = useNotification();
  const { openScene, activateScene, closeScene, openTabs } = useSceneManager();
  const { t, currentLanguage } = useI18n('scenes/miniapp');
  const miniAppActivities = useMiniAppActivity();

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<MiniAppMeta | null>(null);
  const [pendingPackage, setPendingPackage] = useState<{
    path: string;
    inspection: MarketPackageInspection;
  } | null>(null);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [creatingWithCreative, setCreatingWithCreative] = useState(false);
  const importTriggerRef = useRef<HTMLButtonElement>(null);
  const importMenuRef = useRef<HTMLDivElement>(null);

  const importMenuLayout = useAnchoredPopoverPosition({
    open: importMenuOpen,
    anchorRef: importTriggerRef,
    popoverRef: importMenuRef,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 6,
    layoutRevision: currentLanguage,
  });

  const closeImportMenu = useCallback(() => setImportMenuOpen(false), []);

  useEffect(() => {
    if (!importMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target
        && (importTriggerRef.current?.contains(target) || importMenuRef.current?.contains(target))
      ) {
        return;
      }
      closeImportMenu();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) return;
      closeImportMenu();
      requestAnimationFrame(() => importTriggerRef.current?.focus());
    };

    const removeOverlayMousedown0 = subscribeOverlayInteraction(importMenuRef, 'mousedown', handlePointerDown);
    const removeOverlayKeydown1 = subscribeOverlayInteraction(importMenuRef, 'keydown', handleEscape);
    return () => {
      removeOverlayMousedown0?.();
      removeOverlayKeydown1?.();
    };
  }, [closeImportMenu, importMenuOpen]);

  const openTabIds = useMemo(() => new Set(openTabs.map((tab) => tab.id)), [openTabs]);
  const activityById = useMemo(
    () => new Map(miniAppActivities.map((activity) => [activity.app.id, activity])),
    [miniAppActivities],
  );
  const activeIdSet = useMemo(() => new Set(activityById.keys()), [activityById]);
  const customizingIdSet = useMemo(() => new Set(customizingAppIds), [customizingAppIds]);

  const activeApps = useMemo(
    () => miniAppActivities.map((activity) => activity.app),
    [miniAppActivities],
  );

  const categories = useMemo(() => {
    const values = Array.from(new Set(apps.map((app) => app.category).filter(Boolean)));
    return ['all', ...values];
  }, [apps]);

  const filtered = useMemo(() => {
    return apps.filter((app) => {
      const keyword = search.toLowerCase();
      // Search across the localized strings + raw fallback so users can search
      // either the displayed text OR the author's original wording.
      const localizedName = pickLocalizedString(app, currentLanguage, 'name').toLowerCase();
      const localizedDesc = pickLocalizedString(app, currentLanguage, 'description').toLowerCase();
      const localizedTags = pickLocalizedTags(app, currentLanguage).map((t) => t.toLowerCase());
      const matchSearch =
        !search ||
        localizedName.includes(keyword) ||
        localizedDesc.includes(keyword) ||
        app.name.toLowerCase().includes(keyword) ||
        app.description.toLowerCase().includes(keyword) ||
        localizedTags.some((tag) => tag.includes(keyword)) ||
        app.tags.some((tag) => tag.toLowerCase().includes(keyword));
      const matchCategory = categoryFilter === 'all' || app.category === categoryFilter;
      return matchSearch && matchCategory;
    });
  }, [apps, search, categoryFilter, currentLanguage]);

  const handleOpenApp = useCallback(
    (appId: string) => {
      setSelectedApp(null);
      const tabId = getMiniAppSceneId(appId);
      if (openTabIds.has(tabId)) {
        activateScene(tabId);
      } else {
        openScene(tabId);
      }
    },
    [openTabIds, activateScene, openScene]
  );

  const handleStopRunning = useCallback(
    async (appId: string) => {
      const activity = activityById.get(appId);
      if (!activity) return;

      try {
        await stopMiniAppActivity(activity, {
          stopWorker: (id) => miniAppAPI.workerStop(id),
          markWorkerStopped,
          closeScene,
        });
      } catch (error) {
        log.warn('Failed to stop MiniApp worker', { appId, error });
        notification.error(t('stopFailed', {
          name: pickLocalizedString(activity.app, currentLanguage, 'name'),
          error: String(error),
        }));
      }
    },
    [activityById, closeScene, currentLanguage, markWorkerStopped, notification, t]
  );

  const handleDeleteRequest = (appId: string) => {
    setPendingDeleteId(appId);
  };

  const handleDeleteConfirm = async () => {
    if (!pendingDeleteId) return;
    const appId = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      await miniAppAPI.deleteMiniApp(appId);
      if (selectedApp?.id === appId) {
        setSelectedApp(null);
      }
      setApps(apps.filter((app) => app.id !== appId));
      markWorkerStopped(appId);
      const tabId = getMiniAppSceneId(appId);
      if (openTabIds.has(tabId)) {
        closeScene(tabId);
      }
    } catch (error) {
      log.error('Delete failed', error);
    }
  };

  const refetchMiniAppGallery = useCallback(async () => {
    setLoading(true);
    try {
      const [refreshed, running, origins] = await Promise.all([
        miniAppAPI.listMiniApps(),
        miniAppAPI.workerListRunning(),
        loadInstalledMarketOrigins(),
      ]);
      setApps(refreshed);
      setRunningWorkerIds(running);
      setMarketOrigins(origins);
    } catch (error) {
      log.error('Failed to refresh miniapp gallery', error);
    } finally {
      setLoading(false);
    }
  }, [setApps, setLoading, setMarketOrigins, setRunningWorkerIds]);

  useGallerySceneAutoRefresh({
    sceneId: 'miniapps',
    refetch: refetchMiniAppGallery,
  });

  const handleAddFromFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('selectFolderTitle'),
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;

      setLoading(true);
      const app = await miniAppAPI.importFromPath(path, workspacePath || undefined);
      setApps([app, ...apps]);
      handleOpenApp(app.id);
    } catch (error) {
      log.error('Import from folder failed', error);
    } finally {
      setLoading(false);
    }
  };

  const preparePackageImport = useCallback(async (path: string) => {
    if (!path.toLowerCase().endsWith('.bfminiapp')) return;
    try {
      const inspection = await miniAppMarketAPI.inspectPackage(path);
      setPendingPackage({ path, inspection });
    } catch (error) {
      log.error('Inspect MiniApp package failed', error);
      notification.error(t('market.import.invalid', { error: String(error) }));
    }
  }, [notification, t]);

  const handleAddPackage = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      title: t('market.import.choose'),
      filters: [{ name: t('market.import.packageFile'), extensions: ['bfminiapp'] }],
    });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (path) await preparePackageImport(path);
  };

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (cancelled || event.payload.type !== 'drop') return;
          const packagePath = event.payload.paths.find((path) =>
            path.toLowerCase().endsWith('.bfminiapp'),
          );
          if (packagePath) void preparePackageImport(packagePath);
        }))
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          stop = unlisten;
        }
      })
      .catch((error) => log.warn('MiniApp package drag-and-drop unavailable', error));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [preparePackageImport]);

  const handlePackageImportConfirm = async () => {
    if (!pendingPackage) return;
    const selected = pendingPackage;
    setPendingPackage(null);
    setLoading(true);
    try {
      const app = await miniAppMarketAPI.importPackage(selected.path, true);
      setApps([app, ...apps]);
      notification.success(t('market.import.imported', { name: app.name }));
      handleOpenApp(app.id);
    } catch (error) {
      log.error('Import MiniApp package failed', error);
      notification.error(t('market.import.failed', { error: String(error) }));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateWithCreative = useCallback(async () => {
    if (creatingWithCreative) return;
    if (!workspace) {
      notification.error(t('creationMode.noWorkspace'));
      return;
    }
    if (isRemoteWorkspace(workspace)) {
      notification.error(t('creationMode.remoteUnsupported'));
      return;
    }

    setCreatingWithCreative(true);
    closeImportMenu();
    try {
      const sessionId = await flowChatManager.createChatSession(
        flowChatSessionConfigForCurrentWorkspace(workspace),
        'Creative',
      );
      await openMainSession(sessionId);
      notification.success(t('creationMode.started'));
    } catch (error) {
      log.error('Failed to start Creative MiniApp session', error);
      notification.error(t('creationMode.startFailed'));
    } finally {
      setCreatingWithCreative(false);
    }
  }, [
    closeImportMenu,
    creatingWithCreative,
    notification,
    t,
    workspace,
  ]);

  const renderGrid = () => {
    if (loading && apps.length === 0) {
      return (
        <GallerySkeleton
          count={8}
          minCardWidth={MINIAPP_CARD_MIN_WIDTH}
          className="miniapp-gallery__card-grid"
        />
      );
    }

    if (filtered.length === 0) {
      return (
        <GalleryEmpty
          icon={
            apps.length === 0
              ? { name: 'spark' }
              : { glyph: LayoutGrid }
          }
          message={apps.length === 0
            ? t('empty.generate')
            : t('empty.noMatch')}
        />
      );
    }

    return (
      <GalleryGrid minCardWidth={MINIAPP_CARD_MIN_WIDTH} className="miniapp-gallery__card-grid">
        {filtered.map((app, index) => (
          <MiniAppCard
            key={app.id}
            app={app}
            index={index}
            isRunning={activeIdSet.has(app.id)}
            isCustomizing={customizingIdSet.has(app.id)}
            marketReleaseNumber={marketOrigins[app.id]?.releaseNumber}
            onOpenDetails={setSelectedApp}
            onOpen={handleOpenApp}
            onStop={handleStopRunning}
          />
        ))}
      </GalleryGrid>
    );
  };

  return (
    <GalleryLayout
      data-openbitfun-component="miniapp-gallery-view"
      data-openbitfun-part="root"
      className="miniapp-gallery-pane miniapp-gallery"
    >
      <GalleryPageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={(
          <>
            <SearchField
              leadingIcon={<Icon name="search" size="lg" aria-hidden />}
              onValueChange={setSearch}
              placeholder={t('searchPlaceholder')}
              size="sm"
              value={search}
            />
            <span className="miniapp-gallery__import-anchor">
              <IconButton
                ref={importTriggerRef}
                size="xs"
                onClick={() => setImportMenuOpen(open => !open)}
                disabled={loading}
                title={t('importAction')}
                aria-label={t('importAction')}
                aria-haspopup="menu"
                aria-expanded={importMenuOpen}
                data-testid="miniapp-import-action"
                icon={<Icon name="plus" size="sm" />}
              />
              {importMenuOpen ? createOverlayPortal(
                <Menu
                  ref={importMenuRef}
                  className="miniapp-gallery__import-menu"
                  aria-label={t('importMenuLabel')}
                  data-testid="miniapp-import-menu"
                  style={{
                    top: `${importMenuLayout?.top ?? 0}px`,
                    left: `${importMenuLayout?.left ?? 0}px`,
                    visibility: importMenuLayout ? 'visible' : 'hidden',
                  }}
                >
                  <MenuItem
                    leading={<FolderPlus size={15} aria-hidden="true" />}
                    onClick={() => {
                      closeImportMenu();
                      void handleAddFromFolder();
                    }}
                    data-testid="miniapp-import-folder-action"
                  >
                    {t('importFromFolder')}
                  </MenuItem>
                  <MenuItem
                    leading={<PackagePlus size={15} aria-hidden="true" />}
                    onClick={() => {
                      closeImportMenu();
                      void handleAddPackage();
                    }}
                    data-testid="miniapp-import-package-action"
                  >
                    {t('market.import.action')}
                  </MenuItem>
                </Menu>,
                getAppearanceOverlayHost(),
              ) : null}
            </span>
            <IconButton
              size="xs"
              onClick={() => void handleCreateWithCreative()}
              loading={creatingWithCreative}
              title={t('creationMode.action')}
              aria-label={t('creationMode.action')}
              data-testid="miniapp-create-action"
              icon={<Icon name="edit" size="sm" />}
            />
          </>
        )}
      />

      {tabs}

      <div data-openbitfun-component="miniapp-gallery-view" data-openbitfun-part="content" className="gallery-zones">
        {activeApps.length > 0 ? (
          <GalleryZone
            title={t('running')}
            titleAdornment={<NumberBadge value={activeApps.length} />}
            data-testid="miniapp-running-zone"
            className="miniapp-gallery__running-zone"
          >
            <GalleryGrid minCardWidth={MINIAPP_CARD_MIN_WIDTH} className="miniapp-gallery__card-grid">
              {activeApps.map((app, index) => (
                <MiniAppCard
                  key={app.id}
                  app={app}
                  index={index}
                  isRunning
                  isCustomizing={customizingIdSet.has(app.id)}
                  marketReleaseNumber={marketOrigins[app.id]?.releaseNumber}
                  onOpenDetails={setSelectedApp}
                  onOpen={handleOpenApp}
                  onStop={handleStopRunning}
                />
              ))}
            </GalleryGrid>
          </GalleryZone>
        ) : null}

        <GalleryZone
          title={t('allApps')}
          titleAdornment={<NumberBadge value={filtered.length} />}
          tools={(
            categories.length > 1 ? (
              <div
                data-openbitfun-component="miniapp-gallery-view"
                data-openbitfun-part="categoryFilters"
              >
                <SegmentedControl size="md"
                  className="miniapp-gallery__categories"
                  options={categories.map((category) => {
                    const normalizedCategory = category.toLowerCase();
                    const categoryIcon = normalizedCategory === 'productivity'
                      ? <Lightbulb size={12} />
                      : normalizedCategory === 'developer'
                        ? <Icon name="terminal" size="xs" aria-hidden />
                        : normalizedCategory === 'lifestyle'
                          ? <House size={12} />
                          : normalizedCategory === 'game'
                            ? <Gamepad2 size={12} />
                            : undefined;
                    return {
                      icon: categoryIcon,
                      label: (
                        <span
                          data-openbitfun-component="miniapp-gallery-view"
                          data-openbitfun-part="categoryFilter"
                        >
                          {category === 'all'
                            ? t('all')
                            : category.replace(/^./, (character) => character.toUpperCase())}
                        </span>
                      ),
                      value: category,
                    };
                  })}
                  value={categoryFilter}
                  onValueChange={setCategoryFilter}
                  aria-label={t('allApps')}
                  variant="pills"
                />
              </div>
            ) : null
          )}
        >
          {renderGrid()}
        </GalleryZone>
      </div>

      <MiniAppDetailModal
        app={selectedApp}
        marketReleaseNumber={selectedApp ? marketOrigins[selectedApp.id]?.releaseNumber : undefined}
        isActive={selectedApp ? activeIdSet.has(selectedApp.id) : false}
        isCustomizing={selectedApp ? customizingIdSet.has(selectedApp.id) : false}
        onClose={() => setSelectedApp(null)}
        onOpen={handleOpenApp}
        onDelete={handleDeleteRequest}
        onStop={handleStopRunning}
      />

      <ConfirmDialog
        open={pendingDeleteId !== null}
        onOpenChange={() => setPendingDeleteId(null)}
        onConfirm={handleDeleteConfirm}
        title={t('confirmDelete.title', { name: apps.find((app) => app.id === pendingDeleteId)?.name ?? '' })}
        message={t('confirmDelete.message')}
        type="warning"
        confirmDanger
        confirmText={t('confirmDelete.confirm')}
        cancelText={t('confirmDelete.cancel')}
      />

      <ConfirmDialog
        open={pendingPackage !== null}
        onOpenChange={() => setPendingPackage(null)}
        onConfirm={() => void handlePackageImportConfirm()}
        title={t('market.import.confirmTitle', {
          name: pendingPackage?.inspection.name ?? '',
        })}
        message={t('market.import.confirmMessage', {
          description: pendingPackage?.inspection.description ?? '',
          permissions: [
            ...(pendingPackage?.inspection.permissionDiff.added ?? []),
            ...(pendingPackage?.inspection.permissionDiff.expanded ?? []),
          ].join(', ') || t('market.detail.noPermissions'),
          sha256: pendingPackage?.inspection.packageSha256 ?? '',
        })}
        type="warning"
        confirmText={t('market.import.confirm')}
        cancelText={t('confirmDelete.cancel')}
      />
    </GalleryLayout>
  );
};

export default MiniAppGalleryView;
