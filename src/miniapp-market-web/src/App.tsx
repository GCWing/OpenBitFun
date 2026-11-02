import { Input, Textarea, Button, IconButton } from '@openbitfun/ui';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CubeFocus as MarketLogo, GithubLogo, IconContext } from '@phosphor-icons/react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink as ArrowSquareOut,
  ChevronDown as CaretDown,
  Check,
  CircleCheck as CheckCircle,
  History as ClockCounterClockwise,
  Box as Cube,
  Boxes as CubeFocus,
  Download as DownloadSimple,
  FileCode,
  Fingerprint as FingerprintSimple,
  Globe,
  Heart,
  LockKeyhole as LockKey,
  Search as MagnifyingGlass,
  Moon,
  Package,
  ShieldCheck,
  LogOut as SignOut,
  SlidersHorizontal,
  Star,
  Sun,
  Inbox as Tray,
  Upload as UploadSimple,
  CircleAlert as WarningCircle,
  X,
} from 'lucide-react';
import { AccountSignIn } from './AccountSignIn';
import { takeNativeAuthReturnTo } from './authReturnTo';
import { downloadUrl, loginUrl, marketApi, MarketApiError } from './api';
import { formatCompactNumber, formatMarketDate, formatMarketDateTime } from './format';
import { GetOpenBitFunCta } from './GetOpenBitFunCta';
import { useLocale, type Locale, type MessageKey } from './i18n';
import { OPENBITFUN_HOME_URL } from './links';
import { MiniAppIcon } from './MiniAppIcon';
import { marketImageSrcSet, marketImageUrl, retryOriginalMarketImage } from './marketImages';
import { useTheme, type Theme } from './theme';
import type {
  AdminSubmission,
  AdminSubmissionDetail,
  MarketConfig,
  MarketListingDetail,
  MarketListingSummary,
  MarketSubmission,
  Me,
  MiniAppPermissions,
} from './types';

interface RouteState {
  path: string;
  query: URLSearchParams;
}

const MARKET_CATEGORIES = [
  'developer',
  'productivity',
  'data',
  'creative',
  'education',
  'utilities',
  'entertainment',
  'other',
] as const;

const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; shortLabel: string; label: string }> = [
  { value: 'en-US', shortLabel: 'EN', label: 'English' },
  { value: 'zh-CN', shortLabel: '简', label: '简体中文' },
  { value: 'zh-TW', shortLabel: '繁', label: '繁體中文' },
];

function currentRoute(): RouteState {
  const base = '/miniapp';
  const path = window.location.pathname.startsWith(base)
    ? window.location.pathname.slice(base.length) || '/'
    : '/';
  return { path, query: new URLSearchParams(window.location.search) };
}

function navigate(path: string) {
  const target = path.startsWith('/miniapp') ? path : `/miniapp${path}`;
  window.history.pushState({}, '', target);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function App() {
  const path = window.location.pathname;
  if (window.location.hostname === 'auth.openbitfun.com' || path === '/miniapp/auth/sign-in' || path === '/miniapp/auth/complete' || path === '/miniapp/auth/desktop-complete') {
    return <GitHubIdentityPage complete={path.endsWith('complete')} />;
  }
  return <MarketApp />;
}

function GitHubIdentityPage({ complete }: { complete: boolean }) {
  const { t } = useLocale();
  useTheme();
  useEffect(() => { document.title = `OpenBitFun · ${t(complete ? 'authComplete' : 'signIn')}`; }, [complete, t]);
  return <IconContext.Provider value={{ size: 24, weight: 'regular' }}>
    {complete ? <DesktopComplete t={t} /> : <AccountSignIn />}
  </IconContext.Provider>;
}

function MarketApp() {
  const { locale, setLocale, t } = useLocale();
  const { theme, toggleTheme } = useTheme();
  const [route, setRoute] = useState<RouteState>(currentRoute);
  const [config, setConfig] = useState<MarketConfig>();
  const [configResolved, setConfigResolved] = useState(false);
  const [me, setMe] = useState<Me>();
  const [authResolved, setAuthResolved] = useState(false);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const refreshIdentity = useCallback(async () => {
    try {
      setMe(await marketApi.me());
    } catch (error) {
      if (!(error instanceof MarketApiError) || error.code !== 'unauthorized') {
        console.warn('Could not load marketplace identity', error);
      }
      setMe(undefined);
    } finally {
      setAuthResolved(true);
    }
  }, []);

  useEffect(() => {
    void marketApi
      .config()
      .then(setConfig)
      .catch(() => undefined)
      .finally(() => setConfigResolved(true));
    void refreshIdentity();
  }, [refreshIdentity]);

  const content = (() => {
    if (route.path === '/submit') {
      return (
        <SubmitPage
          enabled={config?.webSubmissionsEnabled === true}
          configResolved={configResolved}
          me={me}
          authResolved={authResolved}
          query={route.query}
          t={t}
          onSubmitted={() => navigate('/submissions')}
        />
      );
    }
    if (route.path === '/submissions') {
      return (
        <SubmissionsPage
          webSubmissionsEnabled={config?.webSubmissionsEnabled === true}
          me={me}
          authResolved={authResolved}
          t={t}
        />
      );
    }
    if (route.path === '/admin') {
      return <AdminPage me={me} authResolved={authResolved} locale={locale} t={t} />;
    }
    if (route.path === '/auth/desktop-complete') {
      return <DesktopComplete t={t} />;
    }
    const detailMatch = route.path.match(/^\/apps\/([a-z0-9-]+)$/);
    if (detailMatch) {
      return (
        <DetailPage
          slug={detailMatch[1]}
          webSubmissionsEnabled={config?.webSubmissionsEnabled === true}
          me={me}
          locale={locale}
          t={t}
        />
      );
    }
    return <CatalogPage config={config} me={me} locale={locale} t={t} />;
  })();

  return (
    <IconContext.Provider value={{ size: 18, weight: 'regular' }}>
      <div className="site-shell">
        <Header
          currentPath={route.path}
          locale={locale}
          setLocale={setLocale}
          theme={theme}
          toggleTheme={toggleTheme}
          me={me}
          config={config}
          t={t}
          onLogout={async () => {
            await marketApi.logout();
            setMe(undefined);
            navigate('/');
          }}
        />
        {content}
        <footer>
          <div className="footer-brand">
            <MarketLogo weight="duotone" aria-hidden="true" />
            <span>OpenBitFun MiniApp Market</span>
          </div>
          <a href={OPENBITFUN_HOME_URL} target="_blank" rel="noreferrer">
            {t('openbitfunHome')}
            <ArrowSquareOut size={18} aria-hidden="true" />
          </a>
        </footer>
      </div>
    </IconContext.Provider>
  );
}

function Header({
  currentPath,
  locale,
  setLocale,
  theme,
  toggleTheme,
  me,
  config,
  t,
  onLogout,
}: {
  currentPath: string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  theme: Theme;
  toggleTheme: () => void;
  me?: Me;
  config?: MarketConfig;
  t: (key: MessageKey) => string;
  onLogout: () => Promise<void>;
}) {
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const accountLabel = me?.email ?? me?.user.login ?? '';

  const languageControlRef = useRef<HTMLDivElement>(null);
  const languageTriggerRef = useRef<HTMLButtonElement>(null);
  const activeLocale =
    LOCALE_OPTIONS.find((localeOption) => localeOption.value === locale) ?? LOCALE_OPTIONS[0];
  const routeIsActive = (route: string) =>
    route === '/'
      ? currentPath === '/' || currentPath.startsWith('/apps/')
      : currentPath === route;

  useEffect(() => {
    if (!languageMenuOpen) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!languageControlRef.current?.contains(event.target as Node)) {
        setLanguageMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLanguageMenuOpen(false);
        languageTriggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [languageMenuOpen]);

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Button labelBehavior="static" type="button" className="brand" onClick={() => navigate('/')} aria-label={t('market')}>
          <span className="brand-mark">
            <MarketLogo size={25} weight="duotone" aria-hidden="true" />
          </span>
          <span className="brand-copy">
            <strong>OpenBitFun</strong>
            <span>{t('market')}</span>
          </span>
        </Button>
        <nav aria-label={t('navigationLabel')}>
          <Button labelBehavior="static" type="button"
            className={routeIsActive('/') ? 'active' : undefined}
            aria-current={routeIsActive('/') ? 'page' : undefined}
            onClick={() => navigate('/')}
          >
            {t('discover')}
          </Button>
          {config?.webSubmissionsEnabled && (
            <Button labelBehavior="static" type="button"
              className={routeIsActive('/submit') ? 'active' : undefined}
              aria-current={routeIsActive('/submit') ? 'page' : undefined}
              onClick={() => navigate('/submit')}
            >
              {t('submit')}
            </Button>
          )}
          {me && (
            <Button labelBehavior="static" type="button"
              className={routeIsActive('/submissions') ? 'active' : undefined}
              aria-current={routeIsActive('/submissions') ? 'page' : undefined}
              onClick={() => navigate('/submissions')}
            >
              {t('submissions')}
            </Button>
          )}
          {me?.isAdmin && (
            <Button labelBehavior="static" type="button"
              className={routeIsActive('/admin') ? 'active' : undefined}
              aria-current={routeIsActive('/admin') ? 'page' : undefined}
              onClick={() => navigate('/admin')}
            >
              {t('admin')}
            </Button>
          )}
        </nav>
        <div className="topbar-actions">
          <div className="language-control" ref={languageControlRef}>
            <Button labelBehavior="static"
              ref={languageTriggerRef}
              className="header-control language-trigger"
              type="button"
              aria-label={t('changeLanguage')}
              aria-expanded={languageMenuOpen}
              aria-controls="market-language-menu"
              title={t('changeLanguage')}
              onClick={() => setLanguageMenuOpen((open) => !open)}
            >
              <Globe size={18} aria-hidden="true" />
              <span className="control-label">{activeLocale.shortLabel}</span>
              <CaretDown
                className={`language-caret ${languageMenuOpen ? 'open' : ''}`}
                size={14}
                aria-hidden="true"
              />
            </Button>
            {languageMenuOpen && (
              <div
                className="language-menu"
                id="market-language-menu"
                role="group"
                aria-label={t('language')}
              >
                <span className="language-menu-label">{t('language')}</span>
                {LOCALE_OPTIONS.map((localeOption) => (
                  <Button labelBehavior="static"
                    key={localeOption.value}
                    className={localeOption.value === locale ? 'selected' : undefined}
                    type="button"
                    aria-pressed={localeOption.value === locale}
                    onClick={() => {
                      setLocale(localeOption.value);
                      setLanguageMenuOpen(false);
                      languageTriggerRef.current?.focus();
                    }}
                  >
                    <span>{localeOption.label}</span>
                    {localeOption.value === locale && (
                      <Check size={16} aria-hidden="true" />
                    )}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <IconButton
            className="header-control theme-toggle"
            type="button"
            aria-label={t(theme === 'dark' ? 'switchToLight' : 'switchToDark')}
            title={t(theme === 'dark' ? 'switchToLight' : 'switchToDark')}
            onClick={toggleTheme}
            icon={theme === 'dark' ? (
              <Sun size={18} aria-hidden="true" />
            ) : (
              <Moon size={18} aria-hidden="true" />
            )}
          />
          {me ? (
            <div className="profile">
              <div className="profile-avatar" role="img" aria-label={accountLabel}>
                {me.user.avatarUrl && failedAvatar !== me.user.avatarUrl
                  ? <img src={me.user.avatarUrl} alt="" onError={() => setFailedAvatar(me.user.avatarUrl)} />
                  : accountLabel.trim().charAt(0).toUpperCase() || '?'}
              </div>
              <span title={accountLabel}>{me.email ?? `@${me.user.login}`}</span>
              <IconButton
                className="icon-button"
                onClick={() => void onLogout()}
                aria-label={t('signOut')}
                title={t('signOut')}
                type="button"
                icon={<SignOut size={18} aria-hidden="true" />}
              />
            </div>
          ) : (
            <a
              className={`button button-small ${(config?.githubAuthConfigured || config?.emailAuthConfigured) === false ? 'disabled' : ''}`}
              href={loginUrl(window.location.pathname)}
              aria-disabled={(config?.githubAuthConfigured || config?.emailAuthConfigured) === false}
              onClick={(event) => {
                if ((config?.githubAuthConfigured || config?.emailAuthConfigured) === false) event.preventDefault();
              }}
            >
              <GithubLogo weight="bold" aria-hidden="true" />
              {t('signIn')}
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

function CatalogPage({
  config,
  me,
  locale,
  t,
}: {
  config?: MarketConfig;
  me?: Me;
  locale: Locale;
  t: (key: MessageKey) => string;
}) {
  const [items, setItems] = useState<MarketListingSummary[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('newest');
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();

  const load = useCallback(
    async (next?: string, append = false) => {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams({ sort, limit: '20' });
      if (query.trim()) params.set('q', query.trim());
      if (category) params.set('category', category);
      if (next) params.set('cursor', next);
      try {
        const page = await marketApi.list(params);
        setItems((previous) => (append ? [...previous, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (caught) {
        setError(caught);
        if (!append) setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [category, query, sort],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 220);
    return () => window.clearTimeout(timer);
  }, [load, me]);

  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <ShieldCheck size={18} aria-hidden="true" />
            {t('heroEyebrow')}
          </div>
          <h1>{t('headline')}</h1>
          <p>{t('intro')}</p>
          <GetOpenBitFunCta placement="catalog" t={t} />
        </div>
        <div className="hero-visual">
          <img src="/miniapp/og.png" alt={t('heroImageAlt')} />
        </div>
      </section>

      <section className="trust-row" aria-label={t('marketSafety')}>
        <div>
          <FileCode size={18} aria-hidden="true" />
          <span>{t('trustSource')}</span>
        </div>
        <div>
          <FingerprintSimple size={18} aria-hidden="true" />
          <span>{t('trustHash')}</span>
        </div>
        <div>
          <LockKey size={18} aria-hidden="true" />
          <span>{t('trustPermissions')}</span>
        </div>
      </section>

      <section className="catalog" id="catalog" aria-label={t('discover')}>
        <div className="catalog-heading">
          <div>
            <h2>{t('discover')}</h2>
            <p>{t('catalogIntro')}</p>
          </div>
          {!loading && error == null && (
            <span className="result-count">
              {items.length} {t(items.length === 1 ? 'reviewedApp' : 'reviewedApps')}
            </span>
          )}
        </div>
        <div className="catalog-toolbar">
          <label className="search-field">
            <MagnifyingGlass size={18} aria-hidden="true" />
            <span className="sr-only">{t('search')}</span>
            <Input className="market-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('search')}
              autoComplete="off"
            />
          </label>
          <label className="sort-field">
            <SlidersHorizontal size={18} aria-hidden="true" />
            <span className="sr-only">{t('sortLabel')}</span>
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="newest">{t('newest')}</option>
              <option value="downloads">{t('downloads')}</option>
              <option value="rating">{t('rating')}</option>
            </select>
          </label>
        </div>

        <div className="category-tabs" aria-label={t('categoryLabel')}>
          <Button labelBehavior="static"
            type="button"
            className={category === '' ? 'active' : undefined}
            aria-pressed={category === ''}
            onClick={() => setCategory('')}
          >
            <Cube size={18} aria-hidden="true" />
            {t('allCategories')}
          </Button>
          {(config?.categories || MARKET_CATEGORIES).map((item) => (
            <Button labelBehavior="static"
              type="button"
              key={item}
              className={category === item ? 'active' : undefined}
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
            >
              {categoryLabel(item, t)}
            </Button>
          ))}
        </div>

        {error != null && <Notice tone="error">{errorMessage(error, t)}</Notice>}
        <div className="app-grid" aria-busy={loading}>
          {items.map((item) => (
            <AppCard key={item.listingId} app={item} locale={locale} t={t} />
          ))}
          {!loading && error == null && items.length === 0 && (
            <div className="empty-state">
              <span className="empty-state-icon">
                <Tray size={18} aria-hidden="true" />
              </span>
              <p>{t('empty')}</p>
              {config?.webSubmissionsEnabled ? (
                <Button labelBehavior="static" type="button" className="button button-secondary" onClick={() => navigate('/submit')}>
                  <UploadSimple size={18} aria-hidden="true" />
                  {t('submit')}
                </Button>
              ) : (
                <span className="empty-state-hint">{t('desktopSubmissionHint')}</span>
              )}
            </div>
          )}
          {loading && items.length === 0 &&
            Array.from({ length: 6 }, (_, index) => (
              <AppCardSkeleton key={index} />
            ))}
        </div>
        {cursor && (
          <Button labelBehavior="static" type="button" className="button button-secondary load-more" onClick={() => void load(cursor, true)}>
            {t('loadMore')}
            <ArrowRight size={18} aria-hidden="true" />
          </Button>
        )}
      </section>
    </main>
  );
}

function AppCard({
  app,
  locale,
  t,
}: {
  app: MarketListingSummary;
  locale: Locale;
  t: (key: MessageKey) => string;
}) {
  const localized = localizedListing(app, locale);
  return (
    <a
      className="app-card"
      href={`/miniapp/apps/${app.slug}`}
      onClick={(event) => {
        if (
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          navigate(`/apps/${app.slug}`);
        }
      }}
      aria-label={`${localized.name}, ${categoryLabel(app.category, t)}`}
    >
      <div className="card-visual">
        {app.screenshotUrls[0] ? (
          <img
            src={marketImageUrl(app.screenshotUrls[0], 'compact-v1')}
            alt={localized.name}
            loading="lazy"
            decoding="async"
            onError={(event) => retryOriginalMarketImage(event.currentTarget, app.screenshotUrls[0])}
          />
        ) : (
          <span className="app-icon-large">
            <MiniAppIcon name={app.icon} />
          </span>
        )}
      </div>
      <div className="card-body">
        <div className="card-topline">
          <span className="category-chip">{categoryLabel(app.category, t)}</span>
          <span className="card-version">v{app.latestRelease}</span>
        </div>
        <div className="card-heading">
          <span className="app-icon">
            <MiniAppIcon name={app.icon} />
          </span>
          <div>
            <h2>{localized.name}</h2>
            <p className="owner">
              {t('by')} {app.owner.githubId > 0 ? `@${app.owner.login}` : app.owner.login}
            </p>
          </div>
        </div>
        <p className="card-description">{localized.description}</p>
        <div className="card-meta">
          <span title={t('ratingLabel')}>
            <Star size={18} fill={app.ratingAverage > 0 ? 'currentColor' : 'none'} aria-hidden="true" />
            {app.ratingAverage.toFixed(1)}
            <small>{app.ratingCount}</small>
            <span className="sr-only">{t('ratingLabel')}</span>
          </span>
          <span className={`card-favorites ${app.isFavorited ? 'active' : ''}`} title={t('favoritesLabel')}>
            <Heart size={18} fill={app.isFavorited ? 'currentColor' : 'none'} aria-hidden="true" />
            {formatCompactNumber(app.favoriteCount, locale)}
            <span className="sr-only">{t('favoritesLabel')}</span>
          </span>
          <span title={t('downloadsLabel')}>
            <DownloadSimple size={18} aria-hidden="true" />
            {formatCompactNumber(app.downloadCount, locale)}
            <span className="sr-only">{t('downloadsLabel')}</span>
          </span>
          <ArrowRight size={18} className="card-arrow" aria-hidden="true" />
        </div>
      </div>
    </a>
  );
}

function AppCardSkeleton() {
  return (
    <div className="app-card app-card-skeleton" aria-hidden="true">
      <div className="skeleton-block skeleton-visual" />
      <div className="card-body">
        <div className="skeleton-line short" />
        <div className="skeleton-heading">
          <span className="skeleton-block" />
          <div>
            <div className="skeleton-line medium" />
            <div className="skeleton-line short" />
          </div>
        </div>
        <div className="skeleton-line" />
        <div className="skeleton-line medium" />
        <div className="skeleton-line short" />
      </div>
    </div>
  );
}

function DetailPage({
  slug,
  webSubmissionsEnabled,
  me,
  locale,
  t,
}: {
  slug: string;
  webSubmissionsEnabled: boolean;
  me?: Me;
  locale: Locale;
  t: (key: MessageKey) => string;
}) {
  const [app, setApp] = useState<MarketListingDetail>();
  const [error, setError] = useState<unknown>();
  const [ratingBusy, setRatingBusy] = useState(false);
  const [moderationReason, setModerationReason] = useState('');

  const load = useCallback(async () => {
    try {
      setApp(await marketApi.detail(slug));
      setError(undefined);
    } catch (caught) {
      setError(caught);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load, me]);

  if (error) {
    return (
      <main className="narrow-page">
        <Button labelBehavior="static" type="button" className="back-link" onClick={() => navigate('/')}>
          <ArrowLeft size={18} aria-hidden="true" />
          {t('back')}
        </Button>
        <Notice tone="error">{errorMessage(error, t)}</Notice>
      </main>
    );
  }
  if (!app) return <PageLoading t={t} />;

  const owner = !!me && (app.owner.accountId
    ? me.user.accountId === app.owner.accountId
    : app.owner.githubId > 0 && me.user.githubId === app.owner.githubId);
  const localized = localizedListing(app, locale);
  return (
    <main className="detail-page">
      <Button labelBehavior="static" type="button" className="back-link" onClick={() => navigate('/')}>
        <ArrowLeft size={18} aria-hidden="true" />
        {t('back')}
      </Button>
      <section className="detail-hero">
        <div className="detail-copy">
          <span className="category-chip">{categoryLabel(app.category, t)}</span>
          <div className="detail-title-row">
            <span className="detail-icon">
              <MiniAppIcon name={app.icon} />
            </span>
            <div>
              <h1>{localized.name}</h1>
              <p className="detail-owner">
                <span>{app.owner.githubId > 0 ? `@${app.owner.login}` : app.owner.login}</span>
                <span>{t('version')} {app.latestRelease}</span>
              </p>
            </div>
          </div>
          <p className="detail-description">{localized.description}</p>
          <div className="detail-actions">
            <a className="button" href={downloadUrl(app.slug, app.latestRelease)}>
              <DownloadSimple size={18} aria-hidden="true" />
              {t('install')}
            </a>
            <Button labelBehavior="static" type="button"
              className={`button button-secondary ${app.isFavorited ? 'active' : ''}`}
              onClick={async () => {
                if (!me) {
                  window.location.href = loginUrl(window.location.pathname);
                  return;
                }
                const result = await marketApi.favorite(app.slug, !app.isFavorited);
                setApp({ ...app, isFavorited: result.isFavorited, favoriteCount: result.count });
              }}
            >
              <Heart size={18} fill={app.isFavorited ? 'currentColor' : 'none'} aria-hidden="true" />
              {app.isFavorited ? t('favorited') : t('favorite')}
              <small>{formatCompactNumber(app.favoriteCount, locale)}</small>
            </Button>
            {owner && webSubmissionsEnabled && (
              <Button labelBehavior="static" type="button"
                className="button button-secondary"
                onClick={() =>
                  navigate(
                    `/submit?listingId=${encodeURIComponent(app.listingId)}&slug=${encodeURIComponent(app.slug)}&release=${app.latestRelease + 1}`,
                  )
                }
              >
                <UploadSimple size={18} aria-hidden="true" />
                {t('submitUpdate')}
              </Button>
            )}
          </div>
          <GetOpenBitFunCta placement="listing" t={t} />
          <div className="rating-control" aria-label={t('ratingLabel')}>
            {[1, 2, 3, 4, 5].map((value) => (
              <IconButton
                key={value}
                disabled={ratingBusy}
                className={value <= (app.myRating || 0) ? 'selected' : ''}
                onClick={async () => {
                  if (!me) {
                    window.location.href = loginUrl(window.location.pathname);
                    return;
                  }
                  setRatingBusy(true);
                  try {
                    const result =
                      app.myRating === value
                        ? await marketApi.deleteRating(app.slug)
                        : await marketApi.rate(app.slug, value);
                    setApp({
                      ...app,
                      myRating: result.myRating,
                      ratingAverage: result.average,
                      ratingCount: result.count,
                    });
                  } finally {
                    setRatingBusy(false);
                  }
                }}
                aria-label={`${value} ${t('stars')}`}
                type="button"
                icon={<Star size={18} fill={value <= (app.myRating || 0) ? 'currentColor' : 'none'} />}
              />
            ))}
            <span className="rating-summary">{app.ratingAverage.toFixed(1)} ({app.ratingCount})</span>
          </div>
        </div>
        <div className="detail-gallery">
          {app.screenshotUrls.length > 0 ? (
            <div className="detail-gallery-track">
              {app.screenshotUrls.map((url, index) => (
                <img
                  key={`${url}-${index}`}
                  src={marketImageUrl(url, 'large-v1')}
                  srcSet={marketImageSrcSet(url)}
                  sizes="(max-width: 1040px) calc(100vw - 40px), 520px"
                  alt={`${localized.name} ${t('screenshotLabel')} ${index + 1}`}
                  loading={index === 0 ? 'eager' : 'lazy'}
                  decoding="async"
                  onError={(event) => retryOriginalMarketImage(event.currentTarget, url)}
                />
              ))}
            </div>
          ) : (
            <span><MiniAppIcon name={app.icon} /></span>
          )}
        </div>
      </section>

      <section className="detail-columns">
        <div>
          <h2>{t('permissions')}</h2>
          <PermissionList permissions={app.permissions} t={t} />
          <h2>{t('changelog')}</h2>
          <p className="prose">{app.changelog}</p>
        </div>
        <aside className="facts-panel">
          <Fact label={t('requires')} value={`v${app.minOpenBitFunVersion}+`} />
          <Fact
            label={t('downloadsLabel')}
            value={formatCompactNumber(app.downloadCount, locale)}
          />
          <Fact
            label={t('favoritesLabel')}
            value={formatCompactNumber(app.favoriteCount, locale)}
          />
          <Fact
            label={t('licenseLabel')}
            value={app.license.spdxExpression || app.license.customUrl || t('customLicense')}
          />
          {app.repositoryUrl && (
            <a href={app.repositoryUrl} target="_blank" rel="noreferrer">
              {t('viewSourceRepository')}
              <ArrowSquareOut size={18} aria-hidden="true" />
            </a>
          )}
        </aside>
      </section>

      <section className="release-section">
        <h2>{t('releases')}</h2>
        {app.releases.map((release) => (
          <div className={`release-row ${release.yanked ? 'yanked' : ''}`} key={release.releaseId}>
            <strong>v{release.releaseNumber}</strong>
            <span>{formatMarketDate(release.publishedAt, locale)}</span>
            <span className="hash" title={release.packageSha256}>
              {release.packageSha256.slice(0, 12)}
            </span>
            <span>{release.yanked ? t('yankedLabel') : release.changelog}</span>
            {me?.isAdmin && !release.yanked && (
              <Button labelBehavior="static" type="button"
                className="text-action danger-action"
                disabled={!moderationReason.trim()}
                onClick={async () => {
                  await marketApi.yankRelease(release.releaseId, moderationReason.trim());
                  setModerationReason('');
                  await load();
                }}
              >
                {t('yank')}
              </Button>
            )}
          </div>
        ))}
        {me?.isAdmin && (
          <div className="moderation-panel">
            <label>
              <span>{t('moderationReason')}</span>
              <Input className="market-input"
                value={moderationReason}
                onChange={(event) => setModerationReason(event.target.value)}
              />
            </label>
            <Button labelBehavior="static" type="button"
              className="button button-danger"
              disabled={!moderationReason.trim()}
              onClick={async () => {
                await marketApi.unpublishListing(app.listingId, moderationReason.trim());
                navigate('/');
              }}
            >
              {t('unpublish')}
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}

function SubmitPage({
  enabled,
  configResolved,
  me,
  authResolved,
  query,
  t,
  onSubmitted,
}: {
  enabled: boolean;
  configResolved: boolean;
  me?: Me;
  authResolved: boolean;
  query: URLSearchParams;
  t: (key: MessageKey) => string;
  onSubmitted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState(false);
  const listingId = query.get('listingId') || undefined;
  const initialSlug = query.get('slug') || '';
  const initialRelease = Number(query.get('release') || 1);

  if (!configResolved) return <PageLoading t={t} />;
  if (!enabled) return <WebSubmissionDisabledPage t={t} />;
  if (!authResolved) return <PageLoading t={t} />;
  if (!me) {
    return (
      <main className="form-page">
        <section className="auth-gate">
          <span className="gate-icon">
            <GithubLogo weight="duotone" aria-hidden="true" />
          </span>
          <h1>{t('signInRequired')}</h1>
          <a className="button" href={loginUrl('/miniapp/submit')}>
            <GithubLogo weight="bold" aria-hidden="true" />
            {t('signIn')}
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="form-page">
      <div className="page-intro">
        <span className="page-kicker">
          <UploadSimple size={18} aria-hidden="true" />
          {t('publisherWorkspace')}
        </span>
        <h1>{t('submitTitle')}</h1>
        <p>{t('submitIntro')}</p>
      </div>
      {error != null && <Notice tone="error">{errorMessage(error, t)}</Notice>}
      {done && <Notice tone="success">{t('submitted')}</Notice>}
      <form
        className="submission-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const packageFile = form.get('package');
          const screenshots = form.getAll('screenshots').filter((value) => value instanceof File);
          if (!(packageFile instanceof File) || packageFile.size === 0 || screenshots.length === 0) {
            setError(new LocalizedUiError('choosePackageAndScreenshot'));
            return;
          }
          setBusy(true);
          setError(undefined);
          try {
            const licenseKind = String(form.get('licenseKind'));
            let submission = await marketApi.createSubmission({
              listingId,
              slug: String(form.get('slug')),
              releaseNumber: Number(form.get('releaseNumber')),
              name: String(form.get('name')),
              description: String(form.get('description')),
              icon: String(form.get('icon')) || '✦',
              category: String(form.get('category')),
              tags: String(form.get('tags'))
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
              minOpenBitFunVersion: String(form.get('minOpenBitFunVersion')),
              changelog: String(form.get('changelog')),
              license:
                licenseKind === 'spdx'
                  ? { spdxExpression: String(form.get('licenseValue')) }
                  : { customUrl: String(form.get('licenseValue')) },
              repositoryUrl: String(form.get('repositoryUrl')) || undefined,
            });
            submission = await marketApi.uploadPackage(submission.submissionId, packageFile);
            for (const [index, screenshot] of screenshots.slice(0, 5).entries()) {
              submission = await marketApi.uploadScreenshot(
                submission.submissionId,
                index,
                screenshot as File,
              );
            }
            await marketApi.submit(submission.submissionId);
            setDone(true);
            window.setTimeout(onSubmitted, 900);
          } catch (caught) {
            setError(caught);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset>
          <legend>{t('listingSection')}</legend>
          <div className="form-grid">
            <Field label={t('slugLabel')}>
              <Input className="market-input" name="slug" required pattern="[a-z0-9][a-z0-9-]{2,62}" defaultValue={initialSlug} readOnly={Boolean(listingId)} />
            </Field>
            <Field label={t('releaseNumberLabel')}>
              <Input className="market-input" name="releaseNumber" type="number" min="1" required defaultValue={initialRelease} readOnly={Boolean(listingId)} />
            </Field>
            <Field label={t('nameLabel')}>
              <Input className="market-input" name="name" required maxLength={80} />
            </Field>
            <Field label={t('iconLabel')}>
              <Input className="market-input" name="icon" defaultValue="✦" maxLength={8} />
            </Field>
            <Field label={t('categoryLabel')}>
              <select name="category" defaultValue="utilities">
                {MARKET_CATEGORIES.map((value) => (
                  <option key={value} value={value}>{categoryLabel(value, t)}</option>
                ))}
              </select>
            </Field>
            <Field label={t('tagsLabel')}>
              <Input className="market-input" name="tags" placeholder={t('tagsPlaceholder')} />
            </Field>
          </div>
          <Field label={t('descriptionLabel')}>
            <Textarea className="market-textarea" name="description" required maxLength={500} rows={3} />
          </Field>
        </fieldset>

        <fieldset>
          <legend>{t('releaseSection')}</legend>
          <div className="form-grid">
            <Field label={t('minOpenBitFunVersionLabel')}>
              <Input className="market-input" name="minOpenBitFunVersion" required defaultValue="1.0.0" />
            </Field>
            <Field label={t('publicRepositoryOptional')}>
              <Input className="market-input" name="repositoryUrl" type="url" placeholder="https://github.com/…" />
            </Field>
            <Field label={t('licenseTypeLabel')}>
              <select name="licenseKind">
                <option value="spdx">{t('spdxExpression')}</option>
                <option value="custom">{t('customLicenseUrl')}</option>
              </select>
            </Field>
            <Field label={t('licenseLabel')}>
              <Input className="market-input" name="licenseValue" required defaultValue="MIT" />
            </Field>
          </div>
          <Field label={t('changelog')}>
            <Textarea className="market-textarea" name="changelog" required rows={4} />
          </Field>
        </fieldset>

        <fieldset>
          <legend>{t('reviewBundle')}</legend>
          <div className="upload-grid">
            <Field label={t('package')}>
              <input name="package" type="file" accept=".bfminiapp,application/zip" required />
            </Field>
            <Field label={`${t('screenshots')} (1–5)`}>
              <input name="screenshots" type="file" accept="image/png,image/jpeg,image/webp" multiple required />
              <small className="field-hint">{t('listingImageHint')}</small>
            </Field>
          </div>
          <div className="safety-note">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <strong>{t('beforeUpload')}</strong>
              <span>{t('packageSafety')}</span>
            </div>
          </div>
        </fieldset>

        <Button labelBehavior="static" type="submit" className="button submit-button" disabled={busy}>
          <Package size={18} aria-hidden="true" />
          {busy ? t('uploading') : t('publishForReview')}
        </Button>
      </form>
    </main>
  );
}

function SubmissionsPage({
  webSubmissionsEnabled,
  me,
  authResolved,
  t,
}: {
  webSubmissionsEnabled: boolean;
  me?: Me;
  authResolved: boolean;
  t: (key: MessageKey) => string;
}) {
  const [items, setItems] = useState<MarketSubmission[]>([]);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (!me) return;
    void marketApi
      .submissions()
      .then((page) => setItems(page.items))
      .catch((caught) => setError(caught));
  }, [me]);
  if (!authResolved) return <PageLoading t={t} />;
  if (!me) return <AuthGate t={t} returnTo="/miniapp/submissions" />;
  return (
    <main className="narrow-page">
      <div className="page-intro">
        <span className="page-kicker">
          <ClockCounterClockwise size={18} aria-hidden="true" />
          {t('publisherHistory')}
        </span>
        <h1>{t('mySubmissions')}</h1>
      </div>
      {!webSubmissionsEnabled && <DesktopSubmissionNotice t={t} />}
      {error != null && <Notice tone="error">{errorMessage(error, t)}</Notice>}
      <div className="submission-list">
        {items.map((item) => (
          <SubmissionRow
            key={item.submissionId}
            item={item}
            t={t}
            action={
              webSubmissionsEnabled
              && (item.status === 'draft' || item.status === 'submitted') ? (
                <Button labelBehavior="static" type="button"
                  className="text-action danger-action"
                  onClick={async () => {
                    try {
                      await marketApi.withdrawSubmission(item.submissionId);
                      setItems((current) =>
                        current.map((submission) =>
                          submission.submissionId === item.submissionId
                            ? { ...submission, status: 'withdrawn' }
                            : submission,
                        ),
                      );
                    } catch (caught) {
                      setError(caught);
                    }
                  }}
                >
                  {t('withdraw')}
                </Button>
              ) : undefined
            }
          />
        ))}
        {error == null && items.length === 0 && (
          <div className="empty-state">
            <span className="empty-state-icon">
              <Tray size={18} aria-hidden="true" />
            </span>
            <p>{t('noSubmissions')}</p>
            {webSubmissionsEnabled && (
              <Button labelBehavior="static" type="button" className="button button-secondary" onClick={() => navigate('/submit')}>
                <UploadSimple size={18} aria-hidden="true" />
                {t('submit')}
              </Button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function WebSubmissionDisabledPage({ t }: { t: (key: MessageKey) => string }) {
  return (
    <main className="form-page">
      <div className="page-intro">
        <span className="page-kicker">
          <CubeFocus size={18} aria-hidden="true" />
          {t('publisherWorkspace')}
        </span>
        <h1>{t('webSubmissionDisabledTitle')}</h1>
        <p>{t('webSubmissionDisabledBody')}</p>
      </div>
      <DesktopSubmissionNotice t={t} />
    </main>
  );
}

function DesktopSubmissionNotice({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div className="safety-note desktop-submission-notice" role="note">
      <CubeFocus size={18} aria-hidden="true" />
      <div>
        <strong>{t('submitWithDesktop')}</strong>
        <span>{t('desktopSubmissionHint')}</span>
      </div>
    </div>
  );
}

function AdminPage({
  me,
  authResolved,
  locale,
  t,
}: {
  me?: Me;
  authResolved: boolean;
  locale: Locale;
  t: (key: MessageKey) => string;
}) {
  const [items, setItems] = useState<AdminSubmission[]>([]);
  const [selected, setSelected] = useState<AdminSubmissionDetail>();
  const [sourceName, setSourceName] = useState('meta.json');
  const [sourceMode, setSourceMode] = useState<'current' | 'diff'>('current');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>();

  const load = useCallback(async () => {
    try {
      setItems((await marketApi.adminSubmissions()).items);
    } catch (caught) {
      setError(caught);
    }
  }, []);
  useEffect(() => {
    if (me?.isAdmin) void load();
  }, [load, me]);
  if (!authResolved) return <PageLoading t={t} />;
  if (!me) return <AuthGate t={t} returnTo="/miniapp/admin" />;
  if (!me.isAdmin) {
    return (
      <main className="narrow-page">
        <Notice tone="error">{t('administratorRequired')}</Notice>
      </main>
    );
  }

  return (
    <main className="admin-page">
      <div className="page-intro">
        <span className="page-kicker">
          <ShieldCheck size={18} aria-hidden="true" />
          {t('adminEyebrow')}
        </span>
        <h1>{t('reviewQueue')}</h1>
      </div>
      {error != null && <Notice tone="error">{errorMessage(error, t)}</Notice>}
      <div className="review-layout">
        <div className="review-list">
          {items.map((item) => (
            <Button labelBehavior="static" type="button"
              key={item.submissionId}
              className={selected?.submission.submissionId === item.submissionId ? 'selected' : ''}
              onClick={async () => {
                try {
                  const detail = await marketApi.adminDetail(item.submissionId);
                  setSelected(detail);
                  setSourceName(Object.keys(detail.sourceFiles)[0] || 'meta.json');
                  setSourceMode('current');
                } catch (caught) {
                  setError(caught);
                }
              }}
            >
              <span className="app-icon">
                <MiniAppIcon name={item.icon} />
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>
                  <span>{item.slug}</span>
                  <span>v{item.releaseNumber}</span>
                </small>
                <small className="review-submission-meta">
                  <span>{item.submitter ? (item.submitter.githubId > 0 ? `@${item.submitter.login}` : item.submitter.login) : '—'}</span>
                  <span>
                    {item.submittedAt == null
                      ? '—'
                      : formatMarketDateTime(item.submittedAt, locale)}
                  </span>
                </small>
              </span>
              <StatusBadge status={item.status} t={t} />
            </Button>
          ))}
          {items.length === 0 && <p className="muted">{t('queueClear')}</p>}
        </div>
        <div className="review-detail">
          {!selected ? (
            <div className="review-placeholder">
              <FileCode size={18} aria-hidden="true" />
              <span>{t('reviewPlaceholder')}</span>
            </div>
          ) : (
            <>
              <div className="review-summary">
                <span className="detail-icon">
                  <MiniAppIcon name={selected.submission.icon} />
                </span>
                <div>
                  <h2>{selected.submission.name}</h2>
                  <p>{selected.submission.description}</p>
                </div>
              </div>
              <PermissionList permissions={selected.submission.permissions} t={t} />
              <div className="review-evidence-grid">
                <Fact
                  label={t('submitterLabel')}
                  value={selected.submitter ? (selected.submitter.githubId > 0 ? `@${selected.submitter.login}` : selected.submitter.login) : '—'}
                />
                <Fact
                  label={t('submittedAtLabel')}
                  value={selected.submittedAt == null
                    ? '—'
                    : formatMarketDateTime(selected.submittedAt, locale)}
                />
                <Fact label={t('releaseLabel')} value={`v${selected.submission.releaseNumber}`} />
                <Fact
                  label={t('minimumOpenBitFunLabel')}
                  value={selected.submission.minOpenBitFunVersion}
                />
                <Fact
                  label={t('licenseLabel')}
                  value={
                    selected.submission.license.spdxExpression
                    || selected.submission.license.customUrl
                    || t('notDeclared')
                  }
                />
                <Fact label={t('changelog')} value={selected.submission.changelog} />
              </div>
              {selected.submission.repositoryUrl && (
                <a
                  className="review-repository"
                  href={selected.submission.repositoryUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('publicRepository')}
                  <ArrowSquareOut size={18} aria-hidden="true" />
                </a>
              )}
              <div className="review-screenshots">
                {selected.submission.screenshotUrls.map((url, index) => (
                  <figure key={url}>
                    <img
                      src={marketImageUrl(url, 'large-v1')}
                      srcSet={marketImageSrcSet(url)}
                      sizes="(max-width: 800px) calc(100vw - 48px), 460px"
                      alt={`${t('submissionScreenshot')} ${index + 1}`}
                      loading="lazy"
                      decoding="async"
                      onError={(event) => retryOriginalMarketImage(event.currentTarget, url)}
                    />
                    <figcaption>
                      <span>#{index + 1}</span>
                      <code>{selected.screenshotHashes[index]}</code>
                    </figcaption>
                  </figure>
                ))}
              </div>
              <div className="hash-block">
                <span>{t('packageSha256')}</span>
                <code>{selected.submission.packageSha256}</code>
              </div>
              <div className="source-browser">
                <div className="source-mode">
                  <Button labelBehavior="static" type="button"
                    className={sourceMode === 'current' ? 'active' : ''}
                    onClick={() => setSourceMode('current')}
                  >
                    {t('currentSource')}
                  </Button>
                  <Button labelBehavior="static" type="button"
                    className={sourceMode === 'diff' ? 'active' : ''}
                    onClick={() => setSourceMode('diff')}
                  >
                    {t('sourceDiff')}
                  </Button>
                </div>
                <div className="source-tabs">
                  {Object.keys(selected.sourceDiffs).map((name) => (
                    <Button labelBehavior="static" type="button" className={sourceName === name ? 'active' : ''} onClick={() => setSourceName(name)} key={name}>{name}</Button>
                  ))}
                </div>
                <pre className={sourceMode === 'diff' ? 'diff-view' : ''}>
                  <code>
                    {sourceMode === 'diff'
                      ? selected.sourceDiffs[sourceName] || t('noSourceChanges')
                      : selected.sourceFiles[sourceName] || ''}
                  </code>
                </pre>
              </div>
              <div className="review-actions">
                <Button labelBehavior="static" type="button"
                  className="button"
                  onClick={async () => {
                    try {
                      await marketApi.review(selected.submission.submissionId, 'approve');
                      setSelected(undefined);
                      await load();
                    } catch (caught) {
                      setError(caught);
                    }
                  }}
                >
                  {t('approve')}
                </Button>
                <Input className="market-input" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('rejectionReason')} />
                <Button labelBehavior="static" type="button"
                  className="button button-danger"
                  disabled={!reason.trim()}
                  onClick={async () => {
                    try {
                      await marketApi.review(selected.submission.submissionId, 'reject', reason);
                      setSelected(undefined);
                      setReason('');
                      await load();
                    } catch (caught) {
                      setError(caught);
                    }
                  }}
                >
                  {t('reject')}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function DesktopComplete({ t }: { t: (key: MessageKey) => string }) {
  const [returnTo, setReturnTo] = useState<string | null>(null);
  useEffect(() => {
    const target = takeNativeAuthReturnTo();
    if (!target) return;
    setReturnTo(target);
    const timer = window.setTimeout(() => window.location.replace(target), 120);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <main className="form-page">
      <section className="auth-gate">
        <span className="gate-icon success">
          <CheckCircle size={18} aria-hidden="true" />
        </span>
        <h1>{t('authComplete')}</h1>
        <p>{t('authCompleteBody')}</p>
        {returnTo && <a className="button" href={returnTo}>{t('authReturnToApp')}</a>}
      </section>
    </main>
  );
}

function PermissionList({
  permissions,
  t,
}: {
  permissions: MiniAppPermissions;
  t: (key: MessageKey) => string;
}) {
  const rows = useMemo(() => {
    const values: string[] = [t('permissionPrivateStorage')];
    permissions.fs?.read?.forEach((scope) =>
      values.push(`${t('permissionReadFiles')}: ${scope}`),
    );
    permissions.fs?.write?.forEach((scope) =>
      values.push(`${t('permissionWriteFiles')}: ${scope}`),
    );
    permissions.shell?.allow?.forEach((command) =>
      values.push(`${t('permissionRunCommand')}: ${command}`),
    );
    permissions.net?.allow?.forEach((domain) =>
      values.push(`${t('permissionNetwork')}: ${domain}`),
    );
    if (permissions.ai?.enabled) values.push(t('permissionAi'));
    if (permissions.agent?.enabled) values.push(t('permissionAgent'));
    if (permissions.notifications?.system) values.push(t('permissionNotifications'));
    return values;
  }, [permissions, t]);
  return (
    <ul className="permission-list">
      {rows.map((row) => (
        <li key={row}>
          <span><Check size={18} aria-hidden="true" /></span>
          {row}
        </li>
      ))}
      <li className="node-denied">
        <span><X size={18} aria-hidden="true" /></span>
        {t('permissionNodeUnavailable')}
      </li>
    </ul>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="fact"><span>{label}</span><strong>{value}</strong></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Notice({ tone, children }: { tone: 'error' | 'success'; children: React.ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'error' ? (
        <WarningCircle size={18} aria-hidden="true" />
      ) : (
        <CheckCircle size={18} aria-hidden="true" />
      )}
      <span>{children}</span>
    </div>
  );
}

function AuthGate({ t, returnTo }: { t: (key: MessageKey) => string; returnTo: string }) {
  return (
    <main className="form-page">
      <section className="auth-gate">
        <span className="gate-icon">
          <GithubLogo weight="duotone" aria-hidden="true" />
        </span>
        <h1>{t('signInRequired')}</h1>
        <a className="button" href={loginUrl(returnTo)}>
          <GithubLogo weight="bold" aria-hidden="true" />
          {t('signIn')}
        </a>
      </section>
    </main>
  );
}

function SubmissionRow({
  item,
  action,
  t,
}: {
  item: MarketSubmission;
  action?: React.ReactNode;
  t: (key: MessageKey) => string;
}) {
  return (
    <article className="submission-row">
      <span className="app-icon">
        <MiniAppIcon name={item.icon} />
      </span>
      <div>
        <h2>{item.name}</h2>
        <p className="submission-meta">
          <span>{item.slug}</span>
          <span>{t('releaseLabel')} {item.releaseNumber}</span>
        </p>
        {item.rejectionReason && <p className="rejection">{item.rejectionReason}</p>}
      </div>
      <span className="hash">{item.packageSha256?.slice(0, 12) || t('packagePending')}</span>
      <StatusBadge status={item.status} t={t} />
      {action}
    </article>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: MarketSubmission['status'];
  t: (key: MessageKey) => string;
}) {
  const labels: Record<MarketSubmission['status'], MessageKey> = {
    draft: 'statusDraft',
    submitted: 'statusSubmitted',
    approved: 'statusApproved',
    rejected: 'statusRejected',
    withdrawn: 'statusWithdrawn',
  };
  return <span className={`status-badge ${status}`}>{t(labels[status])}</span>;
}

function PageLoading({ t }: { t: (key: MessageKey) => string }) {
  return (
    <main className="narrow-page loading-page">
      <span className="loading-mark">
        <MarketLogo weight="duotone" aria-hidden="true" />
      </span>
      <span>{t('loading')}</span>
    </main>
  );
}

function categoryLabel(value: string, t: (key: MessageKey) => string) {
  const labels: Record<string, MessageKey> = {
    developer: 'categoryDeveloper',
    productivity: 'categoryProductivity',
    data: 'categoryData',
    creative: 'categoryCreative',
    education: 'categoryEducation',
    utilities: 'categoryUtilities',
    entertainment: 'categoryEntertainment',
    other: 'categoryOther',
  };
  const key = labels[value];
  return key ? t(key) : value;
}

function localizedListing(
  listing: MarketListingSummary,
  locale: Locale,
): { name: string; description: string; tags: string[] } {
  const fallbacks =
    locale === 'zh-TW'
      ? ['zh-TW', 'zh-CN', 'en-US']
      : locale === 'zh-CN'
        ? ['zh-CN', 'en-US']
        : ['en-US', 'zh-CN'];
  const values = fallbacks
    .map((candidate) => listing.i18n?.locales?.[candidate])
    .filter((value) => value != null);
  return {
    name: values.find((value) => value?.name)?.name || listing.name,
    description:
      values.find((value) => value?.description)?.description || listing.description,
    tags: values.find((value) => value?.tags?.length)?.tags || listing.tags,
  };
}

class LocalizedUiError {
  constructor(readonly key: MessageKey) {}
}

function errorMessage(error: unknown, t: (key: MessageKey) => string) {
  if (error instanceof LocalizedUiError) return t(error.key);
  if (error instanceof MarketApiError) {
    if (error.code === 'market_not_public') return t('marketNotPublic');
    if (error.code === 'oauth_not_configured') return t('oauthNotConfigured');
    if (error.code === 'unauthorized') return t('signInRequired');
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export default App;
