import { OverflowText,
  Button,
  Card,
  CardBody,
  CardMedia,
  ConfirmDialog,
  Icon,
  IconButton,
  SearchField,
  SegmentedControl,
  Select,
  type SelectOption,
  StatusPill,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Heart, Loader2, PackageCheck, ShieldCheck } from 'lucide-react';

import {
  GalleryDetailModal,
  GalleryEmpty,
  GalleryGrid,
  GalleryLayout,
  GalleryPageHeader,
  GallerySkeleton,
  GalleryZone,
} from '@/app/components/GalleryLayout';
import { useSceneManager } from '@/app/hooks/useSceneManager';
import type { SceneTabId } from '@/app/components/SceneBar/types';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n';
import { isRemoteWorkspace } from '@/shared/types';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import type { MiniAppPermissions } from '@/infrastructure/api/service-api/MiniAppAPI';
import {
  miniAppMarketAPI,
  type MarketInstalledStatus,
  type MarketListingDetail,
  type MarketListingSummary,
  type MarketSort,
} from '@/infrastructure/api/service-api/MiniAppMarketAPI';
import { marketImageUrl, retryOriginalMarketImage } from '@/infrastructure/api/service-api/MarketImage';
import { AccountIdentityControls } from '@/features/market-account';
import { useAccountIdentity } from '@/infrastructure/account-identity';
import { createLogger } from '@/shared/utils/logger';
import { useNotification } from '@/shared/notification-system';
import { getMiniAppIconGradient, renderMiniAppIcon } from '../utils/miniAppIcons';
import { useMiniAppStore } from '../miniAppStore';
import { pickLocalizedString } from '../utils/pickLocalizedString';
import { buildReleaseHistory } from './miniAppReleaseHistory';
import './MiniAppMarketView.scss';

const log = createLogger('MiniAppMarketView');
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

interface MiniAppMarketViewProps {
  tabs?: React.ReactNode;
}

const MiniAppMarketView: React.FC<MiniAppMarketViewProps> = ({ tabs }) => {
  const { t, formatNumber, currentLanguage } = useI18n('scenes/miniapp');
  const notification = useNotification();
  const { workspace } = useCurrentWorkspace();
  const { openScene, activateScene, openTabs } = useSceneManager();
  const upsertApp = useMiniAppStore((state) => state.upsertApp);
  const setMarketOrigin = useMiniAppStore((state) => state.setMarketOrigin);
  const { me } = useAccountIdentity();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('all');
  const [sort, setSort] = useState<MarketSort>('newest');
  const [items, setItems] = useState<MarketListingSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [detail, setDetail] = useState<MarketListingDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [installed, setInstalled] = useState<MarketInstalledStatus | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(false);
  const [releasesExpanded, setReleasesExpanded] = useState(false);

  const openTabIds = useMemo(() => new Set(openTabs.map((tab) => tab.id)), [openTabs]);

  /** Focuses the installed MiniApp's scene tab, opening it when absent. */
  const openInstalledApp = useCallback((appId: string) => {
    setDetail(undefined);
    setInstalled(null);
    const tabId: SceneTabId = `miniapp:${appId}`;
    if (openTabIds.has(tabId)) {
      activateScene(tabId);
    } else {
      openScene(tabId);
    }
  }, [activateScene, openScene, openTabIds]);

  const loadCatalog = useCallback(async (append = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(undefined);
    try {
      const page = await miniAppMarketAPI.browse({
        query,
        category,
        sort,
        cursor: append ? nextCursor : undefined,
        limit: 20,
      });
      setItems((current) => append ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      log.error('Failed to load MiniApp marketplace catalog', loadError);
      setError(String(loadError));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [category, nextCursor, query, sort]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadCatalog(false);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [category, query, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const openDetail = async (summary: MarketListingSummary) => {
    setDetailLoading(true);
    setDetail(undefined);
    setInstalled(null);
    setReleasesExpanded(false);
    try {
      const loaded = await miniAppMarketAPI.getListing(summary.slug);
      setDetail(loaded);
      setInstalled(await miniAppMarketAPI.installedStatus(loaded.listingId));
    } catch (loadError) {
      notification.error(t('market.messages.detailFailed', { error: String(loadError) }));
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshPersonalizedDetail = () => {
    if (!detail) return;
    void miniAppMarketAPI.getListing(detail.slug)
      .then(setDetail)
      .catch(error => log.warn('Failed to refresh MiniApp market detail after account change', error));
  };

  const toggleFavorite = async () => {
    if (!detail) return;
    if (!me) {
      setLoginOpen(true);
      return;
    }
    setActionBusy(true);
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
      setActionBusy(false);
    }
  };

  const rate = async (value: number) => {
    if (!detail) return;
    if (!me) {
      setLoginOpen(true);
      return;
    }
    setActionBusy(true);
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
      setActionBusy(false);
    }
  };

  const install = async () => {
    if (!detail) return;
    setInstallPrompt(false);
    setActionBusy(true);
    try {
      const result = await miniAppMarketAPI.install(detail.slug, detail.latestRelease, {
        existingAppId: installed?.appId,
        confirmPermissions: true,
        confirmOverwrite: Boolean(installed?.localOverride),
      });
      upsertApp(result.app);
      setMarketOrigin(result.app.id, result.origin);
      notification.success(
        t(result.updated ? 'market.messages.updated' : 'market.messages.installed'),
      );
      openInstalledApp(result.app.id);
    } catch (installError) {
      notification.error(t('market.messages.installFailed', { error: String(installError) }));
    } finally {
      setActionBusy(false);
    }
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
  const workspaceUnsupported = Boolean(
    detail
      && workspace
      && isRemoteWorkspace(workspace)
      && requiresWorkspace(detail.permissions),
  );
  const releaseHistory = buildReleaseHistory(detail?.releases ?? [], releasesExpanded);
  const canUpdate = Boolean(installed && detail && detail.latestRelease > installed.origin.releaseNumber);
  // The install button only renders for the actionable states: fresh install or update.
  const installLabel = canUpdate ? t('market.detail.update') : t('market.detail.install');
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

  return (
    <GalleryLayout className="miniapp-gallery-pane miniapp-market-native">
      <GalleryPageHeader
        title={t('market.title')}
        subtitle={t('market.subtitle')}
        actions={(
          <div
            className="miniapp-market-native__header-actions"
            data-openbitfun-component="miniapp-market-view"
            data-openbitfun-part="headerActions"
          >
            <SearchField
              leadingIcon={<Icon name="search" size="lg" aria-hidden />}
              value={query}
              onValueChange={setQuery}
              placeholder={t('market.search')}
              size="sm"
            />
            <AccountIdentityControls
              loginOpen={loginOpen}
              onLoginOpenChange={setLoginOpen}
              onIdentityChanged={refreshPersonalizedDetail}
            />
          </div>
        )}
      />

      {tabs}

      <div
        className="gallery-zones"
        data-openbitfun-component="miniapp-market-view"
        data-openbitfun-part="root"
      >
        <GalleryZone
          title={t('market.catalog')}
          tools={(
            <Select
              className="miniapp-market-native__sort"
              size="sm"
              options={sortOptions}
              value={sort}
              onValueChange={(value) => setSort(value as MarketSort)}
              aria-label={t('market.sortLabel')}
            />
          )}
        >
          <SegmentedControl size="md"
            className="miniapp-market-native__categories"
            options={CATEGORIES.map((value) => ({
              label: categoryLabel(value, t),
              value,
            }))}
            value={category}
            onValueChange={(value) => setCategory(value as (typeof CATEGORIES)[number])}
            aria-label={t('market.catalog')}
          />
          {loading ? (
            <GallerySkeleton
              count={8}
              cardHeight={280}
              minCardWidth={285}
              className="miniapp-market-native__card-grid"
            />
          ) : null}
          {!loading && error ? (
            <GalleryEmpty
              icon={{ glyph: AlertTriangle }}
              isError
              message={t('market.messages.catalogFailed', { error })}
              action={(
                <Button size="sm" variant="outline" onClick={() => void loadCatalog(false)} leadingIcon={<Icon name="refresh" size="sm" />}>

                  {t('scene.retry')}
                </Button>
              )}
            />
          ) : null}
          {!loading && !error && items.length === 0 ? (
            <GalleryEmpty icon={{ glyph: PackageCheck }} message={t('market.empty')} />
          ) : null}
          {!loading && items.length > 0 ? (
            <>
              <GalleryGrid minCardWidth={285} className="miniapp-market-native__card-grid">
                {items.map((item) => {
                  const name = pickLocalizedString(item, currentLanguage, 'name');
                  const description = pickLocalizedString(item, currentLanguage, 'description');
                  return (
                    <Card
                      key={item.listingId}
                      className="miniapp-market-card"
                      appearance="raised"
                      clip
                      radius="lg"
                    >
                      <button data-overflow-trigger
                        type="button"
                        className="miniapp-market-card__trigger"
                        data-openbitfun-component="miniapp-market-view"
                        data-openbitfun-part="card"
                        onClick={() => void openDetail(item)}
                      >
                        <CardMedia className="miniapp-market-card__visual">
                          {item.screenshotUrls[0] ? (
                            <img
                              src={marketImageUrl(item.screenshotUrls[0], 'compact-v1')}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              onError={(event) => retryOriginalMarketImage(event.currentTarget, item.screenshotUrls[0]!)}
                            />
                          ) : (
                            <span
                              className="miniapp-market-card__fallback"
                              style={{ background: getMiniAppIconGradient(item.icon || 'box') }}
                            >
                              {renderMiniAppIcon(item.icon || 'box', 30)}
                            </span>
                          )}
                        </CardMedia>
                        <CardBody className="miniapp-market-card__body">
                          <div className="miniapp-market-card__eyebrow">
                            <span>{categoryLabel(item.category, t)}</span>
                            <span>v{item.latestRelease}</span>
                          </div>
                          <strong><OverflowText>{name}</OverflowText></strong>
                          <OverflowText as="p" lines={2}>{description}</OverflowText>
                          <div className="miniapp-market-card__stats">
                            <span><Icon name="star" size="xs" /> {item.ratingAverage.toFixed(1)}</span>
                            <span><Icon name="arrow-down" size="xs" /> {formatNumber(item.downloadCount)}</span>
                            <span><Heart size={12} /> {formatNumber(item.favoriteCount)}</span>
                          </div>
                        </CardBody>
                      </button>
                    </Card>
                  );
                })}
              </GalleryGrid>
              {nextCursor ? (
                <div className="miniapp-market-native__load-more">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={loadingMore}
                    onClick={() => void loadCatalog(true)}
                  >
                    {loadingMore ? <Loader2 size={14} className="gallery-spinning" /> : null}
                    {t('market.loadMore')}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </GalleryZone>
      </div>

      <GalleryDetailModal
        isOpen={detailLoading || Boolean(detail)}
        onClose={() => {
          setDetail(undefined);
          setInstalled(null);
        }}
        icon={detailLoading
          ? <Loader2 size={22} className="gallery-spinning" />
          : renderMiniAppIcon(detail?.icon || 'box', 24)}
        iconGradient={detail ? getMiniAppIconGradient(detail.icon || 'box') : undefined}
        title={detailName || t('market.detail.loading')}
        badges={detail ? (
          <>
            <StatusPill tone="info">{categoryLabel(detail.category, t)}</StatusPill>
            <StatusPill tone="neutral" leading={<ShieldCheck size={11} />}>{t('market.detail.reviewed')}</StatusPill>
          </>
        ) : null}
        description={detailDescription}
        meta={detail ? (
          <span>{t('market.detail.by', { owner: detail.owner.login })}</span>
        ) : null}
        actions={detail ? (
          <>
            <Button size="sm" variant="outline" onClick={() => void toggleFavorite()} disabled={actionBusy} leadingIcon={<Heart size={14} fill={detail.isFavorited ? 'currentColor' : 'none'} />}>

              {formatNumber(detail.favoriteCount)}
            </Button>
            {/* Installed and up to date: nothing left to install, so say so and let "Open" lead. */}
            {installed && !canUpdate ? (
              <span className="miniapp-market-detail__installed-state">
                <Icon name="check-line" size="sm" />
                {t('market.detail.installed')}
              </span>
            ) : null}
            {installed ? (
              <Button
                size="sm"
                variant={canUpdate ? 'outline' : 'primary'}
                disabled={actionBusy || workspaceUnsupported}
                onClick={() => openInstalledApp(installed.appId)}
                leadingIcon={<Icon name="arrow-up-right" size="sm" />}
              >

                {t('market.detail.open')}
              </Button>
            ) : null}
            {!installed || canUpdate ? (
              <Button
                size="sm"
                variant="primary"
                disabled={actionBusy || workspaceUnsupported}
                onClick={() => setInstallPrompt(true)}
              >
                {actionBusy ? <Loader2 size={14} className="gallery-spinning" /> : canUpdate ? <Icon name="refresh" size="sm" /> : <Icon name="arrow-down" size="sm" />}
                {installLabel}
              </Button>
            ) : null}
          </>
        ) : null}
      >
        {detail ? (
              <div
                className="miniapp-market-detail"
                data-openbitfun-component="miniapp-market-view"
                data-openbitfun-part="detail"
              >
            {detail.screenshotUrls.length ? (
              <div className="miniapp-market-detail__screenshots">
                {detail.screenshotUrls.map((url, index) => (
                  <img
                    key={url}
                    src={marketImageUrl(url, 'compact-v1')}
                    alt=""
                    loading={index === 0 ? 'eager' : 'lazy'}
                    decoding="async"
                    onError={(event) => retryOriginalMarketImage(event.currentTarget, url)}
                  />
                ))}
              </div>
            ) : null}
            {workspaceUnsupported ? (
              <div className="miniapp-market-detail__warning">
                <AlertTriangle size={16} />
                {t('market.detail.remoteWorkspaceUnsupported')}
              </div>
            ) : null}
            {installed?.localOverride ? (
              <div className="miniapp-market-detail__warning">
                <AlertTriangle size={16} />
                {t('market.detail.localOverride')}
              </div>
            ) : null}
            {installedReleaseYanked ? (
              <div className="miniapp-market-detail__warning">
                <AlertTriangle size={16} />
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
                    disabled={actionBusy}
                    aria-label={`${t('market.detail.rating')} ${value}`}
                    title={`${t('market.detail.rating')} ${value}`}
                    icon={<Icon name="star" size="lg" />}
                  />
                ))}
                <span className="miniapp-market-detail__rating-summary">
                  {detail.ratingAverage.toFixed(1)} · {formatNumber(detail.ratingCount)}
                </span>
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
                    {release.yanked ? <StatusPill tone="warning">{t('market.detail.yanked')}</StatusPill> : <Icon name="check-line" size="sm" />}
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
        open={installPrompt}
        onOpenChange={() => setInstallPrompt(false)}
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
                ? t('market.confirmInstall.permissions', { permissions: permissionLines.join(', ') })
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

function requiresWorkspace(permissions: MiniAppPermissions): boolean {
  return [
    ...(permissions.fs?.read ?? []),
    ...(permissions.fs?.write ?? []),
  ].includes('{workspace}');
}

function summarizePermissions(
  permissions: MiniAppPermissions,
  t: (key: string, params?: Record<string, unknown>) => string,
): string[] {
  const result: string[] = [];
  if (permissions.fs?.read?.length) result.push(t('market.permissions.fsRead', { value: permissions.fs.read.join(', ') }));
  if (permissions.fs?.write?.length) result.push(t('market.permissions.fsWrite', { value: permissions.fs.write.join(', ') }));
  if (permissions.shell?.allow?.length) result.push(t('market.permissions.shell', { value: permissions.shell.allow.join(', ') }));
  if (permissions.net?.allow?.length) result.push(t('market.permissions.net', { value: permissions.net.allow.join(', ') }));
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

function categoryLabel(
  category: string,
  t: (key: string) => string,
): string {
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

export default MiniAppMarketView;
