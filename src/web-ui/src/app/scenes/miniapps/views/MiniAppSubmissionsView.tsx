import { OverflowText,
  Button,
  Disclosure,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  StatusPill,
  Textarea,
} from '@openbitfun/ui';
import React, { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Camera, Github, History, Loader2, PackageOpen, Send } from 'lucide-react';
import { GalleryEmpty, GalleryLayout, GalleryPageHeader } from '@/app/components/GalleryLayout';
import { useI18n } from '@/infrastructure/i18n';
import { AccountIdentityControls } from '@/features/market-account';
import { useAccountIdentity } from '@/infrastructure/account-identity';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import {
  miniAppMarketAPI,
  type MarketSubmission,
  type MarketSubmissionDraftRequest,
  type MarketUploadProgress,
} from '@/infrastructure/api/service-api/MiniAppMarketAPI';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { miniAppAPI } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { isRemoteWorkspace } from '@/shared/types';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useSceneManager } from '@/app/hooks/useSceneManager';
import type { SceneTabId } from '@/app/components/SceneBar/types';
import { renderMiniAppIcon } from '../utils/miniAppIcons';
import {
  applyCurrentClientVersionDefault,
  createEmptyMarketSubmissionDraft,
} from './miniAppSubmissionDraft';
import './MiniAppSubmissionsView.scss';

const log = createLogger('MiniAppSubmissionsView');

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

async function loadCurrentClientVersion(): Promise<string | undefined> {
  try {
    return await systemAPI.getAppVersion();
  } catch (error) {
    log.warn('Failed to load current OpenBitFun version for MiniApp submission defaults', error);
    return undefined;
  }
}

interface MiniAppSubmissionsViewProps {
  tabs?: React.ReactNode;
}

const MiniAppSubmissionsView: React.FC<MiniAppSubmissionsViewProps> = ({ tabs }) => {
  const { t } = useI18n('scenes/miniapp');
  const notification = useNotification();
  const { workspace } = useCurrentWorkspace();
  const { openScene, activateScene, openTabs } = useSceneManager();
  const { me, resolved: authResolved } = useAccountIdentity();
  const [apps, setApps] = useState<MiniAppMeta[]>([]);
  const [submissions, setSubmissions] = useState<MarketSubmission[]>([]);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [draft, setDraft] = useState<MarketSubmissionDraftRequest>(
    createEmptyMarketSubmissionDraft,
  );
  const [screenshotPaths, setScreenshotPaths] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<MarketUploadProgress>();

  const localActionsDisabled = Boolean(workspace && isRemoteWorkspace(workspace));
  const selectedApp = useMemo(
    () => apps.find((app) => app.id === selectedAppId),
    [apps, selectedAppId],
  );

  const refresh = async () => {
    setLoading(true);
    try {
      const [installed, currentClientVersion] = await Promise.all([
        miniAppAPI.listMiniApps(),
        draft.minOpenBitFunVersion ? Promise.resolve(undefined) : loadCurrentClientVersion(),
      ]);
      setApps(installed);
      if (currentClientVersion) {
        setDraft((current) =>
          applyCurrentClientVersionDefault(current, currentClientVersion),
        );
      }
      if (!selectedAppId && installed[0]) {
        selectApp(installed[0]);
      }
      if (me) {
        setSubmissions(await miniAppMarketAPI.listSubmissions());
      } else {
        setSubmissions([]);
      }
    } catch (error) {
      log.error('Failed to load MiniApp submission workspace', error);
      notification.error(t('market.messages.submissionsFailed', { error: String(error) }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!authResolved) return;
    void refresh();
    const stop = miniAppMarketAPI.onUploadProgress(setProgress);
    return stop;
    // Identity changes reload this account-owned workspace from the shared vault.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authResolved, me?.user.accountId, me?.user.githubId]);

  function selectApp(app: MiniAppMeta) {
    setSelectedAppId(app.id);
    setDraft((current) => ({
      ...current,
      slug: current.slug || suggestSlug(app.name),
      name: app.name,
      description: app.description,
      icon: app.icon || 'box',
      category: normalizeCategory(app.category),
      tags: app.tags,
    }));
  }

  const chooseScreenshots = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      title: t('market.submissions.chooseScreenshots'),
      filters: [
        {
          name: t('market.submissions.screenshotFiles'),
          extensions: ['png', 'jpg', 'jpeg', 'webp'],
        },
      ],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length > 5) {
      notification.error(t('market.submissions.screenshotLimit'));
      return;
    }
    setScreenshotPaths(paths);
  };

  const captureCurrentApp = async () => {
    if (!selectedApp) return;
    setBusy(true);
    const tabId: SceneTabId = `miniapp:${selectedApp.id}`;
    try {
      if (openTabs.some((tab) => tab.id === tabId)) {
        activateScene(tabId);
      } else {
        openScene(tabId);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      const path = await miniAppMarketAPI.captureWindow();
      setScreenshotPaths((current) => [path, ...current].slice(0, 5));
      notification.success(t('market.submissions.captured'));
    } catch (error) {
      notification.error(t('market.submissions.captureFailed', { error: String(error) }));
    } finally {
      activateScene('miniapps');
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedApp || screenshotPaths.length === 0) {
      notification.error(t('market.submissions.missingFiles'));
      return;
    }
    setBusy(true);
    setProgress({ phase: 'validating', completed: 0, total: 1 });
    try {
      // The marketplace rejects submissions declaring both license forms, so
      // an SPDX expression wins over a custom URL when both are filled in.
      const spdxExpression = draft.license.spdxExpression?.trim() || undefined;
      const customUrl = draft.license.customUrl?.trim() || undefined;
      const changelogFallback = draft.releaseNumber > 1
        ? t('market.submissions.changelogFallbackUpdate')
        : t('market.submissions.changelogFallbackFirst');
      const created = await miniAppMarketAPI.submitInstalled(
        selectedApp.id,
        {
          ...draft,
          slug: draft.slug.trim().toLowerCase(),
          name: draft.name.trim(),
          description: draft.description.trim(),
          changelog: draft.changelog.trim() || changelogFallback,
          tags: draft.tags.map((tag) => tag.trim()).filter(Boolean),
          repositoryUrl: draft.repositoryUrl?.trim() || undefined,
          license: spdxExpression ? { spdxExpression } : { customUrl },
        },
        screenshotPaths,
      );
      setSubmissions((current) => [created, ...current]);
      setDraft((current) => ({
        ...current,
        listingId: created.listingId,
        releaseNumber: created.releaseNumber + 1,
        changelog: '',
      }));
      setScreenshotPaths([]);
      notification.success(t('market.submissions.submitted'));
    } catch (error) {
      notification.error(t('market.submissions.submitFailed', { error: String(error) }));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (submissionId: string) => {
    setBusy(true);
    try {
      const updated = await miniAppMarketAPI.withdrawSubmission(submissionId);
      setSubmissions((current) =>
        current.map((item) => item.submissionId === submissionId ? updated : item),
      );
      notification.success(t('market.submissions.withdrawn'));
    } catch (error) {
      notification.error(t('market.submissions.withdrawFailed', { error: String(error) }));
    } finally {
      setBusy(false);
    }
  };

  if (!authResolved || loading) {
    return (
      <GalleryLayout className="miniapp-gallery-pane miniapp-submissions">
        <GalleryPageHeader
          title={t('market.submissions.title')}
          subtitle={t('market.submissions.subtitle')}
        />
        {tabs}
        <div className="miniapp-submissions__loading"><Loader2 className="gallery-spinning" /></div>
      </GalleryLayout>
    );
  }

  if (!me) {
    return (
      <GalleryLayout className="miniapp-gallery-pane miniapp-submissions">
        <GalleryPageHeader
          title={t('market.submissions.title')}
          subtitle={t('market.submissions.subtitle')}
        />
        {tabs}
        <GalleryEmpty
          icon={{ glyph: Github }}
          message={t('market.submissions.signInRequired')}
          action={<AccountIdentityControls />}
        />
      </GalleryLayout>
    );
  }

  return (
    <GalleryLayout className="miniapp-gallery-pane miniapp-submissions">
      <GalleryPageHeader
        title={t('market.submissions.title')}
        subtitle={t('market.submissions.subtitle')}
        actions={(
          <div className="miniapp-submissions__header-actions">
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy} leadingIcon={<Icon name="refresh" size="sm" />}>

              {t('market.submissions.refresh')}
            </Button>
            <AccountIdentityControls />
          </div>
        )}
      />

      {tabs}

      {localActionsDisabled ? (
        <div className="miniapp-submissions__remote-warning">
          <AlertTriangle size={16} />
          {t('market.submissions.remoteUnsupported')}
        </div>
      ) : null}

      <div
        className="miniapp-submissions__workspace"
        data-openbitfun-component="miniapp-submissions-view"
        data-openbitfun-part="root"
      >
        <form
          className="miniapp-submissions__form"
          data-openbitfun-component="miniapp-submissions-view"
          data-openbitfun-part="form"
          onSubmit={(event) => void submit(event)}
        >
          <header className="miniapp-submissions__section-heading">
            <h3>
              <PackageOpen size={14} />
              {t('market.submissions.newTitle')}
            </h3>
            <p>{t('market.submissions.newHint')}</p>
          </header>

          <Field label={t('market.submissions.app')} controlWidth="fill">
            <Select
              value={selectedAppId}
              onValueChange={(value) => {
                const app = apps.find((item) => item.id === value);
                if (app) selectApp(app);
              }}
              disabled={busy || localActionsDisabled}
              options={apps.map((app) => ({ value: app.id, label: app.name }))}
            />
          </Field>

          <Field label={t('market.submissions.name')} controlWidth="fill" required>
            <Input
              value={draft.name}
              maxLength={80}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>

          <label className="miniapp-submissions__field">
            <span>{t('market.submissions.description')}</span>
            <Textarea
              value={draft.description}
              maxLength={500}
              required
              disabled={busy}
              onValueChange={(description) => setDraft({ ...draft, description })}
            />
          </label>

          <div className="miniapp-submissions__screenshots">
            <div className="miniapp-submissions__screenshots-copy">
              <span>{t('market.submissions.screenshots')}</span>
              <small>{t('market.submissions.screenshotHint')}</small>
            </div>
            <div className="miniapp-submissions__screenshots-actions">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || localActionsDisabled}
                onClick={() => void chooseScreenshots()}
                leadingIcon={<Icon name="image" size="sm" />}
              >

                {t('market.submissions.choose')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || localActionsDisabled || !selectedApp}
                onClick={() => void captureCurrentApp()}
                leadingIcon={<Camera size={14} />}
              >

                {t('market.submissions.capture')}
              </Button>
            </div>
          </div>
          {screenshotPaths.length ? (
            <div className="miniapp-submissions__files">
              {screenshotPaths.map((path) => (
                <div key={path}>
                  <Icon name="image" size="sm" />
                  <OverflowText title={path}>{fileName(path)}</OverflowText>
                  <IconButton
                    size="xs"
                    aria-label={t('market.submissions.removeScreenshot')}
                    title={t('market.submissions.removeScreenshot')}
                    onClick={() =>
                      setScreenshotPaths((current) => current.filter((item) => item !== path))
                    }
                    icon={<Icon name="xmark" size="xs" />}
                  />
                </div>
              ))}
            </div>
          ) : null}

          <Disclosure
            className="miniapp-submissions__advanced-disclosure"
            open={showAdvanced}
            onOpenChange={setShowAdvanced}
            summary={t('market.submissions.advanced')}
            description={!showAdvanced ? (
              <span>
                {[
                  draft.slug,
                  `v${draft.releaseNumber}`,
                  marketCategoryLabel(
                    normalizeCategory(draft.category) as (typeof MARKET_CATEGORIES)[number],
                    t,
                  ),
                  draft.license.spdxExpression,
                ].filter(Boolean).join(' · ')}
              </span>
            ) : undefined}
          >
            <div className="miniapp-submissions__advanced">
              <div className="miniapp-submissions__form-grid">
                <Field
                  label={t('market.submissions.slug')}
                  description={t('market.submissions.slugHint')}
                  controlWidth="fill"
                  required
                >
                  <Input
                    value={draft.slug}
                    pattern="[a-z0-9][a-z0-9-]{2,62}"
                    disabled={busy}
                    onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
                  />
                </Field>
                <Field label={t('market.submissions.release')} controlWidth="fill" required>
                  <Input
                    type="number"
                    min={1}
                    max={4294967295}
                    value={draft.releaseNumber}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({ ...draft, releaseNumber: Number(event.target.value) })
                    }
                  />
                </Field>
              </div>

              <div className="miniapp-submissions__form-grid">
                <Field label={t('market.submissions.category')} controlWidth="fill">
                  <Select
                    value={draft.category}
                    disabled={busy}
                    onValueChange={(value) => setDraft({ ...draft, category: String(value) })}
                    options={MARKET_CATEGORIES.map((value) => ({
                      value,
                      label: marketCategoryLabel(value, t),
                    }))}
                  />
                </Field>
                <Field label={t('market.submissions.minVersion')} controlWidth="fill" required>
                  <Input
                    value={draft.minOpenBitFunVersion}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({ ...draft, minOpenBitFunVersion: event.target.value })
                    }
                  />
                </Field>
              </div>

              <Field
                label={t('market.submissions.tags')}
                description={t('market.submissions.tagsHint')}
                controlWidth="fill"
              >
                <Input
                  value={draft.tags.join(', ')}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, tags: event.target.value.split(',').slice(0, 10) })
                  }
                />
              </Field>

              <label className="miniapp-submissions__field">
                <span>{t('market.submissions.changelog')}</span>
                <Textarea
                  value={draft.changelog}
                  maxLength={4000}
                  placeholder={t('market.submissions.changelogPlaceholder')}
                  disabled={busy}
                  onValueChange={(changelog) => setDraft({ ...draft, changelog })}
                />
              </label>

              <div className="miniapp-submissions__form-grid">
                <Field
                  label={t('market.submissions.spdx')}
                  description={t('market.submissions.licenseHint')}
                  controlWidth="fill"
                >
                  <Input
                    value={draft.license.spdxExpression ?? ''}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        license: { ...draft.license, spdxExpression: event.target.value },
                      })
                    }
                  />
                </Field>
                <Field label={t('market.submissions.licenseUrl')} controlWidth="fill">
                  <Input
                    type="url"
                    value={draft.license.customUrl ?? ''}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        license: { ...draft.license, customUrl: event.target.value },
                      })
                    }
                  />
                </Field>
              </div>

              <Field label={t('market.submissions.repository')} controlWidth="fill">
                <Input
                  type="url"
                  value={draft.repositoryUrl ?? ''}
                  disabled={busy}
                  onChange={(event) => setDraft({ ...draft, repositoryUrl: event.target.value })}
                />
              </Field>
            </div>
          </Disclosure>

          {progress && busy ? (
            <div className="miniapp-submissions__progress">
              <div>
                <span>{progressLabel(progress.phase, t)}</span>
                <strong>{progress.completed}/{progress.total}</strong>
              </div>
              <progress value={progress.completed} max={Math.max(progress.total, 1)} />
            </div>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            disabled={busy || localActionsDisabled || apps.length === 0}
          >
            {busy ? <Loader2 size={15} className="gallery-spinning" /> : <Send size={15} />}
            {t('market.submissions.submit')}
          </Button>
        </form>

        <section
          className="miniapp-submissions__history"
          data-openbitfun-component="miniapp-submissions-view"
          data-openbitfun-part="history"
        >
          <header className="miniapp-submissions__section-heading">
            <h3>
              <History size={14} />
              {t('market.submissions.history')}
            </h3>
            <p>{t('market.submissions.historyHint')}</p>
          </header>
          {submissions.length ? (
            <div className="miniapp-submissions__list">
              {submissions.map((submission) => (
                <article
                  key={submission.submissionId}
                  data-openbitfun-component="miniapp-submissions-view"
                  data-openbitfun-part="item"
                >
                  <div className="miniapp-submissions__list-head">
                    <span className="miniapp-submissions__app-icon">
                      {renderMiniAppIcon(submission.icon || 'box', 16)}
                    </span>
                    <div>
                      <strong><OverflowText>{submission.name}</OverflowText></strong>
                      <small><OverflowText>{submission.slug} · v{submission.releaseNumber}</OverflowText></small>
                    </div>
                  </div>
                  <div className="miniapp-submissions__status">
                    <StatusPill tone={statusVariant(submission.status)}>
                      {submissionStatusLabel(submission.status, t)}
                    </StatusPill>
                    {(submission.status === 'draft' || submission.status === 'submitted') ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void withdraw(submission.submissionId)}
                      >
                        {t('market.submissions.withdraw')}
                      </Button>
                    ) : null}
                  </div>
                  {submission.rejectionReason ? (
                    <p className="miniapp-submissions__rejection">{t('market.submissions.rejection', {
                      reason: submission.rejectionReason,
                    })}</p>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="miniapp-submissions__history-empty">
              {t('market.submissions.noSubmissions')}
            </div>
          )}
        </section>
      </div>
    </GalleryLayout>
  );
};

function suggestSlug(name: string): string {
  const value = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return value.length >= 3 ? value : 'my-miniapp';
}

function normalizeCategory(category: string): string {
  const aliases: Record<string, string> = {
    utility: 'utilities',
    game: 'entertainment',
    games: 'entertainment',
    dev: 'developer',
  };
  const normalized = aliases[category] ?? category;
  return MARKET_CATEGORIES.includes(normalized as (typeof MARKET_CATEGORIES)[number])
    ? normalized
    : 'other';
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function statusVariant(
  status: MarketSubmission['status'],
): 'neutral' | 'info' | 'success' | 'warning' {
  switch (status) {
    case 'approved': return 'success';
    case 'submitted': return 'info';
    case 'rejected': return 'warning';
    default: return 'neutral';
  }
}

function marketCategoryLabel(
  category: (typeof MARKET_CATEGORIES)[number],
  t: (key: string) => string,
): string {
  switch (category) {
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

function progressLabel(
  phase: MarketUploadProgress['phase'],
  t: (key: string) => string,
): string {
  switch (phase) {
    case 'validating': return t('market.submissions.progress.validating');
    case 'package': return t('market.submissions.progress.package');
    case 'screenshots': return t('market.submissions.progress.screenshots');
    case 'submitted': return t('market.submissions.progress.submitted');
  }
}

function submissionStatusLabel(
  status: MarketSubmission['status'],
  t: (key: string) => string,
): string {
  switch (status) {
    case 'draft': return t('market.submissions.status.draft');
    case 'submitted': return t('market.submissions.status.submitted');
    case 'approved': return t('market.submissions.status.approved');
    case 'rejected': return t('market.submissions.status.rejected');
    case 'withdrawn': return t('market.submissions.status.withdrawn');
  }
}

export default MiniAppSubmissionsView;
