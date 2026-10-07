import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import { OverflowText, Button, Icon, Input, Select, type SelectOption } from '@openbitfun/ui';
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleStop, FileClock, HardDrive, Lock, PanelsTopLeft, Rocket, Save, Users, type LucideIcon } from 'lucide-react';
import { RetainedMountBoundary } from '@/shared/presence';
import { confirmDanger, confirmWarning } from '@/infrastructure/confirm-dialog';
import { GalleryEmpty, GalleryLayout, GalleryPageHeader } from '@/app/components/GalleryLayout';
import {
  pageAPI,
  type PageInfo,
  type PageVersionInfo,
  type PageVisibility,
} from '@/infrastructure/api/service-api/PageAPI';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { remoteConnectAPI } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { useI18n } from '@/infrastructure/i18n';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import './PagesScene.scss';

const log = createLogger('PagesScene');
const RemoteConnectDialog = lazyWithRecovery(() => import('@/app/components/RemoteConnectDialog'));

interface PagesSceneProps {
  isActive?: boolean;
}

interface PageOwner {
  userId: string;
  epoch: number;
}

interface PageActionLease {
  slug: string;
  key: string;
  token: string;
  userId: string;
  ownerEpoch: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replacePage(pages: PageInfo[], updated: PageInfo): PageInfo[] {
  return pages.map((page) => (page.slug === updated.slug ? updated : page));
}

const VISIBILITY_ICONS: Record<Exclude<PageVisibility, 'public'>, LucideIcon> = {
  private: Lock,
  relay: Users,
};

function renderVisibilityIcon(visibility: PageVisibility): React.ReactNode {
  if (visibility === 'public') {
    return <Icon name="browser" size="xs" aria-hidden />;
  }
  const VisibilityIcon = VISIBILITY_ICONS[visibility];
  return <VisibilityIcon size={12} aria-hidden="true" />;
}

const PagesScene: React.FC<PagesSceneProps> = ({ isActive = true }) => {
  const { t, formatDate, formatNumber } = useI18n('scenes/pages');
  const notification = useNotification();
  const attemptedLoadRef = useRef(false);
  const pageLoadEpochRef = useRef(0);
  const pageOwnerRef = useRef<PageOwner | null>(null);
  const pageOwnerEpochCounterRef = useRef(0);
  const nextActionTokenRef = useRef(0);
  const [pageOwnerEpoch, setPageOwnerEpoch] = useState(0);
  const pagesRef = useRef<PageInfo[]>([]);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [relayBaseUrl, setRelayBaseUrl] = useState('');
  const [versionsBySlug, setVersionsBySlug] = useState<Record<string, PageVersionInfo[]>>({});
  const [expandedSlugs, setExpandedSlugs] = useState<Set<string>>(() => new Set());
  const [managedSlugs, setManagedSlugs] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loginRequired, setLoginRequired] = useState(false);
  const [showAccountDialog, setShowAccountDialog] = useState(false);
  const [pendingBySlug, setPendingBySlug] = useState<Record<string, string>>({});
  const busySlugsRef = useRef<Map<string, string>>(new Map());
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});

  const cancelPendingPageLoad = useCallback(() => {
    pageLoadEpochRef.current += 1;
    setLoading(false);
  }, []);

  const adoptPageOwner = useCallback((
    userId: string | null,
    cancelLoads: boolean,
    forceNewEpoch = false,
  ): number => {
    const current = pageOwnerRef.current;
    if (!forceNewEpoch && (current?.userId ?? null) === userId) {
      return current?.epoch ?? pageOwnerEpochCounterRef.current;
    }
    const epoch = pageOwnerEpochCounterRef.current + 1;
    pageOwnerEpochCounterRef.current = epoch;
    pageOwnerRef.current = userId ? { userId, epoch } : null;
    setPageOwnerEpoch(epoch);
    if (cancelLoads) pageLoadEpochRef.current += 1;
    busySlugsRef.current.clear();
    pagesRef.current = [];
    setPages([]);
    setRelayBaseUrl('');
    setVersionsBySlug({});
    setExpandedSlugs(new Set());
    setManagedSlugs(new Set());
    setTitleDrafts({});
    setPendingBySlug({});
    setLoadError('');
    setLoading(false);
    setLoginRequired(userId === null);
    return epoch;
  }, []);

  const updateOwnedPages = useCallback((
    update: (current: PageInfo[]) => PageInfo[],
  ) => {
    const next = update(pagesRef.current);
    pagesRef.current = next;
    setPages(next);
  }, []);

  const commitLoadedPages = useCallback((nextPages: PageInfo[]) => {
    const previousGenerationBySlug = new Map(
      pagesRef.current.map((page) => [page.slug, page.generation]),
    );
    const nextGenerationBySlug = new Map(
      nextPages.map((page) => [page.slug, page.generation]),
    );
    const canRetainSlugState = (slug: string) => {
      const previousGeneration = previousGenerationBySlug.get(slug);
      return previousGeneration !== undefined
        && previousGeneration === nextGenerationBySlug.get(slug);
    };

    for (const slug of busySlugsRef.current.keys()) {
      if (!canRetainSlugState(slug)) busySlugsRef.current.delete(slug);
    }
    setVersionsBySlug((current) => Object.fromEntries(
      Object.entries(current).filter(([slug]) => canRetainSlugState(slug)),
    ));
    setExpandedSlugs((current) => new Set(
      [...current].filter((slug) => canRetainSlugState(slug)),
    ));
    setManagedSlugs((current) => new Set(
      [...current].filter((slug) => canRetainSlugState(slug)),
    ));
    setTitleDrafts((current) => Object.fromEntries(
      Object.entries(current).filter(([slug]) => canRetainSlugState(slug)),
    ));
    setPendingBySlug((current) => Object.fromEntries(
      Object.entries(current).filter(([slug]) => canRetainSlugState(slug)),
    ));
    pagesRef.current = nextPages;
    setPages(nextPages);
  }, []);

  const isPageActionCurrent = useCallback((lease: PageActionLease): boolean => {
    const owner = pageOwnerRef.current;
    return owner?.userId === lease.userId
      && owner.epoch === lease.ownerEpoch
      && busySlugsRef.current.get(lease.slug) === lease.token;
  }, []);

  const endPageAction = useCallback((lease: PageActionLease) => {
    if (busySlugsRef.current.get(lease.slug) !== lease.token) return;
    busySlugsRef.current.delete(lease.slug);
    setPendingBySlug((current) => {
      if (current[lease.slug] !== lease.key) return current;
      const next = { ...current };
      delete next[lease.slug];
      return next;
    });
  }, []);

  const beginPageAction = useCallback(async (
    page: PageInfo,
    key: string,
    expectedOwnerEpoch: number,
  ): Promise<PageActionLease | null> => {
    const owner = pageOwnerRef.current;
    if (!owner || owner.epoch !== expectedOwnerEpoch || busySlugsRef.current.has(page.slug)) {
      return null;
    }
    const token = `${owner.epoch}:${nextActionTokenRef.current += 1}`;
    const lease: PageActionLease = {
      slug: page.slug,
      key,
      token,
      userId: owner.userId,
      ownerEpoch: owner.epoch,
    };
    // A list response captured before this mutation must never overwrite the
    // operation's newer result when it eventually arrives.
    cancelPendingPageLoad();
    busySlugsRef.current.set(page.slug, token);
    setPendingBySlug((current) => ({ ...current, [page.slug]: key }));
    const status = await remoteConnectAPI.accountStatus().catch(() => null);
    if (!status?.logged_in || status.user_id !== owner.userId || !isPageActionCurrent(lease)) {
      if (status) {
        adoptPageOwner(status.logged_in ? status.user_id : null, true);
        attemptedLoadRef.current = !status.logged_in;
      }
      endPageAction(lease);
      return null;
    }
    return lease;
  }, [adoptPageOwner, cancelPendingPageLoad, endPageAction, isPageActionCurrent]);

  const validatePageAction = useCallback(async (lease: PageActionLease): Promise<boolean> => {
    if (!isPageActionCurrent(lease)) return false;
    const status = await remoteConnectAPI.accountStatus().catch(() => null);
    if (!status?.logged_in || status.user_id !== lease.userId || !isPageActionCurrent(lease)) {
      if (status) {
        adoptPageOwner(status.logged_in ? status.user_id : null, true);
        attemptedLoadRef.current = !status.logged_in;
      }
      return false;
    }
    return true;
  }, [adoptPageOwner, isPageActionCurrent]);

  const visibilityOptions = useMemo<SelectOption[]>(() => [
    { value: 'private', label: t('visibility.private') },
    { value: 'relay', label: t('visibility.relay') },
    { value: 'public', label: t('visibility.public') },
  ], [t]);

  const visibilityLabel = useCallback((visibility: PageVisibility): string => {
    switch (visibility) {
      case 'private': return t('visibility.private');
      case 'relay': return t('visibility.relay');
      case 'public': return t('visibility.public');
    }
  }, [t]);

  const visibilityHint = useCallback((visibility: PageVisibility): string => {
    switch (visibility) {
      case 'private': return t('visibility.privateHint');
      case 'relay': return t('visibility.relayHint');
      case 'public': return t('visibility.publicHint');
    }
  }, [t]);

  const deployedCount = useMemo(
    () => pages.filter((page) => Boolean(page.deployed_version_id)).length,
    [pages],
  );

  const formatBytes = useCallback((bytes: number): string => {
    if (bytes < 1024) return t('bytes.b', { value: formatNumber(bytes) });
    if (bytes < 1024 * 1024) {
      return t('bytes.kb', { value: formatNumber(bytes / 1024, { maximumFractionDigits: 1 }) });
    }
    return t('bytes.mb', {
      value: formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 1 }),
    });
  }, [formatNumber, t]);

  const formatTimestamp = useCallback((seconds: number): string => formatDate(
    new Date(seconds * 1000),
    { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  ), [formatDate]);

  const loadPages = useCallback(async () => {
    if (busySlugsRef.current.size > 0) return;
    const requestEpoch = pageLoadEpochRef.current + 1;
    pageLoadEpochRef.current = requestEpoch;
    attemptedLoadRef.current = true;
    setLoading(true);
    setLoadError('');
    setLoginRequired(false);
    let requestedUserId: string | null = null;
    try {
      const status = await remoteConnectAPI.accountStatus();
      if (pageLoadEpochRef.current !== requestEpoch) return;
      requestedUserId = status.user_id;
      if (!status.logged_in || !status.user_id) {
        adoptPageOwner(null, false);
        setLoginRequired(true);
        return;
      }
      const ownerEpoch = adoptPageOwner(status.user_id, false);
      const [nextPages, hint] = await Promise.all([
        pageAPI.listPages(),
        remoteConnectAPI.accountGetCredentialHint().catch(() => null),
      ]);
      const latestStatus = await remoteConnectAPI.accountStatus().catch(() => null);
      if (pageLoadEpochRef.current !== requestEpoch) return;
      if (!latestStatus?.logged_in || latestStatus.user_id !== status.user_id) {
        // The account changed while this relay request was in flight. Leave
        // ownership of the UI to a fresh request for the new account.
        adoptPageOwner(latestStatus?.logged_in ? latestStatus.user_id : null, true);
        attemptedLoadRef.current = !latestStatus?.logged_in;
        return;
      }
      const currentOwner = pageOwnerRef.current;
      if (currentOwner?.userId !== status.user_id || currentOwner.epoch !== ownerEpoch) return;
      commitLoadedPages(nextPages);
      setRelayBaseUrl(hint?.relay_url?.replace(/\/$/, '') ?? '');
    } catch (error) {
      if (pageLoadEpochRef.current !== requestEpoch) return;
      log.error('Failed to load published Pages', { error });
      const latestStatus = await remoteConnectAPI.accountStatus().catch(() => null);
      if (pageLoadEpochRef.current !== requestEpoch) return;
      if (requestedUserId !== null
        && latestStatus?.logged_in
        && latestStatus.user_id !== requestedUserId) {
        adoptPageOwner(latestStatus.user_id, true);
        attemptedLoadRef.current = false;
        return;
      }
      if (latestStatus && !latestStatus.logged_in) {
        adoptPageOwner(null, true);
        setLoginRequired(true);
        return;
      }
      setLoadError(errorText(error));
    } finally {
      if (pageLoadEpochRef.current === requestEpoch) {
        setLoading(false);
      }
    }
  }, [adoptPageOwner, commitLoadedPages]);

  useEffect(() => {
    if (isActive && !attemptedLoadRef.current && !loading) {
      void loadPages();
    }
  }, [isActive, loadPages, loading]);

  useEffect(() => {
    const unlisten = api.listen<{ logged_in: boolean }>(
      'account://login-state',
      (payload) => {
        const loggedIn = payload?.logged_in === true;
        // The event intentionally carries no user id. Treat every transition,
        // including a same-user re-login, as a new ownership generation before
        // doing any asynchronous status lookup. This immediately removes data
        // and actions owned by the previous authenticated session.
        adoptPageOwner(null, true, true);
        attemptedLoadRef.current = !loggedIn;
        if (loggedIn && isActive) {
          void loadPages();
        }
      },
    );
    return unlisten;
  }, [adoptPageOwner, isActive, loadPages]);

  const loadVersions = useCallback(async (page: PageInfo, ownerEpoch: number) => {
    const key = `versions:${page.slug}`;
    const lease = await beginPageAction(page, key, ownerEpoch);
    if (!lease) return;
    try {
      const versions = await pageAPI.listVersions(page.slug, page.generation);
      if (!await validatePageAction(lease)) return;
      setVersionsBySlug((current) => ({ ...current, [page.slug]: versions }));
    } catch (error) {
      if (!await validatePageAction(lease)) return;
      log.error('Failed to load Page versions', { slug: page.slug, error });
      notification.error(t('notifications.versionsLoadFailed', { error: errorText(error) }));
      throw error;
    } finally {
      endPageAction(lease);
    }
  }, [beginPageAction, endPageAction, notification, t, validatePageAction]);

  const toggleVersions = useCallback(async (page: PageInfo, ownerEpoch: number) => {
    if (expandedSlugs.has(page.slug)) {
      setExpandedSlugs((current) => {
        const next = new Set(current);
        next.delete(page.slug);
        return next;
      });
      return;
    }
    if (!versionsBySlug[page.slug]) {
      try {
        await loadVersions(page, ownerEpoch);
      } catch {
        return;
      }
    }
    if (pageOwnerRef.current?.epoch === ownerEpoch) {
      setManagedSlugs((current) => {
        const next = new Set(current);
        next.delete(page.slug);
        return next;
      });
      setExpandedSlugs((current) => new Set(current).add(page.slug));
    }
  }, [expandedSlugs, loadVersions, versionsBySlug]);

  const toggleManagement = useCallback((slug: string) => {
    const willOpen = !managedSlugs.has(slug);
    setManagedSlugs((current) => {
      const next = new Set(current);
      if (willOpen) {
        next.add(slug);
      } else {
        next.delete(slug);
      }
      return next;
    });
    if (willOpen) {
      setExpandedSlugs((expanded) => {
        const collapsed = new Set(expanded);
        collapsed.delete(slug);
        return collapsed;
      });
    }
  }, [managedSlugs]);

  const openPage = useCallback(async (
    page: PageInfo,
    ownerEpoch: number,
    versionId?: string,
  ) => {
    const key = `open:${page.slug}:${versionId ?? 'production'}`;
    const lease = await beginPageAction(page, key, ownerEpoch);
    if (!lease) return;
    try {
      const link = await pageAPI.createOpenLink(page.slug, page.generation, versionId);
      if (!await validatePageAction(lease)) return;
      await systemAPI.openExternal(link.open_url);
    } catch (error) {
      if (!await validatePageAction(lease)) return;
      log.error('Failed to open Page', { slug: page.slug, versionId, error });
      notification.error(t('notifications.openFailed', { error: errorText(error) }));
    } finally {
      endPageAction(lease);
    }
  }, [beginPageAction, endPageAction, notification, t, validatePageAction]);

  const copyPageLink = useCallback(async (
    page: PageInfo,
    ownerEpoch: number,
    version?: PageVersionInfo,
  ) => {
    const key = `copy:${page.slug}:${version?.version_id ?? 'production'}`;
    const lease = await beginPageAction(page, key, ownerEpoch);
    if (!lease) return;
    try {
      const path = version?.preview_url_path ?? page.url_path;
      const url = /^https?:\/\//i.test(path)
        ? path
        : relayBaseUrl && path
          ? `${relayBaseUrl}${path.startsWith('/') ? '' : '/'}${path}`
        : (await pageAPI.createOpenLink(
          page.slug,
          page.generation,
          version?.version_id,
        )).page_url;
      if (!await validatePageAction(lease)) return;
      await systemAPI.setClipboard(url);
      notification.success(page.visibility === 'public'
        ? t('notifications.linkCopied')
        : t('notifications.protectedLinkCopied'));
    } catch (error) {
      if (!await validatePageAction(lease)) return;
      log.error('Failed to copy Page link', {
        slug: page.slug,
        versionId: version?.version_id,
        error,
      });
      notification.error(t('notifications.copyFailed', { error: errorText(error) }));
    } finally {
      endPageAction(lease);
    }
  }, [beginPageAction, endPageAction, notification, relayBaseUrl, t, validatePageAction]);

  const changeVisibility = useCallback(async (
    page: PageInfo,
    ownerEpoch: number,
    visibility: PageVisibility,
  ) => {
    if (visibility === page.visibility) return;
    const confirmed = await confirmWarning(
      t('confirm.visibilityTitle'),
      t('confirm.visibilityMessage', {
        slug: page.slug,
        current: visibilityLabel(page.visibility),
        target: visibilityLabel(visibility),
      }),
      { confirmText: t('actions.changeVisibility') },
    );
    if (!confirmed) return;
    const key = `visibility:${page.slug}`;
    const lease = await beginPageAction(page, key, ownerEpoch);
    if (!lease) return;
    try {
      const updated = await pageAPI.update(page.slug, page.generation, { visibility });
      if (!await validatePageAction(lease)) return;
      updateOwnedPages((current) => replacePage(current, updated));
      notification.success(t('notifications.visibilityUpdated', {
        visibility: visibilityLabel(visibility),
      }));
    } catch (error) {
      if (!await validatePageAction(lease)) return;
      log.error('Failed to update Page visibility', { slug: page.slug, visibility, error });
      notification.error(t('notifications.visibilityFailed', { error: errorText(error) }));
    } finally {
      endPageAction(lease);
    }
  }, [beginPageAction, endPageAction, notification, t, updateOwnedPages, validatePageAction, visibilityLabel]);

  const saveTitle = useCallback(async (page: PageInfo, ownerEpoch: number) => {
    const title = (titleDrafts[page.slug] ?? page.title).trim();
    if (!title || title === page.title) return;
    const key = `title:${page.slug}`;
    const lease = await beginPageAction(page, key, ownerEpoch);
    if (!lease) return;
    try {
      const updated = await pageAPI.update(page.slug, page.generation, { title });
      if (!await validatePageAction(lease)) return;
      updateOwnedPages((current) => replacePage(current, updated));
      setTitleDrafts((current) => ({ ...current, [page.slug]: updated.title }));
      notification.success(t('notifications.titleUpdated'));
    } catch (error) {
      if (!await validatePageAction(lease)) return;
      log.error('Failed to update Page title', { slug: page.slug, error });
      notification.error(t('notifications.titleFailed', { error: errorText(error) }));
    } finally {
      endPageAction(lease);
    }
  }, [beginPageAction, endPageAction, notification, t, titleDrafts, updateOwnedPages, validatePageAction]);

  const deployVersion = useCallback(async (
    page: PageInfo,
    ownerEpoch: number,
    version: PageVersionInfo,
  ) => {
    if (version.deployed) return;
    const confirmed = await confirmWarning(
      t('confirm.deployTitle'),
      t('confirm.deployMessage', {
        slug: page.slug,
        current: page.deployed_version_id ?? t('status.notDeployed'),
        target: version.version_id,
      }),
      { confirmText: t('actions.deploy') },
    );
    if (!confirmed) return;
    const key = `deploy:${page.slug}:${version.version_id}`;
    const lease = await beginPageAction(page, key, ownerEpoch);
    if (!lease) return;
    try {
      const updated = await pageAPI.deploy(page.slug, page.generation, version.version_id);
      if (!await validatePageAction(lease)) return;
      updateOwnedPages((current) => replacePage(current, updated));
      setVersionsBySlug((current) => ({
        ...current,
        [page.slug]: (current[page.slug] ?? []).map((item) => ({
          ...item,
          deployed: item.version_id === version.version_id,
        })),
      }));
      notification.success(t('notifications.deployed', { version: version.version_id }));
    } catch (error) {
      if (!await validatePageAction(lease)) return;
      log.error('Failed to deploy Page version', {
        slug: page.slug,
        versionId: version.version_id,
        error,
      });
      notification.error(t('notifications.deployFailed', { error: errorText(error) }));
    } finally {
      endPageAction(lease);
    }
  }, [beginPageAction, endPageAction, notification, t, updateOwnedPages, validatePageAction]);

  const unpublishPage = useCallback(async (page: PageInfo, ownerEpoch: number) => {
    if (!page.deployed_version_id) return;
    const confirmed = await confirmWarning(
      t('confirm.unpublishTitle'),
      t('confirm.unpublishMessage', {
        slug: page.slug,
        current: page.deployed_version_id,
      }),
      { confirmText: t('actions.unpublish') },
    );
    if (!confirmed) return;
    const key = `unpublish:${page.slug}`;
    const lease = await beginPageAction(page, key, ownerEpoch);
    if (!lease) return;
    try {
      await pageAPI.unpublish(page.slug, page.generation);
      if (!await validatePageAction(lease)) return;
      updateOwnedPages((current) => current.map((item) => (
        item.slug === page.slug ? { ...item, deployed_version_id: null } : item
      )));
      setVersionsBySlug((current) => ({
        ...current,
        [page.slug]: (current[page.slug] ?? []).map((item) => ({ ...item, deployed: false })),
      }));
      notification.success(t('notifications.unpublished'));
    } catch (error) {
      if (!await validatePageAction(lease)) return;
      log.error('Failed to unpublish Page', { slug: page.slug, error });
      notification.error(t('notifications.unpublishFailed', { error: errorText(error) }));
    } finally {
      endPageAction(lease);
    }
  }, [beginPageAction, endPageAction, notification, t, updateOwnedPages, validatePageAction]);

  const deleteVersion = useCallback(async (
    page: PageInfo,
    ownerEpoch: number,
    version: PageVersionInfo,
  ) => {
    if (version.deployed) return;
    const confirmed = await confirmDanger(
      t('confirm.deleteVersionTitle'),
      t('confirm.deleteVersionMessage', { version: version.version_id, title: page.title }),
      { confirmText: t('actions.deleteVersion') },
    );
    if (!confirmed) return;
    const key = `delete-version:${page.slug}:${version.version_id}`;
    const lease = await beginPageAction(page, key, ownerEpoch);
    if (!lease) return;
    try {
      await pageAPI.deleteVersion(page.slug, page.generation, version.version_id);
      if (!await validatePageAction(lease)) return;
      setVersionsBySlug((current) => ({
        ...current,
        [page.slug]: (current[page.slug] ?? [])
          .filter((item) => item.version_id !== version.version_id),
      }));
      notification.success(t('notifications.versionDeleted'));
    } catch (error) {
      if (!await validatePageAction(lease)) return;
      log.error('Failed to delete Page version', {
        slug: page.slug,
        versionId: version.version_id,
        error,
      });
      notification.error(t('notifications.versionDeleteFailed', { error: errorText(error) }));
    } finally {
      endPageAction(lease);
    }
  }, [beginPageAction, endPageAction, notification, t, validatePageAction]);

  const deletePage = useCallback(async (page: PageInfo, ownerEpoch: number) => {
    const confirmed = await confirmDanger(
      t('confirm.deletePageTitle'),
      t('confirm.deletePageMessage', { title: page.title, slug: page.slug }),
      { confirmText: t('actions.deletePage') },
    );
    if (!confirmed) return;
    const key = `delete-page:${page.slug}`;
    const lease = await beginPageAction(page, key, ownerEpoch);
    if (!lease) return;
    try {
      await pageAPI.deletePage(page.slug, page.generation);
      if (!await validatePageAction(lease)) return;
      updateOwnedPages((current) => current.filter((item) => item.slug !== page.slug));
      setVersionsBySlug((current) => {
        const next = { ...current };
        delete next[page.slug];
        return next;
      });
      notification.success(t('notifications.pageDeleted'));
    } catch (error) {
      if (!await validatePageAction(lease)) return;
      log.error('Failed to delete Page', { slug: page.slug, error });
      notification.error(t('notifications.pageDeleteFailed', { error: errorText(error) }));
    } finally {
      endPageAction(lease);
    }
  }, [beginPageAction, endPageAction, notification, t, updateOwnedPages, validatePageAction]);

  const refreshButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void loadPages()}
      disabled={loading || Object.keys(pendingBySlug).length > 0}
      leadingIcon={<Icon name="refresh" size="sm" className={loading ? 'pages-scene__spinning' : undefined} />}
    >

      {t('actions.refresh')}
    </Button>
  );

  return (
    <GalleryLayout className="pages-scene" data-testid="pages-scene" data-openbitfun-scene="pages" data-openbitfun-part="root">
      <GalleryPageHeader
        data-openbitfun-scene="pages"
        data-openbitfun-part="header"
        title={t('title')}
        subtitle={t('subtitle')}
        actions={refreshButton}
        extraContent={!loading && pages.length > 0 ? (
          <div className="pages-scene__summary">
            <span className="pages-scene__summary-chip">
              <PanelsTopLeft size={12} aria-hidden="true" />
              {t('summary.total', { count: formatNumber(pages.length) })}
            </span>
            {deployedCount > 0 && (
              <span className="pages-scene__summary-chip is-live">
                <span className="pages-scene__live-dot" aria-hidden="true" />
                {t('summary.deployed', { count: formatNumber(deployedCount) })}
              </span>
            )}
          </div>
        ) : null}
      />

      <div className="pages-scene__content" data-openbitfun-scene="pages" data-openbitfun-part="content">
        {loadError && pages.length > 0 && (
          <div className="pages-scene__refresh-error" role="alert" data-testid="pages-refresh-error" data-openbitfun-scene="pages" data-openbitfun-part="error">
            <span>{t('loadFailed')}</span>
            <small><OverflowText>{loadError}</OverflowText></small>
            <Button variant="outline" size="sm" onClick={() => void loadPages()}>
              {t('actions.retry')}
            </Button>
          </div>
        )}

        {loading && pages.length === 0 ? (
          <div
            className="pages-scene__grid"
            data-openbitfun-scene="pages"
            data-openbitfun-part="loading"
            data-testid="pages-loading"
            role="status"
            aria-busy="true"
            aria-label={t('loading')}
          >
            {[0, 1, 2].map((index) => (
              <div className="pages-scene__card pages-scene__card--skeleton" key={index}>
                <div className="pages-scene__skeleton-head">
                  <span className="pages-scene__skeleton-block" />
                  <span className="pages-scene__skeleton-lines">
                    <span className="pages-scene__skeleton-line is-w-55" />
                    <span className="pages-scene__skeleton-line is-w-35" />
                  </span>
                </div>
                <span className="pages-scene__skeleton-line is-w-80" />
                <span className="pages-scene__skeleton-line is-w-65" />
                <span className="pages-scene__skeleton-line is-w-45" />
              </div>
            ))}
          </div>
        ) : loginRequired ? (
          <GalleryEmpty
            data-openbitfun-scene="pages"
            data-openbitfun-part="empty"
            icon={{ glyph: PanelsTopLeft }}
            message={<>{t('signInRequired')}<small>{t('signInHint')}</small></>}
            action={(
              <Button variant="primary" size="sm" onClick={() => setShowAccountDialog(true)}>
                {t('actions.signIn')}
              </Button>
            )}
            testId="pages-sign-in-required"
          />
        ) : loadError && pages.length === 0 ? (
          <GalleryEmpty
            data-openbitfun-scene="pages"
            data-openbitfun-part="error"
            icon={{ glyph: PanelsTopLeft }}
            message={<>{t('loadFailed')}<small>{loadError}</small></>}
            isError
            action={<Button variant="outline" size="sm" onClick={() => void loadPages()}>{t('actions.retry')}</Button>}
            testId="pages-error"
          />
        ) : pages.length === 0 ? (
          <GalleryEmpty
            data-openbitfun-scene="pages"
            data-openbitfun-part="empty"
            icon={{ glyph: PanelsTopLeft }}
            message={<>{t('empty')}<small>{t('emptyHint')}</small></>}
            testId="pages-empty"
          />
        ) : (
          <div className="pages-scene__grid" role="list" data-openbitfun-scene="pages" data-openbitfun-part="list">
            {pages.map((page) => {
              const versions = versionsBySlug[page.slug] ?? [];
              const expanded = expandedSlugs.has(page.slug);
              const managing = managedSlugs.has(page.slug);
              const deployed = Boolean(page.deployed_version_id);
              const pendingAction = pendingBySlug[page.slug];
              const pageBusy = Boolean(pendingAction);
              const titleDraft = titleDrafts[page.slug] ?? page.title;
              const titleDirty = titleDraft.trim().length > 0 && titleDraft.trim() !== page.title;
              const titleSaving = pendingAction === `title:${page.slug}`;
              const managementId = `page-management-${page.slug}`;
              const versionsId = `page-versions-${page.slug}`;
              return (
                <article className="pages-scene__card" key={page.slug} role="listitem">
                <header className="pages-scene__card-head">
                  <span className="pages-scene__card-icon" aria-hidden="true">
                    <PanelsTopLeft size={18} />
                  </span>
                  <div className="pages-scene__identity">
                    <h3 title={page.title || page.slug}><OverflowText>{page.title || page.slug}</OverflowText></h3>
                    <code className="pages-scene__slug"><OverflowText>/{page.slug}</OverflowText></code>
                  </div>
                  <span className={`pages-scene__status${deployed ? ' is-deployed' : ''}`}>
                    <span className="pages-scene__status-dot" aria-hidden="true" />
                    {deployed ? t('status.deployed') : t('status.savedOnly')}
                  </span>
                </header>

                <div className="pages-scene__meta">
                  <span className="pages-scene__meta-item">
                    <Icon name="clock" size="xs" aria-hidden="true" />
                    {t('meta.updated', { date: formatTimestamp(page.updated_at) })}
                  </span>
                  <span className="pages-scene__meta-item">
                    <HardDrive size={12} aria-hidden="true" />
                    {t('meta.size', { size: formatBytes(page.total_bytes) })}
                  </span>
                  <span className="pages-scene__meta-item">
                    <Icon name="files" size="xs" aria-hidden="true" />
                    {t('meta.files', { count: page.file_count })}
                  </span>
                  <span
                    className="pages-scene__meta-item pages-scene__meta-item--visibility"
                    title={visibilityHint(page.visibility)}
                  >
                    {renderVisibilityIcon(page.visibility)}
                    {visibilityLabel(page.visibility)}
                  </span>
                </div>

                <footer className="pages-scene__actions">
                  {deployed && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void openPage(page, pageOwnerEpoch)}
                      disabled={pageBusy}
                      loading={pendingAction === `open:${page.slug}:production`}
                      leadingIcon={<Icon name="arrow-up-right" size="xs" />}
                    >
                       {t('actions.openProduction')}
                    </Button>
                  )}
                  {deployed && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void copyPageLink(page, pageOwnerEpoch)}
                      disabled={pageBusy}
                      loading={pendingAction === `copy:${page.slug}:production`}
                      leadingIcon={<Icon name="duplicate" size="xs" />}
                    >
                       {t('actions.copyLink')}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void toggleVersions(page, pageOwnerEpoch)}
                    disabled={pageBusy}
                    loading={pendingAction === `versions:${page.slug}`}
                    aria-expanded={expanded}
                    aria-controls={versionsId}
                    leadingIcon={<FileClock size={13} />}
                  >
                     {t('actions.versions')}
                    {versions.length > 0 && (
                      <span className="pages-scene__count-badge">{formatNumber(versions.length)}</span>
                    )}
                    {expanded ? <Icon name="chevron-up" size="lg" style={{ width: 13, height: 13 }} /> : <Icon name="chevron-down" size="xs" />}
                  </Button>
                  <span className="pages-scene__actions-spacer" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => toggleManagement(page.slug)}
                    disabled={pageBusy}
                    aria-expanded={managing}
                    aria-controls={managementId}
                    leadingIcon={<Icon name="settings" size="xs" />}
                  >
                     {t('actions.manage')}
                    {managing ? <Icon name="chevron-up" size="lg" style={{ width: 13, height: 13 }} /> : <Icon name="chevron-down" size="xs" />}
                  </Button>
                </footer>

                <section
                  id={managementId}
                  className="pages-scene__management"
                  aria-labelledby={`${managementId}-title`}
                  hidden={!managing}
                >
                  <div className="pages-scene__management-heading">
                    <h4 id={`${managementId}-title`}>{t('manage.title')}</h4>
                    <p>{t('manage.description')}</p>
                  </div>

                  <div className="pages-scene__settings">
                    <div className="pages-scene__setting-field">
                      <span className="pages-scene__setting-label">{t('titleField.label')}</span>
                      <div className="pages-scene__title-control">
                        <Input
                          className="pages-scene__title-input"
                          value={titleDraft}
                          maxLength={120}
                          disabled={pageBusy}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setTitleDrafts((current) => ({
                              ...current,
                              [page.slug]: value,
                            }));
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveTitle(page, pageOwnerEpoch);
                          }}
                          aria-label={t('titleField.inputAria', { slug: page.slug })}
                          size="sm"
                        />
                        {(titleDirty || titleSaving) && (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={pageBusy || !titleDirty}
                            loading={titleSaving}
                            onClick={() => void saveTitle(page, pageOwnerEpoch)}
                            leadingIcon={<Save size={13} />}
                          >
                             {t('actions.saveTitle')}
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="pages-scene__setting-field">
                      <span className="pages-scene__setting-label">{t('visibility.label')}</span>
                      <div className="pages-scene__visibility-control">
                        <Select
                          size="sm"
                          value={page.visibility}
                          options={visibilityOptions}
                          disabled={pageBusy}
                          onValueChange={(value) => void changeVisibility(
                            page,
                            pageOwnerEpoch,
                            String(value) as PageVisibility,
                          )}
                          aria-label={t('visibility.changeAria', { title: page.title || page.slug })}
                        />
                        <span className="pages-scene__visibility-hint">
                          {renderVisibilityIcon(page.visibility)}
                          {visibilityHint(page.visibility)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="pages-scene__management-danger">
                    <div className="pages-scene__management-danger-copy">
                      <strong>{t('manage.lifecycleTitle')}</strong>
                      <span>{t('manage.lifecycleDescription')}</span>
                    </div>
                    <div className="pages-scene__management-actions">
                      {deployed && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void unpublishPage(page, pageOwnerEpoch)}
                          disabled={pageBusy}
                          loading={pendingAction === `unpublish:${page.slug}`}
                          leadingIcon={<CircleStop size={13} />}
                        >
                           {t('actions.unpublish')}
                        </Button>
                      )}
                      <Button
                        variant="fill"
                        tone="danger"
                        size="sm"
                        onClick={() => void deletePage(page, pageOwnerEpoch)}
                        disabled={pageBusy}
                        loading={pendingAction === `delete-page:${page.slug}`}
                        leadingIcon={<Icon name="delete" size="lg" style={{ width: 13, height: 13 }} />}
                      >
                         {t('actions.deletePage')}
                      </Button>
                    </div>
                  </div>
                </section>

                {expanded && (
                  <div
                    id={versionsId}
                    className="pages-scene__versions"
                    data-testid={`page-versions-${page.slug}`}
                  >
                    <div className="pages-scene__versions-heading">
                      <span>
                        <FileClock size={13} aria-hidden="true" />
                        {t('versions.title')}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pageBusy}
                        onClick={() => void loadVersions(page, pageOwnerEpoch)}
                        leadingIcon={<Icon name="refresh" size="xs" />}
                      >
                         {t('actions.refresh')}
                      </Button>
                    </div>
                    {versions.length === 0 ? (
                      <p className="pages-scene__versions-empty">{t('versions.empty')}</p>
                    ) : (
                      <ol className="pages-scene__version-list">
                        {versions.map((version) => (
                          <li
                            className={`pages-scene__version${version.deployed ? ' is-current' : ''}`}
                            key={version.version_id}
                          >
                            <div className="pages-scene__version-copy">
                              <div className="pages-scene__version-title-row">
                                <code>{version.version_id}</code>
                                {version.deployed && <span className="pages-scene__current-badge">{t('versions.current')}</span>}
                                {version.has_worker && <span className="pages-scene__worker-badge">{t('versions.worker')}</span>}
                              </div>
                              <span>{t('versions.meta', {
                                date: formatTimestamp(version.created_at),
                                size: formatBytes(version.total_bytes),
                                count: version.file_count,
                              })}</span>
                              {version.note && <p>{version.note}</p>}
                            </div>
                            <div className="pages-scene__version-actions">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void openPage(page, pageOwnerEpoch, version.version_id)}
                                disabled={pageBusy}
                                loading={pendingAction === `open:${page.slug}:${version.version_id}`}
                                aria-label={t('actions.openVersionAria', { version: version.version_id })}
                              >
                                <Icon name="arrow-up-right" size="xs" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void copyPageLink(page, pageOwnerEpoch, version)}
                                disabled={pageBusy}
                                loading={pendingAction === `copy:${page.slug}:${version.version_id}`}
                                aria-label={t('actions.copyVersionAria', { version: version.version_id })}
                              >
                                <Icon name="duplicate" size="xs" />
                              </Button>
                              {!version.deployed && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void deployVersion(page, pageOwnerEpoch, version)}
                                  disabled={pageBusy}
                                  loading={pendingAction === `deploy:${page.slug}:${version.version_id}`}
                                  leadingIcon={<Rocket size={13} />}
                                >
                                   {t('actions.deploy')}
                                </Button>
                              )}
                              {!version.deployed && (
                                <Button
                                  variant="fill"
                                  tone="danger"
                                  size="sm"
                                  onClick={() => void deleteVersion(page, pageOwnerEpoch, version)}
                                  disabled={pageBusy}
                                  loading={pendingAction === `delete-version:${page.slug}:${version.version_id}`}
                                  aria-label={t('actions.deleteVersionAria', { version: version.version_id })}
                                >
                                  <Icon name="delete" size="lg" style={{ width: 13, height: 13 }} />
                                </Button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
                </article>
              );
            })}
          </div>
        )}
      </div>
      <RetainedMountBoundary present={showAccountDialog}>
        <Suspense fallback={null}>
          <RemoteConnectDialog
            isOpen={showAccountDialog}
            initialGroup="account"
            onClose={() => {
              setShowAccountDialog(false);
              void loadPages();
            }}
          />
        </Suspense>
      </RetainedMountBoundary>
    </GalleryLayout>
  );
};

export default PagesScene;
