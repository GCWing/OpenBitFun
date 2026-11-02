import { OverflowText,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Disclosure,
  Field,
  Icon,
  IconButton,
  Input,
  PageHeader,
  Select,
  StatusPill,
  Textarea,
} from '@openbitfun/ui';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Camera, Loader2 } from 'lucide-react';
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
  renderLayout?: (content: React.ReactNode, actions: React.ReactNode) => React.ReactElement;
}

const MiniAppSubmissionsView: React.FC<MiniAppSubmissionsViewProps> = ({ tabs, renderLayout }) => {
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
  const [showForm, setShowForm] = useState(false);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [formLoadFailed, setFormLoadFailed] = useState(false);
  const [progress, setProgress] = useState<MarketUploadProgress>();
  const accountRevision = useRef(0);
  const formId = useId();

  const localActionsDisabled = Boolean(workspace && isRemoteWorkspace(workspace));
  const selectedApp = useMemo(
    () => apps.find((app) => app.id === selectedAppId),
    [apps, selectedAppId],
  );

  const refresh = async () => {
    const revision = accountRevision.current;
    setLoading(true);
    try {
      const records = me ? await miniAppMarketAPI.listSubmissions() : [];
      if (revision === accountRevision.current) setSubmissions(records);
    } catch (error) {
      if (revision !== accountRevision.current) return;
      log.error('Failed to load MiniApp submissions', error);
      notification.error(t('market.messages.submissionsFailed', { error: String(error) }));
    } finally {
      if (revision === accountRevision.current) setLoading(false);
    }
  };

  const openSubmissionForm = async () => {
    if (localActionsDisabled || busy || formLoading || !me) return;
    const revision = accountRevision.current;
    setShowForm(true);
    setFormLoading(true);
    setFormLoadFailed(false);
    try {
      const [installed, currentClientVersion] = await Promise.all([
        miniAppAPI.listMiniApps(),
        draft.minOpenBitFunVersion ? Promise.resolve(undefined) : loadCurrentClientVersion(),
      ]);
      if (revision !== accountRevision.current) return;
      setApps(installed);
      if (currentClientVersion) {
        setDraft((current) =>
          applyCurrentClientVersionDefault(current, currentClientVersion),
        );
      }
      if (!selectedAppId && installed[0]) {
        selectApp(installed[0]);
      }
    } catch (error) {
      if (revision !== accountRevision.current) return;
      setFormLoadFailed(true);
      log.error('Failed to load MiniApp submission workspace', error);
      notification.error(t('market.messages.submissionsFailed', { error: String(error) }));
    } finally {
      if (revision === accountRevision.current) setFormLoading(false);
    }
  };

  useEffect(() => {
    if (!authResolved) return;
    accountRevision.current += 1;
    setShowForm(false);
    setCapturingScreenshot(false);
    setFormLoading(false);
    setFormLoadFailed(false);
    setSubmissions([]);
    setApps([]);
    setSelectedAppId('');
    setDraft(createEmptyMarketSubmissionDraft());
    setScreenshotPaths([]);
    setBusy(false);
    setProgress(undefined);
    void refresh();
    const stop = miniAppMarketAPI.onUploadProgress(setProgress);
    return () => {
      accountRevision.current += 1;
      stop();
    };
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
    const revision = accountRevision.current;
    setBusy(true);
    setCapturingScreenshot(true);
    const tabId: SceneTabId = `miniapp:${selectedApp.id}`;
    try {
      if (openTabs.some((tab) => tab.id === tabId)) {
        activateScene(tabId);
      } else {
        openScene(tabId);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      if (revision !== accountRevision.current) return;
      const path = await miniAppMarketAPI.captureWindow();
      if (revision !== accountRevision.current) return;
      setScreenshotPaths((current) => [path, ...current].slice(0, 5));
      notification.success(t('market.submissions.captured'));
    } catch (error) {
      if (revision !== accountRevision.current) return;
      notification.error(t('market.submissions.captureFailed', { error: String(error) }));
    } finally {
      if (revision === accountRevision.current) {
        activateScene('miniapps');
        setCapturingScreenshot(false);
        setBusy(false);
      }
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedApp || screenshotPaths.length === 0) {
      notification.error(t('market.submissions.missingFiles'));
      return;
    }
    const revision = accountRevision.current;
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
      if (revision !== accountRevision.current) return;
      setSubmissions((current) => [created, ...current]);
      setDraft((current) => ({
        ...current,
        listingId: created.listingId,
        releaseNumber: created.releaseNumber + 1,
        changelog: '',
      }));
      setScreenshotPaths([]);
      setShowForm(false);
      notification.success(t('market.submissions.submitted'));
    } catch (error) {
      if (revision !== accountRevision.current) return;
      notification.error(t('market.submissions.submitFailed', { error: String(error) }));
    } finally {
      if (revision === accountRevision.current) setBusy(false);
    }
  };

  const withdraw = async (submissionId: string) => {
    const revision = accountRevision.current;
    setBusy(true);
    try {
      const updated = await miniAppMarketAPI.withdrawSubmission(submissionId);
      if (revision !== accountRevision.current) return;
      setSubmissions((current) =>
        current.map((item) => item.submissionId === submissionId ? updated : item),
      );
      notification.success(t('market.submissions.withdrawn'));
    } catch (error) {
      if (revision !== accountRevision.current) return;
      notification.error(t('market.submissions.withdrawFailed', { error: String(error) }));
    } finally {
      if (revision === accountRevision.current) setBusy(false);
    }
  };

  const toolbarActions = !me || !authResolved ? null : (
    <>
      <Button size="sm" variant="quiet" onClick={() => void refresh()} disabled={busy || loading}>
        {t('market.submissions.refresh')}
      </Button>
      <Button size="sm" variant="quiet" disabled={busy || loading || showForm || localActionsDisabled}
        title={localActionsDisabled ? t('market.submissions.remoteUnsupported') : undefined}
        onClick={() => void openSubmissionForm()}>
        {t('market.submissions.newSubmission')}
      </Button>
    </>
  );
  const renderFrame = (content: React.ReactNode) => renderLayout
    ? renderLayout(<div className="miniapp-submissions">{content}</div>, toolbarActions)
    : (
      <GalleryLayout className="miniapp-gallery-pane miniapp-submissions">
        <div className="miniapp-gallery-pane__account-actions"><AccountIdentityControls showSignIn={false} /></div>
        <GalleryPageHeader
          title={t('market.submissions.title')}
          subtitle={t('market.submissions.subtitle')}
          actions={toolbarActions}
        />
        {tabs}
        {content}
      </GalleryLayout>
  );

  const renderEmptyState = (message: string, actions?: React.ReactNode) => (
    <div className="miniapp-submissions__history-empty">
      <div className="miniapp-submissions__empty-content">
        <p className="miniapp-submissions__empty-message" role="status">{message}</p>
        {actions}
      </div>
    </div>
  );

  if (!authResolved || loading) {
    return renderFrame(
      <div className="miniapp-submissions__loading"><Loader2 className="gallery-spinning" /></div>,
    );
  }

  if (!me) {
    return renderFrame(
      <div className="miniapp-submissions__workspace">
        {renderEmptyState(t('market.submissions.signInRequired'), <AccountIdentityControls />)}
      </div>,
    );
  }

  return renderFrame(
    <>
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
        <Dialog
          open={showForm && !capturingScreenshot}
          onOpenChange={() => { if (!busy) setShowForm(false); }}
          size="xl"
          className="miniapp-submissions miniapp-submissions__dialog"
          closeOnEscape={!busy}
          closeOnPointerOutside={!busy}
        >
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t('market.submissions.newTitle')}</DialogTitle>
              <DialogDescription>{t('market.submissions.newHint')}</DialogDescription>
            </DialogHeading>
            <DialogClose disabled={busy} />
          </DialogHeader>
          <DialogBody inset="none" className="miniapp-submissions__body">
            <div className="miniapp-submissions__form-content">
              {formLoading ? (
                <div className="miniapp-submissions__loading"><Loader2 className="gallery-spinning" /></div>
              ) : formLoadFailed ? (
                <GalleryEmpty icon={{ glyph: AlertTriangle }} message={t('market.submissions.prepareFailed')}
                  action={<Button onClick={() => void openSubmissionForm()}>{t('scene.retry')}</Button>} />
              ) : (
                <form
                  id={formId}
                  className="miniapp-submissions__form"
                  data-openbitfun-component="miniapp-submissions-view"
                  data-openbitfun-part="form"
                  onSubmit={(event) => void submit(event)}
                >
                  <section className="miniapp-submissions__section" aria-label={t('market.submissions.basicInformation')}>
                    <PageHeader title={t('market.submissions.basicInformation')} level={3} size="sm" />
                    <Field label={t('market.submissions.app')} controlWidth="fill">
                      <Select
                        size="sm"
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
                        size="sm"
                        value={draft.name}
                        maxLength={80}
                        disabled={busy}
                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                      />
                    </Field>

                    <Field label={t('market.submissions.description')} controlWidth="fill" required>
                      <Textarea
                        value={draft.description}
                        maxLength={500}
                        required
                        disabled={busy}
                        onValueChange={(description) => setDraft({ ...draft, description })}
                      />
                    </Field>
                  </section>

                  <section className="miniapp-submissions__section" aria-label={t('market.submissions.screenshots')}>
                    <PageHeader
                      className="miniapp-submissions__screenshots"
                      title={t('market.submissions.screenshots')}
                      level={3}
                      size="sm"
                      action={
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
                      }
                    />
                    <p className="miniapp-submissions__hint">{t('market.submissions.screenshotHint')}</p>
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
                  </section>

                  <Disclosure
                    className="miniapp-submissions__advanced-disclosure"
                    contentInnerClassName="miniapp-submissions__advanced-content"
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
                            size="sm"
                            value={draft.slug}
                            pattern="[a-z0-9][a-z0-9-]{2,62}"
                            disabled={busy}
                            onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
                          />
                        </Field>
                        <Field label={t('market.submissions.release')} controlWidth="fill" required>
                          <Input
                            size="sm"
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
                            size="sm"
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
                            size="sm"
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
                          size="sm"
                          value={draft.tags.join(', ')}
                          disabled={busy}
                          onChange={(event) =>
                            setDraft({ ...draft, tags: event.target.value.split(',').slice(0, 10) })
                          }
                        />
                      </Field>

                      <Field label={t('market.submissions.changelog')} controlWidth="fill">
                        <Textarea
                          value={draft.changelog}
                          maxLength={4000}
                          placeholder={t('market.submissions.changelogPlaceholder')}
                          disabled={busy}
                          onValueChange={(changelog) => setDraft({ ...draft, changelog })}
                        />
                      </Field>

                      <div className="miniapp-submissions__form-grid">
                        <Field
                          label={t('market.submissions.spdx')}
                          description={t('market.submissions.licenseHint')}
                          controlWidth="fill"
                        >
                          <Input
                            size="sm"
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
                            size="sm"
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
                          size="sm"
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
                </form>
              )}
            </div>
          </DialogBody>
          <DialogFooter separator>
            <div className="miniapp-submissions__actions">
              <Button type="button" size="sm" variant="fill" disabled={busy} onClick={() => setShowForm(false)}>
                {t('confirmDelete.cancel')}
              </Button>
              <Button
                type="submit"
                form={formId}
                size="sm"
                variant="primary"
                loading={busy}
                disabled={busy || localActionsDisabled || formLoading || formLoadFailed || apps.length === 0}
              >
                {t('market.submissions.submit')}
              </Button>
            </div>
          </DialogFooter>
        </Dialog>
        <section
          className="miniapp-submissions__history"
          aria-label={t('market.submissions.history')}
          data-openbitfun-component="miniapp-submissions-view"
          data-openbitfun-part="history"
        >
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
          ) : renderEmptyState(t('market.submissions.noSubmissions'))}
        </section>
      </div>
    </>
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
