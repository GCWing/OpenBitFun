import { subscribeOverlayInteraction, createOverlayPortal,
  Button,
  ConfirmDialog,
  Icon,
  IconButton,
  Menu,
  MenuItem,
  NumberBadge,
  SearchField,
  Select,
  StatusPill,
  type SelectOption,
} from '@openbitfun/ui';
import { open } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle,
  FolderPlus,
  Heart,
  Loader2,
  PackageCheck,
  PackagePlus,
  ShieldCheck,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  GalleryDetailModal,
  GalleryEmpty,
  GalleryLayout,
  GalleryPageHeader,
  GallerySkeleton,
} from '@/app/components';
import { MarketList } from '@/app/components/GalleryLayout/MarketList';
import { MarketImage } from '@/app/components/GalleryLayout/MarketImage';
import { getInteractionMotion } from '@/shared/utils/motionPreference';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { useGallerySceneAutoRefresh } from '@/app/hooks/useGallerySceneAutoRefresh';
import { useSceneManager } from '@/app/hooks/useSceneManager';
import { flowChatSessionConfigForCurrentWorkspace } from '@/app/utils/projectSessionWorkspace';
import { AccountIdentityControls } from '@/features/market-account';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import type {
  MiniAppMeta,
  MiniAppPermissions,
} from '@/infrastructure/api/service-api/MiniAppAPI';
import { miniAppAPI } from '@/infrastructure/api/service-api/MiniAppAPI';
import {
  miniAppMarketAPI,
  type MarketInstalledStatus,
  type MarketListingDetail,
  type MarketListingSummary,
  type MarketPackageInspection,
  type MarketSort,
} from '@/infrastructure/api/service-api/MiniAppMarketAPI';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n';
import { useAccountIdentity } from '@/infrastructure/account-identity';
import { useNotification } from '@/shared/notification-system';
import { isRemoteWorkspace } from '@/shared/types';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { createLogger } from '@/shared/utils/logger';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import MiniAppDetailModal from '../components/MiniAppDetailModal';
import MiniAppLibraryRow, {
  type MiniAppLibraryStatus,
} from '../components/MiniAppLibraryRow';
import { useMiniAppActivity } from '../hooks/useMiniAppActivity';
import { getMiniAppSceneId, stopMiniAppActivity } from '../miniAppActivity';
import { useMiniAppStore } from '../miniAppStore';
import { loadInstalledMarketOrigins } from '../utils/loadInstalledMarketOrigins';
import { getMiniAppShowcaseAsset } from '../utils/miniAppIcons';
import { pickLocalizedString, pickLocalizedTags } from '../utils/pickLocalizedString';
import { buildMiniAppLibraryItems, type MiniAppLibraryItem } from './miniAppLibraryItems';
import { buildReleaseHistory } from './miniAppReleaseHistory';
import './MiniAppLibraryView.scss';

const log = createLogger('MiniAppLibraryView');
const CATEGORIES = [
  'all',
  'developer',
  'productivity',
  'data',
  'creative',
  'education',
  'utilities',
  'entertainment',
  'other',
] as const;

type MiniAppCategory = (typeof CATEGORIES)[number];
type Translate = (key: string, params?: Record<string, unknown>) => string;

interface MiniAppLibraryViewProps {
  tabs?: React.ReactNode;
}

const MiniAppLibraryContent: React.FC<MiniAppLibraryViewProps> = ({ tabs }) => {
  const [surfaceScope] = useState(getActiveSurfaceScope);
  const apps = useMiniAppStore((state) => state.apps);
  const loading = useMiniAppStore((state) => state.loading);
  const customizingAppIds = useMiniAppStore((state) => state.customizingAppIds);
  const marketOrigins = useMiniAppStore((state) => state.marketOrigins);
  const setApps = useMiniAppStore((state) => state.setApps);
  const upsertApp = useMiniAppStore((state) => state.upsertApp);
  const setLoading = useMiniAppStore((state) => state.setLoading);
  const setMarketOrigin = useMiniAppStore((state) => state.setMarketOrigin);
  const setMarketOrigins = useMiniAppStore((state) => state.setMarketOrigins);
  const setRunningWorkerIds = useMiniAppStore((state) => state.setRunningWorkerIds);
  const markWorkerStopped = useMiniAppStore((state) => state.markWorkerStopped);
  const { workspace, workspacePath } = useCurrentWorkspace();
  const notification = useNotification();
  const { openScene, activateScene, closeScene, openTabs } = useSceneManager();
  const { t, formatNumber, currentLanguage } = useI18n('scenes/miniapp');
  const miniAppActivities = useMiniAppActivity();
  const { me } = useAccountIdentity();

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<MiniAppCategory>('all');
  const [sort, setSort] = useState<MarketSort>('downloads');
  const [cachedPage] = useState(() => miniAppMarketAPI.getCachedPage({ query: '', category: 'all', sort: 'downloads', limit: 30 }));
  const [marketItems, setMarketItems] = useState<MarketListingSummary[]>(cachedPage?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | undefined>(cachedPage?.nextCursor);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const [detail, setDetail] = useState<MarketListingDetail>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [installed, setInstalled] = useState<MarketInstalledStatus | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [detailActionBusy, setDetailActionBusy] = useState(false);
  const [busyListingId, setBusyListingId] = useState<string>();
  const [installPrompt, setInstallPrompt] = useState(false);
  const [releasesExpanded, setReleasesExpanded] = useState(false);
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
  const catalogRequestRef = useRef(0);
  const animateList = useRef(true);
  const detailRequestRef = useRef(0);

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

  const handleOpenApp = useCallback((appId: string) => {
    setSelectedApp(null);
    setDetailOpen(false);
    const tabId = getMiniAppSceneId(appId);
    if (openTabIds.has(tabId)) {
      activateScene(tabId);
    } else {
      openScene(tabId);
    }
  }, [activateScene, openScene, openTabIds]);

  const fetchCatalog = useCallback(async (cursor?: string, append = false) => {
    if (!surfaceScope.isCurrent()) return;
    const requestId = ++catalogRequestRef.current;
    if (append) setLoadingMore(true);
    else {
      setCatalogLoading(true);
      setLoadingMore(false);
    }
    setCatalogError(undefined);

    try {
      const page = await miniAppMarketAPI.browse({
        query,
        category,
        sort,
        cursor,
        limit: 30,
      });
      if (requestId !== catalogRequestRef.current) return;
      setMarketItems((current) => append ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      if (requestId !== catalogRequestRef.current) return;
      log.error('Failed to load MiniApp marketplace catalog', loadError);
      if (!append) setNextCursor(undefined);
      setCatalogError(String(loadError));
    } finally {
      if (requestId === catalogRequestRef.current) {
        setCatalogLoading(false);
        setLoadingMore(false);
      }
    }
  }, [category, query, sort, surfaceScope]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchCatalog(undefined, false);
    }, 250);
    return () => {
      window.clearTimeout(timeout);
      // Invalidate before the debounce of a new filter, not after it fires.
      catalogRequestRef.current += 1;
    };
  }, [fetchCatalog]);

  const refetchMiniAppLibrary = useCallback(async () => {
    if (!surfaceScope.isCurrent()) return;
    setLoading(true);
    try {
      const [refreshed, running, origins] = await Promise.all([
        miniAppAPI.listMiniApps(),
        miniAppAPI.workerListRunning(),
        loadInstalledMarketOrigins(),
      ]);
      if (!surfaceScope.isCurrent()) return;
      setApps(refreshed);
      setRunningWorkerIds(running);
      setMarketOrigins(origins);
      await fetchCatalog(undefined, false);
    } catch (error) {
      if (!surfaceScope.isCurrent()) return;
      log.error('Failed to refresh MiniApp library', error);
    } finally {
      if (surfaceScope.isCurrent()) setLoading(false);
    }
  }, [fetchCatalog, setApps, setLoading, setMarketOrigins, setRunningWorkerIds, surfaceScope]);

  useGallerySceneAutoRefresh({
    sceneId: 'miniapps',
    refetch: refetchMiniAppLibrary,
  });

  const projectedItems = useMemo(
    () => buildMiniAppLibraryItems(marketItems, apps, marketOrigins, sort),
    [apps, marketItems, marketOrigins, sort],
  );
  const libraryItems = useMemo(
    () => projectedItems.filter((item) => matchesLibraryFilter(
      item,
      query,
      category,
      currentLanguage,
    )),
    [category, currentLanguage, projectedItems, query],
  );

  const handleStopRunning = useCallback(async (appId: string) => {
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
  }, [activityById, closeScene, currentLanguage, markWorkerStopped, notification, t]);

  const handleDeleteConfirm = async () => {
    if (!pendingDeleteId) return;
    const appId = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      await miniAppAPI.deleteMiniApp(appId);
      if (selectedApp?.id === appId) setSelectedApp(null);
      setApps(apps.filter((app) => app.id !== appId));
      markWorkerStopped(appId);
      const tabId = getMiniAppSceneId(appId);
      if (openTabIds.has(tabId)) closeScene(tabId);
    } catch (error) {
      log.error('Delete failed', error);
      notification.error(t('market.messages.deleteFailed', { error: String(error) }));
    }
  };

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
      upsertApp(app);
      handleOpenApp(app.id);
    } catch (error) {
      log.error('Import from folder failed', error);
      notification.error(t('market.import.failed', { error: String(error) }));
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
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (cancelled || event.payload.type !== 'drop') return;
        const packagePath = event.payload.paths.find((path) => (
          path.toLowerCase().endsWith('.bfminiapp')
        ));
        if (packagePath) void preparePackageImport(packagePath);
      }))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
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
      upsertApp(app);
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

  const fetchMarketDetail = useCallback(async (summary: MarketListingSummary) => {
    const [loaded, status] = await Promise.all([
      miniAppMarketAPI.getListing(summary.slug),
      miniAppMarketAPI.installedStatus(summary.listingId),
    ]);
    return { loaded, status };
  }, []);

  const openMarketDetail = useCallback(async (summary: MarketListingSummary) => {
    const requestId = ++detailRequestRef.current;
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(undefined);
    setInstalled(null);
    setReleasesExpanded(false);
    try {
      const { loaded, status } = await fetchMarketDetail(summary);
      if (requestId !== detailRequestRef.current) return;
      setDetail(loaded);
      setInstalled(status);
    } catch (loadError) {
      if (requestId !== detailRequestRef.current) return;
      setDetailOpen(false);
      notification.error(t('market.messages.detailFailed', { error: String(loadError) }));
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }, [fetchMarketDetail, notification, t]);

  const prepareMarketInstall = useCallback(async (summary: MarketListingSummary) => {
    if (busyListingId) return;
    const requestId = ++detailRequestRef.current;
    setBusyListingId(summary.listingId);
    try {
      const { loaded, status } = await fetchMarketDetail(summary);
      if (requestId !== detailRequestRef.current) return;
      setDetail(loaded);
      setInstalled(status);
      setInstallPrompt(true);
    } catch (loadError) {
      if (requestId !== detailRequestRef.current) return;
      notification.error(t('market.messages.detailFailed', { error: String(loadError) }));
    } finally {
      setBusyListingId((current) => (
        current === summary.listingId ? undefined : current
      ));
    }
  }, [busyListingId, fetchMarketDetail, notification, t]);

  const refreshPersonalizedDetail = () => {
    if (!detail) return;
    const activeSlug = detail.slug;
    void miniAppMarketAPI.getListing(activeSlug)
      .then((updated) => setDetail((current) => (
        current?.slug === activeSlug ? updated : current
      )))
      .catch((error) => log.warn(
        'Failed to refresh MiniApp market detail after account change',
        error,
      ));
  };

  const toggleFavorite = async () => {
    if (!detail) return;
    if (!me) {
      setLoginOpen(true);
      return;
    }
    setDetailActionBusy(true);
    try {
      const result = await miniAppMarketAPI.setFavorite(detail.slug, !detail.isFavorited);
      setDetail({
        ...detail,
        isFavorited: result.isFavorited,
        favoriteCount: result.count,
      });
    } catch (actionError) {
      notification.error(t('market.messages.actionFailed', { error: String(actionError) }));
    } finally {
      setDetailActionBusy(false);
    }
  };

  const rate = async (value: number) => {
    if (!detail) return;
    if (!me) {
      setLoginOpen(true);
      return;
    }
    setDetailActionBusy(true);
    try {
      const result = await miniAppMarketAPI.setRating(detail.slug, value);
      setDetail({
        ...detail,
        ratingAverage: result.average,
        ratingCount: result.count,
        myRating: result.myRating,
      });
    } catch (actionError) {
      notification.error(t('market.messages.actionFailed', { error: String(actionError) }));
    } finally {
      setDetailActionBusy(false);
    }
  };

  const install = async () => {
    if (!detail) return;
    setInstallPrompt(false);
    setBusyListingId(detail.listingId);
    try {
      const result = await miniAppMarketAPI.install(detail.slug, detail.latestRelease, {
        existingAppId: installed?.appId,
        confirmPermissions: true,
        confirmOverwrite: Boolean(installed?.localOverride),
      });
      upsertApp(result.app);
      setMarketOrigin(result.app.id, result.origin);
      setInstalled({
        appId: result.app.id,
        appVersion: result.app.version,
        permissions: result.app.permissions,
        origin: result.origin,
        localOverride: false,
      });
    } catch (installError) {
      notification.error(t('market.messages.installFailed', { error: String(installError) }));
    } finally {
      setBusyListingId(undefined);
    }
  };

  const manageInstalledApp = () => {
    if (!installed) return;
    const app = apps.find((candidate) => candidate.id === installed.appId);
    if (!app) return;
    setDetailOpen(false);
    setSelectedApp(app);
  };

  const permissionLines = detail ? summarizePermissions(detail.permissions, t) : [];
  const installedPermissionLines = installed
    ? summarizePermissions(installed.permissions, t)
    : [];
  const addedPermissionLines = permissionLines.filter(
    (line) => !installedPermissionLines.includes(line),
  );
  const removedPermissionLines = installedPermissionLines.filter(
    (line) => !permissionLines.includes(line),
  );
  const installedReleaseYanked = Boolean(
    detail
      && installed
      && detail.releases.find(
        (release) => release.releaseId === installed.origin.releaseId,
      )?.yanked,
  );
  const detailWorkspaceUnsupported = Boolean(
    detail
      && workspace
      && isRemoteWorkspace(workspace)
      && requiresWorkspace(detail.permissions),
  );
  const releaseHistory = buildReleaseHistory(detail?.releases ?? [], releasesExpanded);
  const canUpdate = Boolean(
    installed && detail && detail.latestRelease > installed.origin.releaseNumber
  );
  const detailName = detail
    ? pickLocalizedString(detail, currentLanguage, 'name')
    : '';
  const detailDescription = detail
    ? pickLocalizedString(detail, currentLanguage, 'description')
    : '';
  const sortOptions = useMemo<SelectOption[]>(() => [
    { value: 'newest', label: t('market.sort.newest') },
    { value: 'downloads', label: t('market.sort.downloads') },
    { value: 'rating', label: t('market.sort.rating') },
  ], [t]);

  const renderLibrary = () => {
    const initialLoading = catalogLoading && marketItems.length === 0 && apps.length === 0;
    if (initialLoading) {
      return (
        <GallerySkeleton
          count={5}
          cardHeight={126}
          minCardWidth={640}
          className="miniapp-gallery__list"
        />
      );
    }

    if (libraryItems.length === 0 && !catalogLoading) {
      return (
        <GalleryEmpty
          icon={{ glyph: PackageCheck }}
          message={query || category !== 'all'
            ? t('empty.noMatch')
            : t('market.library.empty')}
        />
      );
    }

    return (
      <>
        <MarketList className="miniapp-gallery__list" role="list"
          revision={JSON.stringify(libraryItems.map(item => item.key))}
          animate={animateList.current}
          aria-busy={catalogLoading || loadingMore || undefined}
        >
          {libraryItems.map((item) => {
            const source = item.listing ?? item.app;
            if (!source) return null;
            const name = pickLocalizedString(source, currentLanguage, 'name');
            const description = pickLocalizedString(source, currentLanguage, 'description');
            const sourceCategory = item.listing?.category ?? item.app?.category ?? 'other';
            const actionLabel = item.action === 'get'
              ? t('market.library.get')
              : item.action === 'update'
                ? t('market.library.update')
                : t('market.library.open');
            const workspaceUnsupported = Boolean(
              workspace
                && isRemoteWorkspace(workspace)
                && requiresWorkspace(source.permissions),
            );
            const statuses = libraryStatuses(item, activeIdSet, customizingIdSet, t);
            if (workspaceUnsupported) {
              statuses.push({
                label: t('market.library.remoteUnsupported'),
                tone: 'warning',
              });
            }
            const anotherMarketActionBusy = Boolean(
              item.listing
                && item.action !== 'open'
                && busyListingId
                && busyListingId !== item.listing.listingId,
            );
            const metaLabel = item.listing
              ? t('market.library.marketMeta', {
                owner: item.listing.owner.login,
                rating: item.listing.ratingAverage.toFixed(1),
                downloads: formatNumber(item.listing.downloadCount),
              })
              : t('market.library.localMeta');
            const release = item.listing?.latestRelease
              ?? item.origin?.releaseNumber
              ?? item.app?.version
              ?? 1;

            return (
              <MiniAppLibraryRow
                key={item.key}
                itemKey={item.key}
                action={item.action}
                actionDisabled={workspaceUnsupported || anotherMarketActionBusy}
                actionLabel={actionLabel}
                actionTitle={workspaceUnsupported
                  ? t('market.library.remoteUnsupported')
                  : undefined}
                busy={Boolean(item.listing && busyListingId === item.listing.listingId)}
                category={categoryLabel(sourceCategory, t)}
                description={description}
                detailsLabel={t('market.library.viewDetails', { name })}
                downloadCount={item.listing
                  ? formatNumber(item.downloadCount)
                  : undefined}
                localMeta={item.listing ? undefined : t('market.library.localMeta')}
                metaLabel={metaLabel}
                name={name}
                owner={item.listing?.owner.login}
                rating={item.listing ? item.ratingAverage.toFixed(1) : undefined}
                showcaseAlt={t('market.library.showcaseAlt', { name })}
                showcaseFallbackLabel={t('market.library.showcaseFallback', { name })}
                showcaseUrl={item.listing?.screenshotUrls[0]
                  ?? (item.app ? getMiniAppShowcaseAsset(item.app.id) : undefined)}
                statuses={statuses}
                version={t('market.library.version', { version: release })}
                onOpenDetails={() => {
                  if (item.listing) void openMarketDetail(item.listing);
                  else if (item.app) setSelectedApp(item.app);
                }}
                onPrimaryAction={() => {
                  if (item.action === 'open' && item.app) {
                    handleOpenApp(item.app.id);
                  } else if (item.listing) {
                    void prepareMarketInstall(item.listing);
                  }
                }}
              />
            );
          })}
        </MarketList>
        {catalogLoading && marketItems.length === 0 ? (
          <GallerySkeleton
            count={2}
            cardHeight={126}
            minCardWidth={640}
            className="miniapp-gallery__list miniapp-gallery__list--continuation"
          />
        ) : null}
        {nextCursor ? (
          <div className="miniapp-gallery__load-more">
            <Button
              size="sm"
              variant="outline"
              loading={loadingMore}
              onClick={() => void fetchCatalog(nextCursor, true)}
            >
              {t('market.loadMore')}
            </Button>
          </div>
        ) : null}
      </>
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
          <div className="miniapp-gallery__header-actions">
            <AccountIdentityControls
              loginOpen={loginOpen}
              onLoginOpenChange={setLoginOpen}
              onIdentityChanged={refreshPersonalizedDetail}
            />
            <span className="miniapp-gallery__import-anchor">
              <IconButton
                ref={importTriggerRef}
                size="xs"
                onClick={() => setImportMenuOpen((current) => !current)}
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
          </div>
        )}
      />

      {tabs}

      <div
        data-openbitfun-component="miniapp-gallery-view"
        data-openbitfun-part="content"
        className="gallery-zones"
      >
        <section className="gallery-zone" aria-label={t('allApps')}>
          <div className="miniapp-gallery__filters" data-openbitfun-component="miniapp-gallery-view" data-openbitfun-part="tools">
            <SearchField
              className="miniapp-gallery__search"
              leadingIcon={<Icon name="search" size="sm" aria-hidden />}
              onValueChange={value => {
                animateList.current = getInteractionMotion() === 'pointer';
                setQuery(value);
              }}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              size="sm"
              value={query}
            />
            <div data-openbitfun-component="miniapp-gallery-view" data-openbitfun-part="categoryFilters">
              <Select
                className="miniapp-gallery__categories"
                options={CATEGORIES.map((value) => ({ label: categoryLabel(value, t), value }))}
                value={category}
                onValueChange={(value) => {
                  animateList.current = getInteractionMotion() === 'pointer';
                  setCategory(value as MiniAppCategory);
                }}
                aria-label={t('market.catalog')}
                size="sm"
              />
            </div>
            <Select
              className="miniapp-gallery__sort"
              size="sm"
              options={sortOptions}
              value={sort}
              onValueChange={(value) => {
                animateList.current = getInteractionMotion() === 'pointer';
                setSort(value as MarketSort);
              }}
              aria-label={t('market.sortLabel')}
            />
            <span className="miniapp-gallery__result-count" aria-label={t('allApps')}>
              <NumberBadge value={libraryItems.length} />
            </span>
          </div>

          {catalogError ? (
            <div
              className="miniapp-gallery__market-error"
              role="alert"
              data-openbitfun-component="miniapp-gallery-view"
              data-openbitfun-part="error"
            >
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{t('market.library.marketUnavailable')}</span>
              <Button
                size="xs"
                variant="text"
                onClick={() => void fetchCatalog(undefined, false)}
              >
                {t('scene.retry')}
              </Button>
            </div>
          ) : null}

          {renderLibrary()}
        </section>
      </div>

      <MiniAppDetailModal
        app={selectedApp}
        marketReleaseNumber={selectedApp ? marketOrigins[selectedApp.id]?.releaseNumber : undefined}
        isActive={selectedApp ? activeIdSet.has(selectedApp.id) : false}
        isCustomizing={selectedApp ? customizingIdSet.has(selectedApp.id) : false}
        onClose={() => setSelectedApp(null)}
        onOpen={handleOpenApp}
        onDelete={setPendingDeleteId}
        onStop={handleStopRunning}
      />

      <GalleryDetailModal
        isOpen={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={detailName || t('market.detail.loading')}
        titlePlacement="hero"
        size="lg"
        stableHeight
        badges={detail ? (
          <>
            <StatusPill tone="info">{categoryLabel(detail.category, t)}</StatusPill>
            <StatusPill tone="neutral" leading={<ShieldCheck size={11} />}>
              {t('market.detail.reviewed')}
            </StatusPill>
          </>
        ) : null}
        description={detailDescription}
        meta={detail ? <span>{t('market.detail.by', { owner: detail.owner.login })}</span> : null}
        actions={detail ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void toggleFavorite()}
              disabled={detailActionBusy}
              leadingIcon={(
                <Heart size={14} fill={detail.isFavorited ? 'currentColor' : 'none'} />
              )}
            >
              {formatNumber(detail.favoriteCount)}
            </Button>
            {installed && !canUpdate ? (
              <span className="miniapp-market-detail__installed-state">
                <Icon name="check-line" size="sm" />
                {t('market.detail.installed')}
              </span>
            ) : null}
            {installed ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busyListingId === detail.listingId || detailWorkspaceUnsupported}
                onClick={() => handleOpenApp(installed.appId)}
              >
                {t('market.library.open')}
              </Button>
            ) : null}
            {!installed || canUpdate ? (
              <Button
                size="sm"
                variant="primary"
                loading={busyListingId === detail.listingId}
                disabled={detailWorkspaceUnsupported}
                onClick={() => setInstallPrompt(true)}
              >
                {canUpdate ? t('market.library.update') : t('market.library.get')}
              </Button>
            ) : null}
            {installed ? (
              <Button size="sm" variant="text" onClick={manageInstalledApp}>
                {t('market.library.manage')}
              </Button>
            ) : null}
          </>
        ) : null}
      >
        {detailLoading ? (
          <div className="miniapp-market-detail__loading" aria-live="polite">
            <Loader2 size={20} className="gallery-spinning" aria-hidden="true" />
            {t('market.detail.loading')}
          </div>
        ) : null}
        {detail ? (
          <div
            className="miniapp-market-detail"
            data-openbitfun-component="miniapp-gallery-view"
            data-openbitfun-part="detail"
          >
            {detail.screenshotUrls.length ? (
              <div className="miniapp-market-detail__screenshots">
                {detail.screenshotUrls.map((url, index) => (
                  <MarketImage
                    key={url}
                    source={url}
                    responsive
                    sizes="(min-width: 48rem) 360px, 80vw"
                    width={640}
                    height={360}
                    alt={t('market.library.showcaseAlt', { name: detailName })}
                    loading={index === 0 ? 'eager' : 'lazy'}
                    decoding="async"
                  />
                ))}
              </div>
            ) : null}
            {detailWorkspaceUnsupported ? (
              <div className="miniapp-market-detail__warning">
                <AlertTriangle size={16} aria-hidden="true" />
                {t('market.detail.remoteWorkspaceUnsupported')}
              </div>
            ) : null}
            {installed?.localOverride ? (
              <div className="miniapp-market-detail__warning">
                <AlertTriangle size={16} aria-hidden="true" />
                {t('market.detail.localOverride')}
              </div>
            ) : null}
            {installedReleaseYanked ? (
              <div className="miniapp-market-detail__warning">
                <AlertTriangle size={16} aria-hidden="true" />
                {t('market.detail.installedYanked')}
              </div>
            ) : null}
            <section>
              <h4>{t('market.detail.permissions')}</h4>
              {permissionLines.length ? (
                <ul>{permissionLines.map((line) => <li key={line}>{line}</li>)}</ul>
              ) : (
                <p>{t('market.detail.noPermissions')}</p>
              )}
            </section>
            <section>
              <h4>{t('market.detail.rating')}</h4>
              <div className="miniapp-market-detail__rating">
                {[1, 2, 3, 4, 5].map((value) => (
                  <IconButton
                    key={value}
                    size="xs"
                    className="miniapp-market-detail__rating-action"
                    onClick={() => void rate(value)}
                    disabled={detailActionBusy}
                    aria-label={`${t('market.detail.rating')} ${value}`}
                    title={`${t('market.detail.rating')} ${value}`}
                    icon={<Icon name="star" size="lg" />}
                  />
                ))}
                <span>{detail.ratingAverage.toFixed(1)} · {formatNumber(detail.ratingCount)}</span>
              </div>
            </section>
            <section>
              <h4>{t('market.detail.changelog')}</h4>
              <p>{detail.changelog}</p>
            </section>
            <section>
              <h4>{t('market.detail.releases')}</h4>
              <div className="miniapp-market-detail__releases">
                {releaseHistory.visible.map((release) => (
                  <div key={release.releaseId}>
                    <span>v{release.releaseNumber}</span>
                    <span>{release.minOpenBitFunVersion}+</span>
                    {release.yanked
                      ? <StatusPill tone="warning">{t('market.detail.yanked')}</StatusPill>
                      : <Icon name="check-line" size="sm" />}
                  </div>
                ))}
              </div>
              {detail.releases.length > 1 ? (
                <Button
                  variant="text"
                  size="xs"
                  className="miniapp-market-detail__releases-toggle"
                  aria-expanded={releasesExpanded}
                  onClick={() => setReleasesExpanded((current) => !current)}
                  leadingIcon={releasesExpanded
                    ? <Icon name="chevron-up" size="lg" />
                    : <Icon name="chevron-down" size="xs" />}
                >
                  {releasesExpanded
                    ? t('market.detail.releasesCollapse')
                    : t('market.detail.releasesExpand', { count: releaseHistory.hiddenCount })}
                </Button>
              ) : null}
            </section>
            {detail.repositoryUrl ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void systemAPI.openExternal(detail.repositoryUrl!)}
                leadingIcon={<Icon name="arrow-up-right" size="sm" />}
              >
                {t('market.detail.repository')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </GalleryDetailModal>

      <ConfirmDialog
        open={pendingDeleteId !== null}
        onOpenChange={() => setPendingDeleteId(null)}
        onConfirm={handleDeleteConfirm}
        title={t('confirmDelete.title', {
          name: apps.find((app) => app.id === pendingDeleteId)?.name ?? '',
        })}
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

      <ConfirmDialog
        open={installPrompt}
        onOpenChange={setInstallPrompt}
        onConfirm={() => void install()}
        title={t(installed ? 'market.confirmUpdate.title' : 'market.confirmInstall.title', {
          name: detailName,
        })}
        message={[
          installed?.localOverride ? t('market.confirmUpdate.overwrite') : '',
          installed
            ? (
              addedPermissionLines.length
                ? t('market.confirmUpdate.addedPermissions', {
                  permissions: addedPermissionLines.join(', '),
                })
                : t('market.confirmUpdate.noAddedPermissions')
            )
            : (
              permissionLines.length
                ? t('market.confirmInstall.permissions', {
                  permissions: permissionLines.join(', '),
                })
                : t('market.detail.noPermissions')
            ),
          installed && removedPermissionLines.length
            ? t('market.confirmUpdate.removedPermissions', {
              permissions: removedPermissionLines.join(', '),
            })
            : '',
        ].filter(Boolean).join('\n\n')}
        type="warning"
        confirmText={t(installed ? 'market.confirmUpdate.confirm' : 'market.confirmInstall.confirm')}
        cancelText={t('confirmDelete.cancel')}
      />
    </GalleryLayout>
  );
};

function matchesLibraryFilter(
  item: MiniAppLibraryItem,
  query: string,
  category: MiniAppCategory,
  currentLanguage: string,
): boolean {
  const source = item.listing ?? item.app;
  if (!source) return false;
  if (category !== 'all' && source.category.toLowerCase() !== category) return false;

  const keyword = query.trim().toLowerCase();
  if (!keyword) return true;
  const localizedName = pickLocalizedString(source, currentLanguage, 'name').toLowerCase();
  const localizedDescription = pickLocalizedString(
    source,
    currentLanguage,
    'description',
  ).toLowerCase();
  const tags = pickLocalizedTags(source, currentLanguage);
  return [
    localizedName,
    localizedDescription,
    source.name,
    source.description,
    ...tags,
    ...source.tags,
  ].some((value) => value.toLowerCase().includes(keyword));
}

function libraryStatuses(
  item: MiniAppLibraryItem,
  activeIdSet: Set<string>,
  customizingIdSet: Set<string>,
  t: Translate,
): MiniAppLibraryStatus[] {
  const statuses: MiniAppLibraryStatus[] = [];
  const isLocalOnly = Boolean(item.app && !item.listing && !item.origin);

  if (item.action === 'update') {
    statuses.push({ label: t('market.library.updateAvailable'), tone: 'warning' });
  } else if (isLocalOnly) {
    statuses.push({ label: t('market.library.local'), tone: 'neutral' });
  } else if (item.app) {
    statuses.push({ label: t('market.library.installed'), tone: 'success' });
  }

  if (item.app && activeIdSet.has(item.app.id)) {
    statuses.push({ label: t('running'), tone: 'info' });
  } else if (item.app && customizingIdSet.has(item.app.id)) {
    statuses.push({ label: t('market.library.customizing'), tone: 'accent' });
  }
  return statuses;
}

function requiresWorkspace(permissions: MiniAppPermissions): boolean {
  return [
    ...(permissions.fs?.read ?? []),
    ...(permissions.fs?.write ?? []),
  ].includes('{workspace}');
}

function summarizePermissions(
  permissions: MiniAppPermissions,
  t: Translate,
): string[] {
  const result: string[] = [];
  if (permissions.fs?.read?.length) {
    result.push(t('market.permissions.fsRead', { value: permissions.fs.read.join(', ') }));
  }
  if (permissions.fs?.write?.length) {
    result.push(t('market.permissions.fsWrite', { value: permissions.fs.write.join(', ') }));
  }
  if (permissions.shell?.allow?.length) {
    result.push(t('market.permissions.shell', { value: permissions.shell.allow.join(', ') }));
  }
  if (permissions.net?.allow?.length) {
    result.push(t('market.permissions.net', { value: permissions.net.allow.join(', ') }));
  }
  if (permissions.ai?.enabled) result.push(t('market.permissions.ai'));
  if (permissions.agent?.enabled) result.push(t('market.permissions.agent'));
  if (permissions.notifications?.system) result.push(t('market.permissions.notifications'));
  if (permissions.host?.dialog) result.push(t('market.permissions.dialog'));
  if (permissions.host?.clipboard_read) result.push(t('market.permissions.clipboardRead'));
  if (permissions.host?.clipboard_write) result.push(t('market.permissions.clipboardWrite'));
  if (permissions.host?.open_external) result.push(t('market.permissions.openExternal'));
  if (permissions.host?.reveal_in_folder) result.push(t('market.permissions.revealInFolder'));
  if (permissions.host?.deck_render) result.push(t('market.permissions.deckRender'));
  if (permissions.host?.chat_composer) result.push(t('market.permissions.chatComposer'));
  if (permissions.host?.system_info) result.push(t('market.permissions.systemInfo'));
  return result;
}

function categoryLabel(category: string, t: Translate): string {
  switch (category) {
    case 'all': return t('market.categories.all');
    case 'developer': return t('market.categories.developer');
    case 'productivity': return t('market.categories.productivity');
    case 'data': return t('market.categories.data');
    case 'creative': return t('market.categories.creative');
    case 'education': return t('market.categories.education');
    case 'utilities': return t('market.categories.utilities');
    case 'entertainment': return t('market.categories.entertainment');
    default: return t('market.categories.other');
  }
}

const MiniAppLibraryView: React.FC<MiniAppLibraryViewProps> = (props) => {
  const epoch = useSyncExternalStore(onSurfaceActivated, () => getActiveSurfaceScope().epoch);
  return <MiniAppLibraryContent key={epoch} {...props} />;
};

export default MiniAppLibraryView;
