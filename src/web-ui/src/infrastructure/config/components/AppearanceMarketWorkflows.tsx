import { captureConfirmationAnchor, OverflowText, Button, Disclosure, Empty, Field, Icon, Input, Select, ScrollArea, Textarea } from '@openbitfun/ui';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Inbox, ShieldCheck } from 'lucide-react';
import { confirmDialog } from '@/infrastructure/confirm-dialog';
import {
  appearanceMarketAPI,
  type AppearanceAdminSubmissionDetail,
  type AppearanceMarketSubmission,
} from '@/infrastructure/api/service-api/AppearanceMarketAPI';
import { marketImageUrl, retryOriginalMarketImage } from '@/infrastructure/api/service-api/MarketImage';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { notificationService } from '@/shared/notification-system';
import { getVersionInfo } from '@/shared/utils/version';

export type AppearanceMarketWorkflow = 'submissions' | 'review';

interface AppearanceMarketWorkflowsProps {
  workflow: AppearanceMarketWorkflow;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canWithdraw(submission: AppearanceMarketSubmission): boolean {
  return submission.status === 'draft' || submission.status === 'submitted';
}

function submissionDisplayStatus(submission: AppearanceMarketSubmission): string {
  if (submission.status === 'approved'
    && submission.publicationStatus
    && submission.publicationStatus !== 'published') {
    return submission.publicationStatus;
  }
  return submission.status;
}

type ManualLicenseKind = 'spdx' | 'custom';

interface ManualSubmissionDraft {
  packagePath: string;
  slug: string;
  licenseKind: ManualLicenseKind;
  licenseValue: string;
  changelog: string;
  repositoryUrl: string;
  minOpenBitFunVersion: string;
}

function createManualSubmissionDraft(): ManualSubmissionDraft {
  return {
    packagePath: '',
    slug: '',
    licenseKind: 'spdx',
    licenseValue: '',
    changelog: '',
    repositoryUrl: '',
    minOpenBitFunVersion: getVersionInfo().version,
  };
}

export function AppearanceMarketWorkflows({ workflow }: AppearanceMarketWorkflowsProps) {
  const { t, formatDate } = useI18n('settings/appearance');
  const [submissions, setSubmissions] = useState<AppearanceMarketSubmission[]>([]);
  const [reviewQueue, setReviewQueue] = useState<AppearanceMarketSubmission[]>([]);
  const [reviewDetail, setReviewDetail] = useState<AppearanceAdminSubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [manualSubmitOpen, setManualSubmitOpen] = useState(false);
  const [manualDraft, setManualDraft] = useState<ManualSubmissionDraft>(
    createManualSubmissionDraft,
  );
  const [submitting, setSubmitting] = useState(false);
  const manualSubmitAvailable = isTauriRuntime();

  const formattedDate = (timestamp: number) => formatDate(timestamp * 1000, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const loadSubmissions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSubmissions(await appearanceMarketAPI.listSubmissions());
    } catch (loadError) {
      setError(errorMessage(loadError));
      setSubmissions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const openReview = useCallback(async (submissionId: string) => {
    setDetailLoading(true);
    setError(null);
    setReason('');
    try {
      setReviewDetail(await appearanceMarketAPI.getReviewSubmission(submissionId));
    } catch (loadError) {
      setError(errorMessage(loadError));
      setReviewDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadReviewQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const queue = await appearanceMarketAPI.listReviewSubmissions();
      setReviewQueue(queue);
      if (queue.length === 0) {
        setReviewDetail(null);
      } else if (!reviewDetail
        || !queue.some(item => item.submissionId === reviewDetail.submission.submissionId)) {
        await openReview(queue[0].submissionId);
      }
    } catch (loadError) {
      setError(errorMessage(loadError));
      setReviewQueue([]);
      setReviewDetail(null);
    } finally {
      setLoading(false);
    }
  }, [openReview, reviewDetail]);

  useEffect(() => {
    if (workflow === 'submissions') void loadSubmissions();
    else void loadReviewQueue();
  // Reload only when the selected workflow changes. Review actions refresh explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow]);

  const withdraw = async (submission: AppearanceMarketSubmission, trigger?: HTMLElement) => {
    const confirmed = await confirmDialog({
      anchor: captureConfirmationAnchor(trigger),
      title: t('package.market.submissions.withdrawTitle'),
      message: t('package.market.submissions.withdrawMessage', { name: submission.name || submission.slug }),
      confirmText: t('package.market.submissions.withdraw'),
      type: 'warning',
    });
    if (!confirmed) return;
    setActingId(submission.submissionId);
    setError(null);
    try {
      const updated = await appearanceMarketAPI.withdrawSubmission(submission.submissionId);
      setSubmissions(items => items.map(item => (
        item.submissionId === updated.submissionId ? updated : item
      )));
      notificationService.success(t('package.market.submissions.withdrawn'));
    } catch (withdrawError) {
      setError(errorMessage(withdrawError));
    } finally {
      setActingId(null);
    }
  };

  const choosePackage = async () => {
    try {
      const packagePath = await appearanceMarketAPI.chooseSubmissionPackage(
        t('package.market.submissions.manual.chooseTitle'),
      );
      if (packagePath) {
        setManualDraft(current => ({ ...current, packagePath }));
      }
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    }
  };

  const submitPackage = async (event: FormEvent) => {
    event.preventDefault();
    const licenseValue = manualDraft.licenseValue.trim();
    if (!manualDraft.packagePath || !licenseValue) return;
    setSubmitting(true);
    setError(null);
    try {
      const submission = await appearanceMarketAPI.submitPackage({
        packagePath: manualDraft.packagePath,
        slug: manualDraft.slug.trim() || undefined,
        minOpenBitFunVersion: manualDraft.minOpenBitFunVersion.trim() || undefined,
        changelog: manualDraft.changelog.trim() || undefined,
        license: manualDraft.licenseKind === 'spdx'
          ? { spdxExpression: licenseValue }
          : { customUrl: licenseValue },
        repositoryUrl: manualDraft.repositoryUrl.trim() || undefined,
      });
      setSubmissions(items => [submission, ...items.filter(item => (
        item.submissionId !== submission.submissionId
      ))]);
      setManualDraft(createManualSubmissionDraft());
      setManualSubmitOpen(false);
      notificationService.success(t('package.market.submissions.manual.success'));
    } catch (submitError) {
      const message = errorMessage(submitError);
      setError(message);
      notificationService.error(t('package.market.submissions.manual.failed', { error: message }), {
        duration: 5000,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const renderManualSubmit = () => manualSubmitOpen && (
    <form
      className="appearance-market__manual-submit"
      data-openbitfun-component="appearance-settings"
      data-openbitfun-part="marketManualSubmit"
      onSubmit={event => void submitPackage(event)}
    >
      <div className="appearance-market__manual-submit-heading">
        <div>
          <strong>{t('package.market.submissions.manual.title')}</strong>
          <p>{t('package.market.submissions.manual.hint')}</p>
        </div>
      </div>
      <div className="appearance-market__manual-package-row">
        <Field
          label={t('package.market.submissions.manual.package')}
          controlWidth="fill"
          required
        >
          <Input
            value={manualDraft.packagePath}
            placeholder={t('package.market.submissions.manual.packagePlaceholder')}
            readOnly
          />
        </Field>
        <Button type="button" variant="outline" onClick={() => void choosePackage()} disabled={submitting}>
          {t('package.market.submissions.manual.choose')}
        </Button>
      </div>
      <div className="appearance-market__manual-submit-grid">
        <Field label={t('package.market.submissions.manual.slug')} controlWidth="fill">
          <Input
            value={manualDraft.slug}
            placeholder={t('package.market.submissions.manual.slugPlaceholder')}
            pattern="[a-z0-9][a-z0-9-]{2,62}"
            maxLength={63}
            onChange={event => setManualDraft(current => ({
              ...current,
              slug: event.target.value.toLowerCase(),
            }))}
          />
        </Field>
        <Field label={t('package.market.submissions.manual.licenseType')} controlWidth="fill">
          <Select
            size="sm"
            value={manualDraft.licenseKind}
            options={[
              { value: 'spdx', label: t('package.market.submissions.manual.spdx') },
              { value: 'custom', label: t('package.market.submissions.manual.custom') },
            ]}
            onValueChange={value => setManualDraft(current => ({
              ...current,
              licenseKind: value as ManualLicenseKind,
              licenseValue: '',
            }))}
          />
        </Field>
        <Field
          label={manualDraft.licenseKind === 'spdx'
            ? t('package.market.submissions.manual.spdxExpression')
            : t('package.market.submissions.manual.customLicenseUrl')}
          controlWidth="fill"
          required
        >
          <Input
            value={manualDraft.licenseValue}
            placeholder={manualDraft.licenseKind === 'spdx'
              ? 'MIT'
              : 'https://example.com/license'}
            type={manualDraft.licenseKind === 'custom' ? 'url' : 'text'}
            maxLength={manualDraft.licenseKind === 'spdx' ? 120 : 2048}
            onChange={event => setManualDraft(current => ({
              ...current,
              licenseValue: event.target.value,
            }))}
          />
        </Field>
        <Field
          label={t('package.market.submissions.manual.minVersion')}
          controlWidth="fill"
          required
        >
          <Input
            value={manualDraft.minOpenBitFunVersion}
            onChange={event => setManualDraft(current => ({
              ...current,
              minOpenBitFunVersion: event.target.value,
            }))}
          />
        </Field>
      </div>
      <Field label={t('package.market.submissions.manual.repository')} controlWidth="fill">
        <Input
          value={manualDraft.repositoryUrl}
          placeholder="https://github.com/owner/repository"
          type="url"
          onChange={event => setManualDraft(current => ({
            ...current,
            repositoryUrl: event.target.value,
          }))}
        />
      </Field>
      <Textarea
        label={t('package.market.submissions.manual.changelog')}
        hint={t('package.market.submissions.manual.changelogHint')}
        value={manualDraft.changelog}
        rows={3}
        maxLength={2000}
        showCount
        onChange={event => setManualDraft(current => ({
          ...current,
          changelog: event.target.value,
        }))}
      />
      <div className="appearance-market__manual-submit-actions">
        <Button
          type="button"
          variant="fill"
          disabled={submitting}
          onClick={() => setManualSubmitOpen(false)}
        >
          {t('package.market.submissions.manual.cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={!manualDraft.packagePath || !manualDraft.licenseValue.trim()}
          leadingIcon={<Icon name="upload" size="sm" aria-hidden="true" />}
        >

          {t('package.market.submissions.manual.submit')}
        </Button>
      </div>
    </form>
  );

  const decide = async (decision: 'approve' | 'reject') => {
    if (!reviewDetail || (decision === 'reject' && !reason.trim())) return;
    const submissionId = reviewDetail.submission.submissionId;
    setActingId(submissionId);
    setError(null);
    try {
      await appearanceMarketAPI.reviewSubmission(submissionId, decision, reason.trim());
      notificationService.success(t(`package.market.review.${decision}Success`));
      setReviewDetail(null);
      setReason('');
      await loadReviewQueue();
    } catch (reviewError) {
      setError(errorMessage(reviewError));
    } finally {
      setActingId(null);
    }
  };

  const renderError = () => error && (
    <div className="appearance-market__error" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{error}</span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void (workflow === 'submissions' ? loadSubmissions() : loadReviewQueue())}
      >
        {t('package.market.retry')}
      </Button>
    </div>
  );

  if (workflow === 'submissions') {
    return (
      <section
        className="appearance-market__workflow"
        data-openbitfun-component="appearance-settings"
        data-openbitfun-part="marketWorkflow"
        aria-labelledby="appearance-market-submissions-title"
      >
        <header className="appearance-market__workflow-heading">
          <div>
            <h3 id="appearance-market-submissions-title">{t('package.market.submissions.title')}</h3>
            <p>{t('package.market.submissions.hint')}</p>
          </div>
          <div className="appearance-market__workflow-actions">
            {manualSubmitAvailable && (
              <Button
                variant={manualSubmitOpen ? 'outline' : 'primary'}
                size="sm"
                onClick={() => setManualSubmitOpen(open => !open)}
                disabled={submitting}
                leadingIcon={<Icon name="upload" size="sm" aria-hidden="true" />}
              >

                {t('package.market.submissions.manual.open')}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void loadSubmissions()} disabled={loading} leadingIcon={<Icon name="refresh" size="sm" aria-hidden="true" />}>

              {t('package.market.submissions.refresh')}
            </Button>
          </div>
        </header>
        {renderError()}
        <ScrollArea className="appearance-market__workflow-body">
          {renderManualSubmit()}
          {loading ? <p className="appearance-market__loading">{t('package.market.submissions.loading')}</p>
            : submissions.length === 0 ? (
              <Empty
                className="appearance-market__empty"
                icon={<Inbox aria-hidden="true" />}
                description={t('package.market.submissions.empty')}
              />
            ) : (
              <div
                className="appearance-market__submission-list"
                data-openbitfun-component="appearance-settings"
                data-openbitfun-part="marketSubmissionList"
              >
                {submissions.map(submission => (
                  <article
                    key={submission.submissionId}
                    className="appearance-market__submission"
                    data-openbitfun-component="appearance-settings"
                    data-openbitfun-part="marketSubmission"
                  >
                    <div className="appearance-market__submission-preview">
                      {submission.previewUrl
                        ? (
                          <img
                            src={marketImageUrl(submission.previewUrl, 'compact-v1')}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            onError={(event) => retryOriginalMarketImage(event.currentTarget, submission.previewUrl!)}
                          />
                        )
                        : <Icon name="image" size="lg" aria-hidden="true" />}
                    </div>
                    <div className="appearance-market__submission-body">
                      <div className="appearance-market__submission-title">
                        <strong><OverflowText>{submission.name || submission.slug}</OverflowText></strong>
                        <span className={`appearance-market__submission-status appearance-market__submission-status--${submissionDisplayStatus(submission)}`}>
                          {t(`package.market.submissions.status.${submissionDisplayStatus(submission)}`)}
                        </span>
                      </div>
                      <p><OverflowText>{submission.description || submission.slug}</OverflowText></p>
                      <small><OverflowText>
                        {submission.packageVersion ? `v${submission.packageVersion} · ` : ''}
                        {t('package.market.submissions.updated', { date: formattedDate(submission.updatedAt) })}
                      </OverflowText></small>
                      {submission.rejectionReason && (
                        <p className="appearance-market__submission-rejection"><OverflowText>
                          {t('package.market.submissions.rejection', { reason: submission.rejectionReason })}
                        </OverflowText></p>
                      )}
                    </div>
                    {canWithdraw(submission) && (
                      <Button
                        className="appearance-market__submission-action"
                        variant="outline"
                        size="sm"
                        loading={actingId === submission.submissionId}
                        onClick={event => void withdraw(submission, event.currentTarget)}
                      >
                        {t('package.market.submissions.withdraw')}
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            )}
        </ScrollArea>
      </section>
    );
  }

  return (
    <section
      className="appearance-market__workflow"
      data-openbitfun-component="appearance-settings"
      data-openbitfun-part="marketWorkflow"
      aria-labelledby="appearance-market-review-title"
    >
      <header className="appearance-market__workflow-heading">
        <div>
          <h3 id="appearance-market-review-title">{t('package.market.review.title')}</h3>
          <p>{t('package.market.review.hint')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadReviewQueue()} disabled={loading} leadingIcon={<Icon name="refresh" size="sm" aria-hidden="true" />}>

          {t('package.market.review.refresh')}
        </Button>
      </header>
      {renderError()}
      {loading && reviewQueue.length === 0 ? (
        <p className="appearance-market__loading">{t('package.market.review.loading')}</p>
      ) : reviewQueue.length === 0 ? (
        <Empty
          className="appearance-market__empty"
          icon={<ShieldCheck aria-hidden="true" />}
          description={t('package.market.review.empty')}
        />
      ) : (
        <div
          className="appearance-market__review-layout"
          data-openbitfun-component="appearance-settings"
          data-openbitfun-part="marketReviewLayout"
        >
          <ScrollArea
            className="appearance-market__review-queue"
            data-openbitfun-component="appearance-settings"
            data-openbitfun-part="marketReviewQueue"
          >
            {reviewQueue.map(submission => (
              <button data-overflow-trigger
                key={submission.submissionId}
                type="button"
                className="appearance-market__review-item"
                data-active={reviewDetail?.submission.submissionId === submission.submissionId || undefined}
                onClick={() => void openReview(submission.submissionId)}
              >
                <strong><OverflowText>{submission.name || submission.slug}</OverflowText></strong>
                <OverflowText>{submission.packageVersion ? `v${submission.packageVersion}` : submission.slug}</OverflowText>
                <small><OverflowText>{formattedDate(submission.updatedAt)}</OverflowText></small>
              </button>
            ))}
          </ScrollArea>
          <ScrollArea
            className="appearance-market__review-detail"
            data-openbitfun-component="appearance-settings"
            data-openbitfun-part="marketReviewDetail"
          >
            {detailLoading || !reviewDetail ? (
              <p className="appearance-market__loading">{t('package.market.review.detailLoading')}</p>
            ) : (
              <>
                <div className="appearance-market__review-heading">
                  <div>
                    <h4>{reviewDetail.submission.name || reviewDetail.submission.slug}</h4>
                    <p>{reviewDetail.submission.description}</p>
                  </div>
                  {reviewDetail.submission.previewUrl && (
                    <img
                      src={marketImageUrl(reviewDetail.submission.previewUrl, 'compact-v1')}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onError={(event) => retryOriginalMarketImage(event.currentTarget, reviewDetail.submission.previewUrl!)}
                    />
                  )}
                </div>
                <dl className="appearance-market__facts">
                  <div><dt><OverflowText>{t('package.market.review.package')}</OverflowText></dt><dd><OverflowText>{reviewDetail.submission.packageId}</OverflowText></dd></div>
                  <div><dt><OverflowText>{t('package.market.review.version')}</OverflowText></dt><dd><OverflowText>{reviewDetail.submission.packageVersion}</OverflowText></dd></div>
                  <div><dt><OverflowText>{t('package.market.minimumVersion')}</OverflowText></dt><dd><OverflowText>{reviewDetail.submission.minOpenBitFunVersion}</OverflowText></dd></div>
                  <div><dt><OverflowText>{t('package.market.license')}</OverflowText></dt><dd><OverflowText>{reviewDetail.submission.license.spdxExpression || t('package.market.customLicense')}</OverflowText></dd></div>
                </dl>
                {reviewDetail.submission.requiredCapabilities.length > 0 && (
                  <div className="appearance-market__capabilities">
                    <strong>{t('package.market.capabilities')}</strong>
                    <div>{reviewDetail.submission.requiredCapabilities.map(capability => <code key={capability}>{capability}</code>)}</div>
                  </div>
                )}
                <section className="appearance-market__changelog">
                  <h4>{t('package.market.changelog')}</h4>
                  <p>{reviewDetail.submission.changelog || t('package.market.noChangelog')}</p>
                </section>
                <dl className="appearance-market__review-hashes">
                  <div><dt>{t('package.market.review.packageHash')}</dt><dd>{reviewDetail.packageSha256 || t('package.market.review.unavailable')}</dd></div>
                  <div><dt>{t('package.market.review.previewHash')}</dt><dd>{reviewDetail.previewSha256 || t('package.market.review.unavailable')}</dd></div>
                  <div><dt>{t('package.market.review.bundleHash')}</dt><dd>{reviewDetail.reviewBundleHash || t('package.market.review.unavailable')}</dd></div>
                </dl>
                {reviewDetail.manifest !== undefined && (
                  <Disclosure
                    presentation="native"
                    className="appearance-market__review-manifest"
                    summary={t('package.market.review.manifest')}
                  >
                    <ScrollArea className="appearance-market__review-manifest-pre">
                      <pre>{JSON.stringify(reviewDetail.manifest, null, 2)}</pre>
                    </ScrollArea>
                  </Disclosure>
                )}
                <div
                  className="appearance-market__review-actions"
                  data-openbitfun-component="appearance-settings"
                  data-openbitfun-part="marketReviewActions"
                >
                  <Textarea
                    label={t('package.market.review.reason')}
                    placeholder={t('package.market.review.reasonPlaceholder')}
                    value={reason}
                    onChange={event => setReason(event.target.value)}
                    rows={3}
                    maxLength={1000}
                  />
                  <div>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={actingId === reviewDetail.submission.submissionId}
                      onClick={() => void decide('approve')}
                    >
                      {t('package.market.review.approve')}
                    </Button>
                    <Button
                      variant="fill"
                      tone="danger"
                      size="sm"
                      disabled={!reason.trim()}
                      loading={actingId === reviewDetail.submission.submissionId}
                      onClick={() => void decide('reject')}
                    >
                      {t('package.market.review.reject')}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </ScrollArea>
        </div>
      )}
    </section>
  );
}
