import {
  Alert,
  Button,
  CardHeader,
  ChangeCount,
  Combobox,
  Disclosure,
  Empty,
  Field,
  FieldGroup,
  FieldRow,
  FormSection,
  Icon,
  IconButton,
  Input as DesignInput,
  LoadingState,
  MenuPopover,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelFooter,
  NavigationPanelHeader,
  NavigationPanelItem,
  OverflowText,
  ScrollArea,
  SearchField,
  SegmentedControl,
  Stack,
  StatusPill,
  TabGroup,
  Toolbar,
  ToolbarGroup,
  Tooltip,
  type ComboboxOption,
  type StatusPillTone,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { GitPullRequest, GitPullRequestClosed, KeyRound, MessageSquareText, MoreHorizontal } from 'lucide-react';
import { MarkdownRenderer } from '@/infrastructure/markdown';
import { reviewPlatformAPI, systemAPI, type ReviewPlatformAccount, type ReviewPlatformAuthChallenge, type ReviewPlatformCiItem, type ReviewPlatformCiLog, type ReviewPlatformCommit, type ReviewPlatformDetailSection, type ReviewPlatformFile, type ReviewPlatformPagination, type ReviewPlatformPullRequest, type ReviewPlatformPullRequestDetail, type ReviewPlatformPullRequestDetailPage, type ReviewPlatformRemote, type ReviewPlatformRepositoryRef, type ReviewPlatformThread, type ReviewPlatformWorkspaceSnapshot } from '@/infrastructure/api';
import { createLogger } from '@/shared/utils/logger';
import { notificationService } from '@/shared/notification-system';
import { i18nService, useI18n } from '@/infrastructure/i18n';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { openBtwSessionInAuxPane } from '@/flow_chat/services/btwSessionPane';
import {
  launchPreparedReviewSession,
  prepareReviewLaunchFromPullRequest,
} from '@/flow_chat/services/ReviewService';
import { useDeepReviewConsent } from '@/flow_chat/components/DeepReviewConsentDialog';
import { deriveDeepReviewSessionConcurrencyGuard } from '@/flow_chat/utils/deepReviewCapacityGuard';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { FlowToolItem, Session } from '@/flow_chat/types/flow-chat';
import { findLatestCodeReviewResultState, summarizeCodeReviewResult } from '@/flow_chat/utils/reviewSessionSummary';
import { parsePullRequestUrl, remoteMatchesPullRequestLink } from '@/shared/utils/pullRequestLinks';
import { useContextStore } from '@/shared/stores/contextStore';
import { quickActions } from '@/shared/services/ide-control';
import {
  describeGitTrustFailure,
  withGitRepositoryTrustRecovery,
} from '@/shared/services/gitTrustService';
import type { PullRequestContext } from '@/shared/types/context';
import {
  currentPullRequestReviewStatusText,
  effectivePullRequestReviewFreshness,
  mergeChangedFileCount,
  mergeLineStats,
  mergePullRequestDetailLimitations,
  mergeRevalidatedPullRequestOverview,
  pullRequestReviewFreshness,
  pullRequestReviewLaunchKey,
  resolvedChangedFileCount,
  resolvedLineStats,
  resolvedPullRequestStatistics,
  samePullRequestRevisions,
  samePullRequestIdentity,
  type PullRequestReviewFreshness,
} from './reviewLinking';
import './ReviewPlatformPanel.scss';

const log = createLogger('ReviewPlatformPanel');

interface ReviewPlatformPanelProps {
  workspacePath?: string;
  workspaceId: string;
  initialRemoteId?: string;
  initialPullRequestId?: string;
  initialPullRequestUrl?: string;
  detailOnly?: boolean;
}

type DetailTab = 'overview' | 'changes' | 'commits';
type ListStateFilter = 'all' | 'open' | 'draft' | 'merged' | 'closed';

const PR_PAGE_SIZE = 10;
const CI_PAGE_SIZE = 20;
const CHANGE_PAGE_SIZE = 15;
const COMMIT_PAGE_SIZE = 30;
const REVIEW_PAGE_SIZE = 20;
const REMOTE_STORAGE_PREFIX = 'openbitfun:review-platform:last-remote:';
const MAX_LINKED_REVIEW_SESSIONS = 6;

interface SnapshotCacheEntry {
  snapshot: ReviewPlatformWorkspaceSnapshot;
  fetchedAt: number;
}

interface DetailCacheEntry {
  detail: ReviewPlatformPullRequestDetail;
  fetchedAt: number;
}

interface DetailPageCacheEntry {
  detail: ReviewPlatformPullRequestDetailPage;
  fetchedAt: number;
}

interface PageInfo {
  pageIndex: number;
  totalPages: number;
  start: number;
  end: number;
  totalLabel: string;
  hasNext: boolean;
}

interface ReviewSessionMarkerInput {
  childSessionId?: string;
  parentSessionId?: string;
  kind?: 'review' | 'deep_review';
  title?: string;
  requestedFiles?: string[];
}

interface ReviewSessionMarker {
  childSessionId: string;
  parentSessionId?: string;
  kind: 'review' | 'deep_review';
  title?: string;
  requestedFiles: string[];
}

interface LinkedReviewSession {
  childSession: Session;
  parentSession?: Session;
  marker?: ReviewSessionMarker;
  kind: 'review' | 'deep_review';
  title: string;
  requestedFiles: string[];
  resultState: 'loaded' | 'unloaded' | 'missing' | 'invalid';
  issueCount: number;
  riskLevel?: string;
  lifecycle: 'running' | 'completed' | 'error' | 'idle';
  freshness: PullRequestReviewFreshness;
  evidenceStatus: 'complete' | 'limited' | 'stale' | 'failed';
  updatedAt: number;
}

const snapshotCache = new Map<string, SnapshotCacheEntry>();
const detailCache = new Map<string, DetailCacheEntry>();
const detailPageCache = new Map<string, DetailPageCacheEntry>();
const reviewLaunchesInFlight = new Set<string>();
const EMPTY_REVIEW_THREADS: ReviewPlatformThread[] = [];

function reviewPlatformErrorMessage(error: unknown, fallback: string): string {
  return describeGitTrustFailure(error)
    ?? (error instanceof Error ? error.message : fallback);
}

function detailPageInfo(pagination: ReviewPlatformPagination, itemCount: number): PageInfo {
  const pageIndex = Math.max(0, (pagination.page || 1) - 1);
  const perPage = Math.max(1, pagination.perPage || itemCount || 1);
  const total = pagination.total ?? null;
  const totalPages = total !== null
    ? Math.max(1, Math.ceil(total / perPage))
    : pageIndex + (pagination.hasNext ? 2 : 1);
  const start = itemCount === 0 ? 0 : pageIndex * perPage + 1;
  const end = total !== null
    ? Math.min(total, pageIndex * perPage + itemCount)
    : pageIndex * perPage + itemCount;
  return {
    pageIndex,
    totalPages,
    start,
    end,
    totalLabel: total !== null ? String(total) : `${end}+`,
    hasNext: pagination.hasNext,
  };
}

// Caches are keyed by the owning workspace ID, never by path: two workspaces
// (for example a local checkout and a remote one) may share a root path.
function snapshotCacheKey(workspaceId: string, remoteId: string | null, page: number, perPage: number, mode: 'list' | 'context', state: ListStateFilter): string {
  return `${workspaceId}::${remoteId ?? 'default'}::${page}::${perPage}::${mode}::${state}`;
}

function detailCacheKey(workspaceId: string, remoteId: string, pullRequestId: string): string {
  return `${workspaceId}::${remoteId}::${pullRequestId}`;
}

function detailPageCacheKey(workspaceId: string, remoteId: string, pullRequestId: string, section: ReviewPlatformDetailSection, page: number, perPage: number): string {
  return `${workspaceId}::${remoteId}::${pullRequestId}::${section}::${page}::${perPage}`;
}

function clearDetailPageCacheForPullRequest(workspaceId: string, remoteId: string, pullRequestId: string): void {
  const prefix = `${workspaceId}::${remoteId}::${pullRequestId}::`;
  for (const key of detailPageCache.keys()) {
    if (key.startsWith(prefix)) {
      detailPageCache.delete(key);
    }
  }
}

function emptyPagination(page: number, perPage: number): ReviewPlatformPagination {
  return { page, perPage, total: null, hasNext: false };
}

function mergeDetailPage(
  current: ReviewPlatformPullRequestDetail | null,
  page: ReviewPlatformPullRequestDetailPage,
): ReviewPlatformPullRequestDetail {
  const base = current ?? page;
  return {
    ...base,
    ...page,
    limitations: mergePullRequestDetailLimitations(base.limitations, page.limitations, page.section),
    ...mergeLineStats(base, page),
    ...mergeChangedFileCount(base, page),
    ci: page.section === 'ci' ? page.ci : base.ci,
    files: page.section === 'files' ? page.files : base.files,
    commits: page.section === 'commits' ? page.commits : base.commits,
    threads: page.section === 'reviews' ? page.threads : base.threads,
    // Section caches may predate the freshly revalidated overview. Never let
    // them replace the revisions used to judge whether a Review is current.
    baseRevision: current ? base.baseRevision : page.baseRevision,
    headRevision: current ? base.headRevision : page.headRevision,
  };
}

function remotePreferenceKey(workspaceId: string): string {
  return `${REMOTE_STORAGE_PREFIX}id:${workspaceId}`;
}

/** Pre-ID installs stored the preference under the workspace path. */
function legacyRemotePreferenceKey(workspacePath: string): string {
  return `${REMOTE_STORAGE_PREFIX}${workspacePath}`;
}

function readRememberedRemote(workspaceId: string, workspacePath?: string): string | null {
  if (!workspaceId || typeof window === 'undefined') return null;
  try {
    const remembered = window.localStorage.getItem(remotePreferenceKey(workspaceId));
    if (remembered !== null) return remembered;
    if (!workspacePath) return null;
    // Migrate the legacy path-keyed preference onto the workspace ID.
    const legacy = window.localStorage.getItem(legacyRemotePreferenceKey(workspacePath));
    if (legacy !== null) {
      window.localStorage.setItem(remotePreferenceKey(workspaceId), legacy);
      window.localStorage.removeItem(legacyRemotePreferenceKey(workspacePath));
    }
    return legacy;
  } catch {
    return null;
  }
}

function rememberRemote(workspaceId: string, remoteId: string | null): void {
  if (!workspaceId || typeof window === 'undefined') return;
  try {
    const key = remotePreferenceKey(workspaceId);
    if (remoteId) {
      window.localStorage.setItem(key, remoteId);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage failures; the selector still works for the current session.
  }
}

function formatRelativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const diffMs = Date.now() - time;
  const minutes = Math.max(1, Math.floor(diffMs / 60000));
  if (minutes < 60) return i18nService.t('common:reviewPlatform.relativeTime.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18nService.t('common:reviewPlatform.relativeTime.hoursAgo', { count: hours });
  return i18nService.t('common:reviewPlatform.relativeTime.daysAgo', { count: Math.floor(hours / 24) });
}

function formatAbsoluteTime(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return i18nService.formatDate(date, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function getPrIcon(pr: ReviewPlatformPullRequest) {
  return <Icon glyph={pr.state === 'closed' ? GitPullRequestClosed : GitPullRequest} size="sm" tone={pr.state === 'closed' ? 'danger' : pr.state === 'merged' ? 'info' : pr.state === 'draft' ? 'muted' : 'success'} />;
}

function decisionLabel(decision: ReviewPlatformPullRequest['reviewDecision']): string {
  switch (decision) {
    case 'approved':
      return 'Approved';
    case 'changes_requested':
      return 'Changes requested';
    case 'commented':
      return 'Commented';
    default:
      return 'Pending review';
  }
}

function stateLabel(state: ReviewPlatformPullRequest['state']): string {
  switch (state) {
    case 'open':
      return 'Open';
    case 'draft':
      return 'Draft';
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    default:
      return state;
  }
}

const pullRequestStateTones: Record<ReviewPlatformPullRequest['state'], StatusPillTone> = {
  open: 'success',
  draft: 'neutral',
  merged: 'accent',
  closed: 'danger',
};

function providerLabel(remote: ReviewPlatformRemote | ReviewPlatformAccount | null): string {
  if (!remote) return 'No provider';
  switch (remote.platform) {
    case 'github':
      return 'GitHub';
    case 'gitlab':
      return 'GitLab';
    case 'gitcode':
      return 'GitCode';
    case 'gitee':
      return 'Gitee';
    default:
      return 'Git';
  }
}

function remoteLabel(remote: ReviewPlatformRemote): string {
  return `${providerLabel(remote)} · ${remote.name} · ${remote.projectPath}`;
}

function authLabel(account: ReviewPlatformAccount | null): string {
  if (!account) return 'Disconnected';
  switch (account.authState) {
    case 'connected':
      return 'Connected';
    case 'not_required':
      return 'Public';
    case 'unsupported':
      return 'Unsupported';
    case 'expired':
      return 'Expired';
    case 'error':
      return 'Auth error';
    default:
      return 'Not connected';
  }
}

function authSourceLabel(source: ReviewPlatformAccount['authSource'] | undefined): string {
  switch (source) {
    case 'gh_cli':
      return 'GitHub CLI';
    case 'stored':
      return 'Saved token';
    case 'env':
      return 'Environment token';
    case 'unsupported':
      return 'Unsupported';
    default:
      return 'No token';
  }
}

function authChallengeTitle(challenge: ReviewPlatformAuthChallenge): string {
  if (challenge.platform === 'github') return 'GitHub CLI authentication required';
  switch (challenge.state) {
    case 'missing':
      return 'Token required';
    case 'insufficient_scope':
      return 'Token permissions required';
    default:
      return 'Token update required';
  }
}

function authChallengeScopes(challenge: ReviewPlatformAuthChallenge): string {
  return challenge.requiredScopes.length ? challenge.requiredScopes.join(', ') : 'Provider API access';
}

function emptySnapshot(): ReviewPlatformWorkspaceSnapshot {
  return {
    remotes: [],
    selectedRemoteId: null,
    accounts: [],
    repository: null,
    pullRequests: [],
    pagination: {
      page: 1,
      perPage: PR_PAGE_SIZE,
      total: 0,
      hasNext: false,
    },
    capabilities: {
      canCreateReview: false,
      canCreatePullRequest: false,
      canReplyToThread: false,
      canResolveThread: false,
      canApprove: false,
      canRevokeApproval: false,
      canRequestChanges: false,
      canMerge: false,
      supportsDraftReview: false,
    },
    message: null,
    authChallenge: null,
  };
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'review-platform__diff-line review-platform__diff-line--meta';
  if (line.startsWith('@@')) return 'review-platform__diff-line review-platform__diff-line--hunk';
  if (line.startsWith('+')) return 'review-platform__diff-line review-platform__diff-line--add';
  if (line.startsWith('-')) return 'review-platform__diff-line review-platform__diff-line--delete';
  return 'review-platform__diff-line';
}

function fileKey(file: { path: string; oldPath?: string | null }): string {
  return `${file.oldPath ?? ''}->${file.path}`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').trim();
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
  }
  return next;
}

function isReviewSessionRunning(session: Session): boolean {
  const turn = session.dialogTurns[session.dialogTurns.length - 1];
  return turn?.status === 'pending' ||
    turn?.status === 'image_analyzing' ||
    turn?.status === 'processing' ||
    turn?.status === 'finishing';
}

function reviewSessionLifecycle(session: Session): LinkedReviewSession['lifecycle'] {
  const turn = session.dialogTurns[session.dialogTurns.length - 1];
  if (session.error || session.hasUnreadCompletion === 'error' || session.hasUnreadCompletion === 'interrupted' || turn?.status === 'error') return 'error';
  if (isReviewSessionRunning(session)) return 'running';
  if (
    turn?.status === 'completed' ||
    session.hasUnreadCompletion === 'completed' ||
    (session.historyState === 'metadata-only' && session.persistedStatus === 'completed')
  ) return 'completed';
  return 'idle';
}

function getSessionTitle(session?: Session, fallback = 'Review session'): string {
  return session?.title?.trim() || fallback;
}

function extractReviewSessionMarkers(session: Session): ReviewSessionMarker[] {
  const markers: ReviewSessionMarker[] = [];
  for (const turn of session.dialogTurns) {
    for (const round of turn.modelRounds) {
      for (const item of round.items) {
        if (item.type !== 'tool') continue;
        const toolItem = item as FlowToolItem;
        if (toolItem.toolName !== 'ReviewSessionSummary') continue;
        const input = (toolItem.toolCall?.input ?? {}) as ReviewSessionMarkerInput;
        if (!input.childSessionId) continue;
        markers.push({
          childSessionId: input.childSessionId,
          parentSessionId: input.parentSessionId ?? session.sessionId,
          kind: input.kind === 'deep_review' ? 'deep_review' : 'review',
          title: input.title,
          requestedFiles: uniquePaths(input.requestedFiles ?? []),
        });
      }
    }
  }
  return markers;
}

function buildPrChatPrompt(params: {
  pr: ReviewPlatformPullRequest;
  remote: ReviewPlatformRemote | null;
  repository: ReviewPlatformRepositoryRef | null;
  filePaths: string[];
  webUrl?: string;
}): string {
  const fileList = params.filePaths.length
    ? params.filePaths.map(path => `- ${path}`).join('\n')
    : '- No file list is loaded yet';
  const provider = params.remote ? providerLabel(params.remote) : 'review platform';
  const repository = params.repository?.projectPath ?? params.remote?.projectPath ?? 'current repository';

  return [
    `Review PR #${params.pr.number}: ${params.pr.title}`,
    '',
    `Provider: ${provider}`,
    `Repository: ${repository}`,
    `Branch: ${params.pr.sourceBranch} -> ${params.pr.targetBranch}`,
    params.webUrl ? `URL: ${params.webUrl}` : null,
    '',
    'Changed files:',
    fileList,
    '',
    'Please use this PR context with the current conversation. Focus on risks, review findings, and concrete fixes.',
  ].filter(Boolean).join('\n');
}

function createContextId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatChecksText(pr: ReviewPlatformPullRequest): string {
  return pr.checks.total > 0
    ? `${pr.checks.passed}/${pr.checks.total} passed, ${pr.checks.failed} failed, ${pr.checks.pending} pending`
    : 'No checks reported';
}

function buildPrOverviewContext(params: {
  pr: ReviewPlatformPullRequest;
  detail: ReviewPlatformPullRequestDetail | null;
  remote: ReviewPlatformRemote | null;
  repository: ReviewPlatformRepositoryRef | null;
  filePaths: string[];
  reviewItemCount: number;
  webUrl?: string;
}): string {
  const body = params.detail?.body?.trim() || 'No pull request description was returned by the provider.';
  return [
    buildPrChatPrompt(params),
    '',
    'Overview:',
    body,
    '',
    `State: ${stateLabel(params.pr.state)}`,
    `Review decision: ${decisionLabel(params.pr.reviewDecision)}`,
    `Checks: ${formatChecksText(params.pr)}`,
    `Comments: ${params.reviewItemCount}`,
  ].join('\n');
}

function buildPrFileDiffContext(pr: ReviewPlatformPullRequest, file: ReviewPlatformFile): string {
  return [
    `Pull request file diff: PR #${pr.number} ${pr.title}`,
    `File: ${file.path}`,
    file.oldPath && file.oldPath !== file.path ? `Old path: ${file.oldPath}` : null,
    `Status: ${file.status}`,
    `Delta: +${file.additions} -${file.deletions}`,
    '',
    'Diff:',
    file.patch?.trim() || 'No inline diff is available for this file.',
  ].filter(Boolean).join('\n');
}

function buildPrCommitsContext(pr: ReviewPlatformPullRequest, commits: ReviewPlatformCommit[]): string {
  if (!commits.length) {
    return `Pull request commits: PR #${pr.number} ${pr.title}\n\nNo commits were returned by the provider.`;
  }
  return [
    `Pull request commits: PR #${pr.number} ${pr.title}`,
    '',
    ...commits.map(commit => [
      `- ${commit.shortHash} ${commit.title}`,
      `  Author: ${commit.author}`,
      `  Committed: ${formatAbsoluteTime(commit.committedAt) || commit.committedAt}`,
      `  Hash: ${commit.hash}`,
    ].join('\n')),
  ].join('\n');
}

function buildPrReviewsContext(pr: ReviewPlatformPullRequest, threads: ReviewPlatformThread[]): string {
  if (!threads.length) {
    return `Pull request reviews: PR #${pr.number} ${pr.title}\n\nNo review threads were returned by the provider.`;
  }
  const threadByCommentId = new Map(
    threads
      .filter(thread => thread.providerCommentId)
      .map(thread => [thread.providerCommentId as string, thread]),
  );
  return [
    `Pull request reviews: PR #${pr.number} ${pr.title}`,
    '',
    ...threads.map(thread => [
      `- [${thread.kind === 'review' ? 'Review' : 'Comment'}] ${thread.resolved ? 'Resolved' : 'Open'} thread by ${thread.author}`,
      thread.replyToProviderCommentId
        ? `  Reply to: ${threadByCommentId.get(thread.replyToProviderCommentId)?.author ?? thread.replyToProviderCommentId}`
        : null,
      thread.filePath ? `  Location: ${thread.filePath}${thread.line ? `:${thread.line}` : ''}` : null,
      `  Updated: ${formatAbsoluteTime(thread.updatedAt) || thread.updatedAt}`,
      `  Body: ${thread.body}`,
    ].filter(Boolean).join('\n')),
  ].join('\n');
}

function ciItemTone(item: ReviewPlatformCiItem): 'passed' | 'failed' | 'pending' {
  const raw = `${item.conclusion ?? item.status}`.trim().toLowerCase();
  if (['success', 'neutral', 'skipped', 'passed', 'pass'].includes(raw)) return 'passed';
  if (['failure', 'failed', 'error', 'timed_out', 'timed-out', 'cancelled', 'canceled', 'action_required'].includes(raw)) return 'failed';
  return 'pending';
}

function ciItemStatusText(item: ReviewPlatformCiItem): string {
  const status = item.status.trim();
  const conclusion = item.conclusion?.trim();
  if (!conclusion || conclusion.toLowerCase() === status.toLowerCase()) {
    return status || 'unknown';
  }
  return `${status || 'unknown'} · ${conclusion}`;
}

function buildPrCiContext(pr: ReviewPlatformPullRequest, ciItems: ReviewPlatformCiItem[]): string {
  if (!ciItems.length) {
    return `Pull request CI: PR #${pr.number} ${pr.title}\n\nNo CI entries were returned by the provider.`;
  }
  return [
    `Pull request CI page: PR #${pr.number} ${pr.title}`,
    '',
    `Checks: ${formatChecksText(pr)}`,
    '',
    ...ciItems.map(item => [
      `- ${item.name}`,
      `  Status: ${ciItemStatusText(item)}`,
      item.stage ? `  Stage: ${item.stage}` : null,
      item.detail ? `  Detail: ${item.detail}` : null,
      item.webUrl ? `  URL: ${item.webUrl}` : null,
      item.startedAt ? `  Started: ${formatAbsoluteTime(item.startedAt) || item.startedAt}` : null,
      item.finishedAt ? `  Finished: ${formatAbsoluteTime(item.finishedAt) || item.finishedAt}` : null,
    ].filter(Boolean).join('\n')),
  ].join('\n');
}

function buildPrCiItemContext(pr: ReviewPlatformPullRequest, item: ReviewPlatformCiItem, ciLog?: ReviewPlatformCiLog | null): string {
  const hasLog = Boolean(ciLog?.log);
  return [
    `Pull request CI result: PR #${pr.number} ${pr.title}`,
    '',
    `Checks: ${formatChecksText(pr)}`,
    '',
    `Name: ${item.name}`,
    `Status: ${ciItemStatusText(item)}`,
    item.conclusion ? `Conclusion: ${item.conclusion}` : null,
    item.stage ? `Stage: ${item.stage}` : null,
    item.detail ? `Detail: ${item.detail}` : null,
    item.webUrl ? `URL: ${item.webUrl}` : null,
    item.startedAt ? `Started: ${formatAbsoluteTime(item.startedAt) || item.startedAt}` : null,
    item.finishedAt ? `Finished: ${formatAbsoluteTime(item.finishedAt) || item.finishedAt}` : null,
    '',
    hasLog ? 'Error log excerpt:' : 'Provider detail:',
    hasLog
      ? `${ciLog?.truncated ? '[Truncated error excerpt]\n' : ''}${ciLog?.log ?? ''}`
      : ciLog?.message || item.detail || 'No additional provider detail has been loaded for this CI result.',
  ].filter(Boolean).join('\n');
}

function canLoadCiLog(remote: ReviewPlatformRemote | null, _item: ReviewPlatformCiItem): boolean {
  return Boolean(remote);
}

function canExpandCiItem(remote: ReviewPlatformRemote | null, item: ReviewPlatformCiItem): boolean {
  return canLoadCiLog(remote, item) || Boolean(item.log || item.detail || item.stage || item.webUrl || item.startedAt || item.finishedAt);
}

export const ReviewPlatformPanel: React.FC<ReviewPlatformPanelProps> = ({
  workspacePath,
  workspaceId,
  initialRemoteId,
  initialPullRequestId,
  initialPullRequestUrl,
  detailOnly = false,
}) => {
  const { t } = useI18n('panels/git');
  const authFormId = useId();
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const detailMenuRef = useRef<HTMLButtonElement>(null);
  const panelFocusRequested = useRef(false);
  const [panelView, setPanelView] = useState<'list' | 'detail'>('list');
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const snapshotRequestSeq = useRef(0);
  const detailRequestSeq = useRef(0);
  const detailSectionRequestSeq = useRef(0);
  const reviewLaunchInFlight = useRef(false);
  const [snapshot, setSnapshot] = useState<ReviewPlatformWorkspaceSnapshot>(emptySnapshot);
  const [selectedRemoteId, setSelectedRemoteId] = useState<string | null>(null);
  const [listRemoteId, setListRemoteId] = useState<string | null>(null);
  const [selectedPrId, setSelectedPrId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewPlatformPullRequestDetail | null>(null);
  const [verifiedDetailKey, setVerifiedDetailKey] = useState<string | null>(null);
  const [flowState, setFlowState] = useState(() => flowChatStore.getState());
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<ListStateFilter>('all');
  const serverStateFilter = useRef<ListStateFilter>('all');
  const [pageIndex, setPageIndex] = useState(0);
  const [ciPageIndex, setCiPageIndex] = useState(0);
  const [changePageIndex, setChangePageIndex] = useState(0);
  const [commitPageIndex, setCommitPageIndex] = useState(0);
  const [reviewPageIndex, setReviewPageIndex] = useState(0);
  const [ciPagination, setCiPagination] = useState<ReviewPlatformPagination>(() => emptyPagination(1, CI_PAGE_SIZE));
  const [changePagination, setChangePagination] = useState<ReviewPlatformPagination>(() => emptyPagination(1, CHANGE_PAGE_SIZE));
  const [commitPagination, setCommitPagination] = useState<ReviewPlatformPagination>(() => emptyPagination(1, COMMIT_PAGE_SIZE));
  const [reviewPagination, setReviewPagination] = useState<ReviewPlatformPagination>(() => emptyPagination(1, REVIEW_PAGE_SIZE));
  const [expandedFileKeys, setExpandedFileKeys] = useState<Set<string>>(() => new Set());
  const [expandedCiItemIds, setExpandedCiItemIds] = useState<Set<string>>(() => new Set());
  const [ciLogById, setCiLogById] = useState<Record<string, ReviewPlatformCiLog>>({});
  const [ciLogErrorById, setCiLogErrorById] = useState<Record<string, string>>({});
  const [ciLogLoadingIds, setCiLogLoadingIds] = useState<Set<string>>(() => new Set());
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authToken, setAuthToken] = useState('');
  const [authSaving, setAuthSaving] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [reviewLaunching, setReviewLaunching] = useState(false);
  const { confirmDeepReviewLaunch, deepReviewConsentDialog } = useDeepReviewConsent();

  const account = snapshot.accounts[0] ?? null;
  const selectedRemote = useMemo(
    () => snapshot.remotes.find(remote => remote.id === selectedRemoteId) ?? snapshot.remotes[0] ?? null,
    [selectedRemoteId, snapshot.remotes],
  );
  const repository = useMemo<ReviewPlatformRepositoryRef | null>(() => {
    if (!snapshot.repository || !selectedRemote) return snapshot.repository;
    return {
      ...snapshot.repository,
      providerId: selectedRemote.id,
      platform: selectedRemote.platform,
      host: selectedRemote.host,
      owner: selectedRemote.owner,
      name: selectedRemote.repositoryName,
      projectPath: selectedRemote.projectPath,
      webUrl: selectedRemote.webUrl,
    };
  }, [selectedRemote, snapshot.repository]);
  const authChallenge = snapshot.authChallenge ?? null;
  const selectedPrFromList = useMemo(
    () => snapshot.pullRequests.find(pr => (
      pr.id === selectedPrId && (!pr.providerId || pr.providerId === selectedRemoteId)
    )) ?? null,
    [selectedPrId, selectedRemoteId, snapshot.pullRequests],
  );
  const selectedPr = detail ?? selectedPrFromList;
  const hasDetail = detail !== null;
  const initialPullRequestTarget = useMemo(
    () => initialPullRequestUrl ? parsePullRequestUrl(initialPullRequestUrl) : null,
    [initialPullRequestUrl],
  );
  const prFilePaths = useMemo(
    () => uniquePaths((detail?.files ?? []).map(file => file.path)),
    [detail?.files],
  );
  const ciItems = useMemo(() => detail?.ci ?? [], [detail?.ci]);
  const changedFiles = useMemo(() => detail?.files ?? [], [detail?.files]);
  const commits = useMemo(() => detail?.commits ?? [], [detail?.commits]);
  const reviewThreads = useMemo(() => detail?.threads ?? EMPTY_REVIEW_THREADS, [detail?.threads]);
  const reviewThreadByCommentId = useMemo(
    () => new Map(
      reviewThreads
        .filter(thread => thread.providerCommentId)
        .map(thread => [thread.providerCommentId as string, thread]),
    ),
    [reviewThreads],
  );
  const reviewItemCount = reviewPagination.total
    ?? (reviewThreads.length > 0 ? reviewThreads.length : (selectedPr?.comments ?? 0));
  const ciTotal = ciPagination.total ?? ciItems.length;
  const ciPage = detailPageInfo(ciPagination, ciTotal);
  const changePage = detailPageInfo(changePagination, changedFiles.length);
  const commitPage = detailPageInfo(commitPagination, commits.length);
  const reviewPage = detailPageInfo(reviewPagination, reviewThreads.length);
  const pagedCiItems = ciItems;
  const pagedChangedFiles = changedFiles;
  const pagedCommits = commits;
  const pagedReviewThreads = reviewThreads;
  const remoteOptions = useMemo<ComboboxOption[]>(
    () => snapshot.remotes.map(remote => ({
      value: remote.id,
      label: remoteLabel(remote),
      description: `${remote.host} · ${authLabel(account && account.id === remote.id ? account : null)}`,
    })),
    [account, snapshot.remotes],
  );

  const loadSnapshot = useCallback(async (
    nextRemoteId?: string | null,
    options?: { force?: boolean; page?: number; state?: ListStateFilter; userInitiated?: boolean },
  ) => {
    const requestSeq = ++snapshotRequestSeq.current;
    detailRequestSeq.current += 1;
    detailSectionRequestSeq.current += 1;
    if (!workspacePath) {
      setSnapshot(emptySnapshot());
      setSelectedRemoteId(null);
      setListRemoteId(null);
      setSelectedPrId(null);
      setDetail(null);
      setVerifiedDetailKey(null);
      setDetailError(null);
      setError('No active workspace is available.');
      setLoading(false);
      return;
    }

    const requestedRemoteId = nextRemoteId !== undefined
      ? nextRemoteId
      : detailOnly
        ? readRememberedRemote(workspaceId, workspacePath)
        : null;
    const requestedPage = Math.max(1, options?.page ?? 1);
    const requestedState = detailOnly ? 'all' : options?.state ?? serverStateFilter.current;
    const snapshotMode = detailOnly ? 'context' : 'list';
    setListRemoteId(requestedRemoteId ?? null);
    const requestedCacheKey = snapshotCacheKey(workspaceId, requestedRemoteId ?? null, requestedPage, PR_PAGE_SIZE, snapshotMode, requestedState);
    const cached = snapshotCache.get(requestedCacheKey);
    const force = options?.force === true;

    if (cached && !force) {
      const remoteId = cached.snapshot.selectedRemoteId ?? cached.snapshot.remotes[0]?.id ?? null;
      setSnapshot(cached.snapshot);
      setSelectedRemoteId(remoteId);
      setPageIndex(Math.max(0, (cached.snapshot.pagination.page || requestedPage) - 1));
      setSelectedPrId(detailOnly ? null : cached.snapshot.pullRequests[0]?.id ?? null);
      setDetail(null);
      setVerifiedDetailKey(null);
      setDetailError(null);
      setError(null);
      setLoading(false);
      return;
    } else {
      setSnapshot(current => ({ ...current, pullRequests: [], pagination: emptyPagination(requestedPage, PR_PAGE_SIZE) }));
      setSelectedPrId(null);
      setDetail(null);
      setVerifiedDetailKey(null);
      setDetailError(null);
    }

    setLoading(true);
    setError(null);
    try {
      const repository = { workspaceId, repositoryPath: workspacePath };
      const fetchSnapshot = () => detailOnly
        ? reviewPlatformAPI.getWorkspaceContext(repository, requestedRemoteId ?? null)
        : reviewPlatformAPI.getWorkspaceSnapshot(
            repository,
            requestedRemoteId ?? null,
            requestedPage,
            PR_PAGE_SIZE,
            requestedState,
          );
      const next = options?.userInitiated
        ? await withGitRepositoryTrustRecovery(fetchSnapshot, { workspaceId, repositoryPath: workspacePath }, { userInitiated: true })
        : await fetchSnapshot();
      if (snapshotRequestSeq.current !== requestSeq) return;
      setSnapshot(next);
      const remoteId = next.selectedRemoteId ?? next.remotes[0]?.id ?? null;
      setSelectedRemoteId(remoteId);
      setPageIndex(Math.max(0, (next.pagination.page || requestedPage) - 1));
      rememberRemote(workspaceId, remoteId);
      setSelectedPrId(detailOnly ? null : next.pullRequests[0]?.id ?? null);
      setDetail(null);
      setVerifiedDetailKey(null);
      setDetailError(null);
      const entry = { snapshot: next, fetchedAt: Date.now() };
      snapshotCache.set(requestedCacheKey, entry);
      if (remoteId) {
        snapshotCache.set(snapshotCacheKey(workspaceId, remoteId, requestedPage, PR_PAGE_SIZE, snapshotMode, requestedState), entry);
      }
    } catch (err) {
      if (snapshotRequestSeq.current !== requestSeq) return;
      const message = reviewPlatformErrorMessage(err, 'Failed to load pull requests');
      setError(message);
      log.error('Failed to load review platform snapshot', { workspacePath, error: err });
    } finally {
      if (snapshotRequestSeq.current === requestSeq) {
        setLoading(false);
      }
    }
  }, [detailOnly, workspacePath, workspaceId]);

  const loadDetail = useCallback(async (repo: ReviewPlatformRepositoryRef | null, remoteId: string, pullRequestId: string, options?: { force?: boolean }) => {
    const requestSeq = ++detailRequestSeq.current;
    detailSectionRequestSeq.current += 1;
    const repositoryPath = workspacePath || repo?.workspacePath || '';
    const cacheKey = detailCacheKey(workspaceId, remoteId, pullRequestId);
    const cached = detailCache.get(cacheKey);
    const force = options?.force === true;

    setDetailError(null);
    setVerifiedDetailKey(null);
    if (force) {
      detailCache.delete(cacheKey);
      clearDetailPageCacheForPullRequest(workspaceId, remoteId, pullRequestId);
    }

    if (cached && !force) {
      setDetail(cached.detail);
    } else {
      setDetail(null);
    }

    setDetailLoading(true);
    try {
      const nextDetail = await reviewPlatformAPI.getPullRequestDetailPage({
        workspaceId,
        repositoryPath,
        remoteId,
        pullRequestId,
        section: 'overview',
        page: 1,
        perPage: 1,
      });
      if (detailRequestSeq.current !== requestSeq) return;
      if (cached && !samePullRequestRevisions(cached.detail, nextDetail)) {
        clearDetailPageCacheForPullRequest(workspaceId, remoteId, pullRequestId);
      }
      setDetail((current) => mergeRevalidatedPullRequestOverview(current, nextDetail));
      detailCache.set(cacheKey, { detail: nextDetail, fetchedAt: Date.now() });
      setVerifiedDetailKey(cacheKey);
    } catch (err) {
      if (detailRequestSeq.current !== requestSeq) return;
      log.error('Failed to load pull request detail', { pullRequestId, error: err });
      setDetailError(reviewPlatformErrorMessage(err, 'Failed to load pull request details.'));
      if (!cached) {
        setDetail(null);
      }
    } finally {
      if (detailRequestSeq.current === requestSeq) {
        setDetailLoading(false);
      }
    }
  }, [workspacePath, workspaceId]);

  const applySectionPagination = useCallback((section: Exclude<ReviewPlatformDetailSection, 'overview'>, pagination: ReviewPlatformPagination) => {
    if (section === 'ci') {
      setCiPagination(pagination);
    } else if (section === 'files') {
      setChangePagination(pagination);
    } else if (section === 'commits') {
      setCommitPagination(pagination);
    } else {
      setReviewPagination(pagination);
    }
  }, []);

  const loadDetailSection = useCallback(async (
    repo: ReviewPlatformRepositoryRef | null,
    remoteId: string,
    pullRequestId: string,
    section: Exclude<ReviewPlatformDetailSection, 'overview'>,
    pageIndex: number,
    perPage: number,
    options?: { force?: boolean },
  ) => {
    const repositoryPath = workspacePath || repo?.workspacePath || '';
    const page = Math.max(1, pageIndex + 1);
    const cacheKey = detailPageCacheKey(workspaceId, remoteId, pullRequestId, section, page, perPage);
    const overviewCacheKey = detailCacheKey(workspaceId, remoteId, pullRequestId);
    const cached = detailPageCache.get(cacheKey);
    const force = options?.force === true;
    const matchesVerifiedOverview = (pageDetail: ReviewPlatformPullRequestDetail) => {
      const overview = detailCache.get(overviewCacheKey)?.detail;
      return Boolean(overview && samePullRequestRevisions(overview, pageDetail));
    };

    if (cached && !force) {
      if (!matchesVerifiedOverview(cached.detail)) {
        clearDetailPageCacheForPullRequest(workspaceId, remoteId, pullRequestId);
        void loadDetail(repo, remoteId, pullRequestId, { force: true });
        return;
      }
      setDetail(prev => mergeDetailPage(prev, cached.detail));
      applySectionPagination(section, cached.detail.pagination);
      return;
    }

    const requestSeq = ++detailSectionRequestSeq.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const nextPage = await reviewPlatformAPI.getPullRequestDetailPage({
        workspaceId,
        repositoryPath,
        remoteId,
        pullRequestId,
        section,
        page,
        perPage,
      });
      if (detailSectionRequestSeq.current !== requestSeq) return;
      if (!matchesVerifiedOverview(nextPage)) {
        clearDetailPageCacheForPullRequest(workspaceId, remoteId, pullRequestId);
        void loadDetail(repo, remoteId, pullRequestId, { force: true });
        return;
      }
      detailPageCache.set(cacheKey, { detail: nextPage, fetchedAt: Date.now() });
      setDetail(prev => mergeDetailPage(prev, nextPage));
      applySectionPagination(section, nextPage.pagination);
    } catch (err) {
      if (detailSectionRequestSeq.current !== requestSeq) return;
      log.error('Failed to load pull request detail section', { pullRequestId, section, page, perPage, error: err });
      setDetailError(reviewPlatformErrorMessage(err, 'Failed to load pull request details.'));
    } finally {
      if (detailSectionRequestSeq.current === requestSeq) {
        setDetailLoading(false);
      }
    }
  }, [applySectionPagination, loadDetail, workspacePath, workspaceId]);

  useEffect(() => {
    serverStateFilter.current = 'all';
    setPanelView('list');
    setStateFilter('all');
    setSnapshot(emptySnapshot());
    void loadSnapshot(detailOnly && initialRemoteId ? initialRemoteId : undefined, { state: 'all' });
  }, [detailOnly, initialRemoteId, loadSnapshot]);

  useEffect(() => flowChatStore.subscribe(setFlowState), []);

  useEffect(() => {
    if (!panelFocusRequested.current) return;
    panelFocusRequested.current = false;
    // The back button is hidden in split view, where focus stays on the list.
    const target = panelView === 'detail' ? backButtonRef.current : selectedRowRef.current;
    target?.focus({ preventScroll: true });
  }, [panelView, selectedPrId]);

  useEffect(() => {
    if (!selectedRemoteId) {
      setDetail(null);
      setVerifiedDetailKey(null);
      setDetailError(null);
      return;
    }
    if (!selectedPrId || (!repository && !workspacePath)) {
      setDetail(null);
      setVerifiedDetailKey(null);
      setDetailError(null);
      return;
    }
    void loadDetail(repository, selectedRemoteId, selectedPrId);
  }, [loadDetail, repository, selectedPrId, selectedRemoteId, workspacePath]);

  useEffect(() => {
    if (!snapshot.remotes.length) return;
    if (!selectedRemoteId && snapshot.selectedRemoteId) {
      setSelectedRemoteId(snapshot.selectedRemoteId);
    }
  }, [selectedRemoteId, snapshot.remotes.length, snapshot.selectedRemoteId]);

  useEffect(() => {
    if (!detailOnly) return;
    const targetPullRequestId = initialPullRequestId ?? initialPullRequestTarget?.pullRequestId ?? null;
    if (!targetPullRequestId) {
      if (initialPullRequestUrl) {
        setDetailError('This link is not a supported pull request URL.');
      }
      return;
    }

    const matchedRemote = initialRemoteId
      ? snapshot.remotes.find(remote => remote.id === initialRemoteId) ?? null
      : initialPullRequestTarget
        ? snapshot.remotes.find(remote => remoteMatchesPullRequestLink(remote, initialPullRequestTarget)) ?? null
        : null;
    const nextRemoteId = initialRemoteId
      ?? matchedRemote?.id
      ?? (snapshot.remotes.length === 1 ? snapshot.remotes[0].id : null)
      ?? snapshot.selectedRemoteId
      ?? selectedRemoteId;

    if (nextRemoteId && selectedRemoteId !== nextRemoteId) {
      setSelectedRemoteId(nextRemoteId);
      rememberRemote(workspaceId, nextRemoteId);
    }

    if (selectedPrId !== targetPullRequestId) {
      setSelectedPrId(targetPullRequestId);
    }
  }, [
    detailOnly,
    initialPullRequestId,
    initialPullRequestTarget,
    initialPullRequestUrl,
    initialRemoteId,
    selectedPrId,
    selectedRemoteId,
    snapshot.remotes,
    snapshot.selectedRemoteId,
    workspacePath,
    workspaceId,
  ]);

  useEffect(() => {
    setActiveTab('overview');
    setDetailMenuOpen(false);
    setExpandedFileKeys(new Set());
    setExpandedCiItemIds(new Set());
    setCiLogById({});
    setCiLogErrorById({});
    setCiLogLoadingIds(new Set());
    setCiPageIndex(0);
    setChangePageIndex(0);
    setCommitPageIndex(0);
    setReviewPageIndex(0);
    setCiPagination(emptyPagination(1, CI_PAGE_SIZE));
    setChangePagination(emptyPagination(1, CHANGE_PAGE_SIZE));
    setCommitPagination(emptyPagination(1, COMMIT_PAGE_SIZE));
    setReviewPagination(emptyPagination(1, REVIEW_PAGE_SIZE));
  }, [selectedPrId]);

  useEffect(() => {
    if (activeTab !== 'changes' || changedFiles.length === 0 || expandedFileKeys.size > 0) return;
    setExpandedFileKeys(new Set(changedFiles.slice(0, 1).map(fileKey)));
  }, [activeTab, changedFiles, expandedFileKeys.size]);

  useEffect(() => {
    if (!hasDetail || !selectedRemoteId || !selectedPrId || (!repository && !workspacePath)) return;
    if (verifiedDetailKey !== detailCacheKey(workspaceId, selectedRemoteId, selectedPrId)) return;
    let disposed = false;
    if (activeTab === 'overview') {
      void (async () => {
        await loadDetailSection(repository, selectedRemoteId, selectedPrId, 'ci', ciPageIndex, CI_PAGE_SIZE);
        if (!disposed) {
          await loadDetailSection(repository, selectedRemoteId, selectedPrId, 'reviews', reviewPageIndex, REVIEW_PAGE_SIZE);
        }
      })();
    } else if (activeTab === 'changes') {
      void loadDetailSection(repository, selectedRemoteId, selectedPrId, 'files', changePageIndex, CHANGE_PAGE_SIZE);
    } else if (activeTab === 'commits') {
      void loadDetailSection(repository, selectedRemoteId, selectedPrId, 'commits', commitPageIndex, COMMIT_PAGE_SIZE);
    }
    return () => {
      disposed = true;
      detailSectionRequestSeq.current += 1;
    };
  }, [
    activeTab,
    ciPageIndex,
    changePageIndex,
    commitPageIndex,
    detail?.baseRevision,
    detail?.headRevision,
    hasDetail,
    loadDetailSection,
    repository,
    reviewPageIndex,
    selectedPrId,
    selectedRemoteId,
    verifiedDetailKey,
    workspacePath,
    workspaceId,
  ]);

  const visiblePullRequests = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.pullRequests.filter(pr => {
      if (stateFilter !== 'all' && pr.state !== stateFilter) return false;
      if (!needle) return true;
      return [
        pr.title,
        pr.author,
        pr.sourceBranch,
        pr.targetBranch,
        `#${pr.number}`,
      ].some(value => value.toLowerCase().includes(needle));
    });
  }, [query, snapshot.pullRequests, stateFilter]);

  const parentSession = useMemo(() => {
    const sessions = Array.from(flowState.sessions.values());
    const activeSession = flowState.activeSessionId
      ? flowState.sessions.get(flowState.activeSessionId)
      : undefined;
    const sameWorkspace = (session?: Session) =>
      Boolean(session && session.workspaceId === workspaceId);

    if (activeSession?.sessionKind === 'normal' && sameWorkspace(activeSession)) {
      return activeSession;
    }

    if (
      activeSession &&
      (activeSession.sessionKind === 'review' || activeSession.sessionKind === 'deep_review') &&
      activeSession.parentSessionId
    ) {
      const parent = flowState.sessions.get(activeSession.parentSessionId);
      if (parent?.sessionKind === 'normal' && sameWorkspace(parent)) {
        return parent;
      }
    }

    return sessions
      .filter(session => session.sessionKind === 'normal' && sameWorkspace(session))
      .sort((left, right) => (right.lastActiveAt || right.updatedAt || right.createdAt) - (left.lastActiveAt || left.updatedAt || left.createdAt))[0];
  }, [flowState.activeSessionId, flowState.sessions, workspaceId]);

  const currentPullRequest = detail ?? selectedPr;
  const selectedDetailKey = selectedRemoteId && selectedPrId
    ? detailCacheKey(workspaceId, selectedRemoteId, selectedPrId)
    : null;
  const currentRevisionsVerified = Boolean(
    selectedDetailKey && verifiedDetailKey === selectedDetailKey,
  );

  const linkedReviewSessions = useMemo<LinkedReviewSession[]>(() => {
    if (!selectedRemote || !repository || !selectedPr || !currentPullRequest) {
      return [];
    }
    const sessions = Array.from(flowState.sessions.values());
    const markersByChildId = new Map<string, ReviewSessionMarker>();
    for (const session of sessions) {
      for (const marker of extractReviewSessionMarkers(session)) {
        markersByChildId.set(marker.childSessionId, marker);
      }
    }

    return sessions
      .filter(session =>
        session.sessionKind === 'review' || session.sessionKind === 'deep_review',
      )
      .map((session): LinkedReviewSession | null => {
        const marker = markersByChildId.get(session.sessionId);
        const evidence = session.reviewTargetEvidence
          ?? session.deepReviewRunManifest?.evidencePack?.reviewTarget;
        const identity = evidence?.pullRequest;
        if (
          !samePullRequestIdentity(identity, {
            platform: selectedRemote.platform,
            host: selectedRemote.host,
            projectPath: repository.projectPath,
            pullRequestId: selectedPr.id,
          })
        ) {
          return null;
        }
        const requestedFiles = marker?.requestedFiles ?? session.reviewTargetFilePaths ?? [];

        const reviewResultState = findLatestCodeReviewResultState(session);
        const reviewResult = reviewResultState.status === 'valid' ? reviewResultState.result : null;
        const summary = summarizeCodeReviewResult(reviewResult);
        const kind = session.sessionKind === 'deep_review' ? 'deep_review' : 'review';
        const runtimeEvidenceStatus = reviewResult?.evidence_status;
        const evidenceStatus = runtimeEvidenceStatus
          ?? (evidence?.completeness === 'complete' ? 'complete' : 'limited');
        const resultState = reviewResultState.status === 'valid'
          ? 'loaded'
          : session.historyState === 'metadata-only' || session.historyState === 'hydrating'
            ? 'unloaded'
            : reviewResultState.status;
        return {
          childSession: session,
          parentSession: marker?.parentSessionId ? flowState.sessions.get(marker.parentSessionId) : undefined,
          marker,
          kind,
          title: marker?.title || getSessionTitle(session, kind === 'deep_review' ? 'Review: Strict' : 'Review'),
          requestedFiles,
          resultState,
          issueCount: summary.issueCount,
          riskLevel: summary.riskLevel,
          lifecycle: reviewSessionLifecycle(session),
          freshness: effectivePullRequestReviewFreshness(
            evidence,
            currentPullRequest,
            currentRevisionsVerified,
            evidenceStatus,
          ),
          evidenceStatus,
          updatedAt: session.lastActiveAt || session.updatedAt || session.createdAt,
        };
      })
      .filter((session): session is LinkedReviewSession => Boolean(session))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_LINKED_REVIEW_SESSIONS);
  }, [currentPullRequest, currentRevisionsVerified, flowState.sessions, repository, selectedPr, selectedRemote]);

  const latestCurrentReview = linkedReviewSessions.find((session) => session.freshness === 'current');
  const latestStaleReview = linkedReviewSessions.find((session) => session.freshness === 'stale');
  const latestUnknownReview = linkedReviewSessions.find((session) => session.freshness === 'unknown');

  const pagination = snapshot.pagination;
  const totalCount = pagination.total ?? null;
  const currentPageIndex = Math.max(0, (pagination.page || pageIndex + 1) - 1);
  const totalPages = totalCount !== null
    ? Math.max(1, Math.ceil(totalCount / pagination.perPage))
    : currentPageIndex + (pagination.hasNext ? 2 : 1);
  const pageStart = snapshot.pullRequests.length ? currentPageIndex * pagination.perPage + 1 : 0;
  const pageEnd = totalCount !== null
    ? Math.min(totalCount, currentPageIndex * pagination.perPage + snapshot.pullRequests.length)
    : currentPageIndex * pagination.perPage + snapshot.pullRequests.length;

  const isGithubUserList = !detailOnly && selectedRemote?.platform === 'github';

  const handleRemoteChange = useCallback((value: string | number | (string | number)[]) => {
    const remoteId = Array.isArray(value) ? String(value[0] ?? '') : String(value);
    setPanelView('list');
    setSelectedRemoteId(remoteId || null);
    setSelectedPrId(null);
    setDetail(null);
    setDetailError(null);
    setStateFilter('all');
    serverStateFilter.current = 'all';
    setPageIndex(0);
    rememberRemote(workspaceId, remoteId || null);
    setSnapshot(emptySnapshot());
    void loadSnapshot(remoteId || null, { page: 1, state: 'all' });
  }, [loadSnapshot, workspaceId]);

  const handleStateChange = useCallback((state: ListStateFilter) => {
    setPanelView('list');
    setStateFilter(state);
    if (snapshot.capabilities.supportedPullRequestStates?.includes(state)) {
      serverStateFilter.current = state;
      setPageIndex(0);
      void loadSnapshot(listRemoteId, { page: 1, state });
    }
  }, [listRemoteId, loadSnapshot, snapshot.capabilities.supportedPullRequestStates]);

  const handlePageChange = useCallback((nextPageIndex: number) => {
    setPanelView('list');
    const nextPage = Math.max(1, nextPageIndex + 1);
    setSelectedPrId(null);
    setDetail(null);
    setDetailError(null);
    setPageIndex(nextPage - 1);
    void loadSnapshot(listRemoteId, { page: nextPage });
  }, [listRemoteId, loadSnapshot]);

  const toggleFileExpanded = useCallback((key: string) => {
    setExpandedFileKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const renderDetailPagination = useCallback((
    label: string,
    page: PageInfo,
    itemCount: number,
    onPageChange: (nextPageIndex: number) => void,
  ) => {
    if (itemCount <= 0 || (page.totalPages <= 1 && !page.hasNext && page.pageIndex === 0)) return null;
    return (
      <Toolbar
        data-openbitfun-product-component="review-platform"
        data-openbitfun-product-part="pagination"
        bordered={false}
        leading={<OverflowText>{label}: {page.start}-{page.end} of {page.totalLabel}</OverflowText>}
        trailing={<ToolbarGroup>
          <IconButton
            aria-label={`Previous ${label} page`}
            size="sm"
            disabled={page.pageIndex === 0}
            onClick={() => onPageChange(page.pageIndex - 1)}
            icon={<Icon name="chevron-left" size="sm" />}
          />
          <IconButton
            aria-label={`Next ${label} page`}
            size="sm"
            disabled={!page.hasNext && page.pageIndex >= page.totalPages - 1}
            onClick={() => onPageChange(page.pageIndex + 1)}
            icon={<Icon name="chevron-right" size="sm" />}
          />
        </ToolbarGroup>}
      />
    );
  }, []);

  const renderDetailLoading = useCallback((message: string) => (
    <LoadingState size="sm" role="status" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="loadingState">
      {message}
    </LoadingState>
  ), []);

  const handleOpenExternal = useCallback(async () => {
    const webUrl = selectedPr?.webUrl || initialPullRequestUrl;
    if (!webUrl) return;
    try {
      await systemAPI.openExternal(webUrl);
    } catch (error) {
      log.error('Failed to open pull request URL', { error, webUrl });
    }
  }, [initialPullRequestUrl, selectedPr?.webUrl]);

  const handleOpenCiUrl = useCallback(async (webUrl?: string | null) => {
    if (!webUrl) return;
    try {
      await systemAPI.openExternal(webUrl);
    } catch (error) {
      log.error('Failed to open CI URL', { error, webUrl });
    }
  }, []);

  const loadCiLog = useCallback(async (item: ReviewPlatformCiItem): Promise<ReviewPlatformCiLog | null> => {
    const cached = ciLogById[item.id];
    if (cached) return cached;
    if (!canLoadCiLog(selectedRemote, item)) {
      return {
        ciItemId: item.id,
        log: item.log ?? null,
        truncated: item.logTruncated,
        message: item.detail || null,
      };
    }
    if ((!repository && !workspacePath) || !selectedRemoteId || !selectedPrId) return null;

    const repositoryPath = workspacePath || repository?.workspacePath || '';
    setCiLogLoadingIds(prev => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    setCiLogErrorById(prev => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });

    try {
      const nextLog = await reviewPlatformAPI.getPullRequestCiLog({
        workspaceId,
        repositoryPath,
        remoteId: selectedRemoteId,
        pullRequestId: selectedPrId,
        ciItemId: item.id,
        ciItemName: item.name,
      });
      setCiLogById(prev => ({ ...prev, [item.id]: nextLog }));
      return nextLog;
    } catch (err) {
      const message = reviewPlatformErrorMessage(err, 'Failed to load CI error log.');
      setCiLogErrorById(prev => ({ ...prev, [item.id]: message }));
      log.error('Failed to load CI log', { itemId: item.id, error: err });
      return null;
    } finally {
      setCiLogLoadingIds(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }, [ciLogById, repository, selectedPrId, selectedRemote, selectedRemoteId, workspacePath, workspaceId]);

  const toggleCiExpanded = useCallback((item: ReviewPlatformCiItem) => {
    if (expandedCiItemIds.has(item.id)) {
      setExpandedCiItemIds(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      return;
    }

    setExpandedCiItemIds(prev => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    if (canLoadCiLog(selectedRemote, item) || item.log) {
      void loadCiLog(item);
    }
  }, [expandedCiItemIds, loadCiLog, selectedRemote]);

  const addPullRequestContextToChat = useCallback(async (input: {
    label: string;
    section: PullRequestContext['section'];
    content: string;
    metadata?: Record<string, unknown>;
  }) => {
    if (!parentSession) {
      notificationService.warning('Open or create a chat session before sending PR context.', { duration: 3500 });
      return;
    }

    await openMainSession(parentSession.sessionId);
    const context: PullRequestContext = {
      id: createContextId('pr'),
      type: 'pull-request',
      label: input.label,
      section: input.section,
      content: input.content,
      metadata: input.metadata,
      timestamp: Date.now(),
      sourceUrl: selectedPr?.webUrl || initialPullRequestUrl,
      remoteId: selectedRemote?.id,
      repository: repository?.projectPath ?? selectedRemote?.projectPath,
      pullRequestNumber: selectedPr?.number,
      pullRequestTitle: selectedPr?.title,
    };

    useContextStore.getState().addContext(context);
    window.dispatchEvent(new CustomEvent('insert-context-tag', { detail: { context } }));
  }, [initialPullRequestUrl, parentSession, repository?.projectPath, selectedPr, selectedRemote?.id, selectedRemote?.projectPath]);

  const handleFillPrContext = useCallback(async () => {
    if (!selectedPr) return;
    await addPullRequestContextToChat({
      label: `PR #${selectedPr.number} overview`,
      section: 'overview',
      content: buildPrOverviewContext({
        pr: selectedPr,
        detail,
        remote: selectedRemote,
        repository,
        filePaths: prFilePaths,
        reviewItemCount,
        webUrl: selectedPr.webUrl,
      }),
    });
  }, [addPullRequestContextToChat, detail, prFilePaths, repository, reviewItemCount, selectedPr, selectedRemote]);

  const handleStartReview = useCallback(async () => {
    if (!workspacePath || !selectedRemote || !repository || !selectedPr || !parentSession) {
      notificationService.warning('Open or create a chat session before reviewing this pull request.', {
        duration: 3500,
      });
      return;
    }
    if (reviewLaunchInFlight.current || latestCurrentReview?.lifecycle === 'running') {
      return;
    }
    reviewLaunchInFlight.current = true;
    setReviewLaunching(true);
    let sharedLaunchKey: string | null = null;
    let ownsSharedLaunch = false;
    try {
      const reviewTarget = await reviewPlatformAPI.getPullRequestReviewTarget(
        { workspaceId, repositoryPath: workspacePath },
        selectedRemote.id,
        selectedPr.id,
      );
      const freshPullRequest = reviewTarget.pullRequest;
      const freshIdentity = {
        platform: selectedRemote.platform,
        host: selectedRemote.host,
        projectPath: repository.projectPath,
        pullRequestId: freshPullRequest.id,
      };
      const runningReviewExists = () => Array.from(flowChatStore.getState().sessions.values()).some((session) => {
        if (
          (session.sessionKind !== 'review' && session.sessionKind !== 'deep_review')
          || reviewSessionLifecycle(session) !== 'running'
        ) {
          return false;
        }
        const evidence = session.reviewTargetEvidence
          ?? session.deepReviewRunManifest?.evidencePack?.reviewTarget;
        return samePullRequestIdentity(evidence?.pullRequest, freshIdentity)
          && pullRequestReviewFreshness(evidence, freshPullRequest) === 'current';
      });
      sharedLaunchKey = pullRequestReviewLaunchKey({
        ...freshIdentity,
        baseRevision: freshPullRequest.baseRevision,
        headRevision: freshPullRequest.headRevision,
      });
      const cacheKey = detailCacheKey(workspaceId, selectedRemote.id, selectedPr.id);
      setDetail((current) => current ? { ...current, ...reviewTarget.pullRequest } : current);
      setSnapshot((current) => ({
        ...current,
        pullRequests: current.pullRequests.map((pullRequest) =>
          pullRequest.id === freshPullRequest.id
            ? { ...pullRequest, ...freshPullRequest }
            : pullRequest,
        ),
      }));
      const cached = detailCache.get(cacheKey);
      if (cached) {
        detailCache.set(cacheKey, {
          detail: { ...cached.detail, ...freshPullRequest },
          fetchedAt: Date.now(),
        });
      }
      setVerifiedDetailKey(cacheKey);
      if (runningReviewExists()) {
        return;
      }
      const prepared = await prepareReviewLaunchFromPullRequest({
        workspacePath,
        workspaceId,
        remote: selectedRemote,
        repository,
        reviewTarget,
      });
      if (prepared.mode === 'strict' && prepared.requiresConsent) {
        const confirmed = await confirmDeepReviewLaunch(prepared.runManifest, {
          sessionConcurrencyGuard: deriveDeepReviewSessionConcurrencyGuard(
            flowChatStore.getState(),
            parentSession.sessionId,
          ),
        });
        if (!confirmed) return;
      }
      if (runningReviewExists() || reviewLaunchesInFlight.has(sharedLaunchKey)) {
        return;
      }
      reviewLaunchesInFlight.add(sharedLaunchKey);
      ownsSharedLaunch = true;
      const launched = await launchPreparedReviewSession({
        parentSessionId: parentSession.sessionId,
        workspacePath,
        displayMessage: `Review pull request #${reviewTarget.pullRequest.number}`,
        childSessionName: `Review: PR #${reviewTarget.pullRequest.number}`,
        prepared,
      });
      if (launched.launchStatus === 'uncertain') {
        notificationService.warning('Review started, but its start acknowledgement is uncertain.', {
          duration: 8000,
        });
      }
    } catch (reviewError) {
      log.error('Failed to start pull request Review', {
        pullRequestId: selectedPr.id,
        error: reviewError,
      });
      notificationService.error(
        reviewError instanceof Error ? reviewError.message : 'Failed to start pull request Review.',
        { duration: 6000 },
      );
    } finally {
      if (sharedLaunchKey && ownsSharedLaunch) {
        reviewLaunchesInFlight.delete(sharedLaunchKey);
      }
      reviewLaunchInFlight.current = false;
      setReviewLaunching(false);
    }
  }, [
    confirmDeepReviewLaunch,
    latestCurrentReview?.lifecycle,
    parentSession,
    repository,
    selectedPr,
    selectedRemote,
    workspacePath,
    workspaceId,
  ]);

  const handleAddFileDiffContext = useCallback(async (file: ReviewPlatformFile) => {
    if (!selectedPr) return;
    await addPullRequestContextToChat({
      label: `PR #${selectedPr.number} ${file.path}`,
      section: 'file-diff',
      content: buildPrFileDiffContext(selectedPr, file),
    });
  }, [addPullRequestContextToChat, selectedPr]);

  const handleAddCommitsContext = useCallback(async () => {
    if (!selectedPr) return;
    await addPullRequestContextToChat({
      label: `PR #${selectedPr.number} commits`,
      section: 'commits',
      content: buildPrCommitsContext(selectedPr, detail?.commits ?? []),
    });
  }, [addPullRequestContextToChat, detail?.commits, selectedPr]);

  const handleAddReviewsContext = useCallback(async () => {
    if (!selectedPr) return;
    await addPullRequestContextToChat({
      label: `PR #${selectedPr.number} reviews`,
      section: 'reviews',
      content: buildPrReviewsContext(selectedPr, detail?.threads ?? []),
    });
  }, [addPullRequestContextToChat, detail?.threads, selectedPr]);

  const handleAddCiPageContext = useCallback(async () => {
    if (!selectedPr) return;
    await addPullRequestContextToChat({
      label: `PR #${selectedPr.number} CI page`,
      section: 'ci',
      content: buildPrCiContext(selectedPr, detail?.ci ?? []),
    });
  }, [addPullRequestContextToChat, detail?.ci, selectedPr]);

  const handleAddCiItemContext = useCallback(async (item: ReviewPlatformCiItem) => {
    if (!selectedPr) return;
    const ciLog = ciLogById[item.id] ?? await loadCiLog(item);
    await addPullRequestContextToChat({
      label: `PR #${selectedPr.number} CI · ${item.name}`,
      section: 'ci',
      content: buildPrCiItemContext(selectedPr, item, ciLog),
      metadata: {
        ciItemId: item.id,
        ciItemName: item.name,
        ciItemStatus: item.status,
        ciItemConclusion: item.conclusion,
        ciItemStage: item.stage,
        ciLogTruncated: ciLog?.truncated ?? false,
      },
    });
  }, [addPullRequestContextToChat, ciLogById, loadCiLog, selectedPr]);

  const refreshAuthSnapshot = useCallback((remoteId: string | null) => {
    snapshotCache.clear();
    detailCache.clear();
    detailPageCache.clear();
    void loadSnapshot(detailOnly ? remoteId : listRemoteId, { force: true, page: currentPageIndex + 1 });
  }, [currentPageIndex, detailOnly, listRemoteId, loadSnapshot]);

  const handleOpenAuthModal = useCallback(() => {
    setAuthToken('');
    setAuthError(null);
    setAuthModalOpen(true);
  }, []);

  const handleSaveAuthToken = useCallback(async () => {
    if (!selectedRemote || selectedRemote.platform === 'unknown' || selectedRemote.platform === 'github') return;
    const token = authToken.trim();
    if (!token) {
      setAuthError('Token is required.');
      return;
    }

    setAuthSaving(true);
    setAuthError(null);
    try {
      await reviewPlatformAPI.updateAuthToken({
        platform: selectedRemote.platform,
        host: selectedRemote.host,
        token,
      });
      setAuthModalOpen(false);
      setAuthToken('');
      refreshAuthSnapshot(selectedRemote.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save token.';
      setAuthError(message);
      log.error('Failed to save review platform token', { error: err, host: selectedRemote.host });
    } finally {
      setAuthSaving(false);
    }
  }, [authToken, refreshAuthSnapshot, selectedRemote]);

  const handleOpenGithubAuthTerminal = useCallback(async () => {
    if (!selectedRemote || selectedRemote.platform !== 'github') return;
    const command = `gh auth login --hostname ${selectedRemote.host}`;
    setAuthSaving(true);
    setAuthError(null);
    try {
      await systemAPI.setClipboard(command);
      setAuthModalOpen(false);
      quickActions.openTerminal(undefined, workspacePath);
      notificationService.success('GitHub CLI login command copied. Paste it in the terminal to continue.', {
        duration: 3500,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to open GitHub CLI authentication.';
      setAuthError(message);
      log.error('Failed to prepare GitHub CLI authentication', { error: err, host: selectedRemote.host });
    } finally {
      setAuthSaving(false);
    }
  }, [selectedRemote, workspacePath]);

  const handleCopyGithubAuthCommand = useCallback(async () => {
    if (!selectedRemote || selectedRemote.platform !== 'github') return;
    setAuthError(null);
    try {
      await systemAPI.setClipboard(`gh auth login --hostname ${selectedRemote.host}`);
      notificationService.success('GitHub CLI login command copied.', { duration: 2500 });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to copy GitHub CLI login command.';
      setAuthError(message);
      log.error('Failed to copy GitHub CLI authentication command', { error: err, host: selectedRemote.host });
    }
  }, [selectedRemote]);

  const handleClearAuthToken = useCallback(async () => {
    if (!selectedRemote || selectedRemote.platform === 'unknown') return;
    setAuthSaving(true);
    setAuthError(null);
    try {
      await reviewPlatformAPI.clearAuthToken({
        platform: selectedRemote.platform,
        host: selectedRemote.host,
      });
      refreshAuthSnapshot(selectedRemote.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to clear token.';
      setAuthError(message);
      setAuthModalOpen(true);
      log.error('Failed to clear review platform token', { error: err, host: selectedRemote.host });
    } finally {
      setAuthSaving(false);
    }
  }, [refreshAuthSnapshot, selectedRemote]);

  const renderAuthGate = useCallback((mode: 'inline' | 'detail' = 'inline') => {
    if (!authChallenge || !selectedRemote || selectedRemote.platform === 'unknown') return null;
    return (
      <Alert
        data-openbitfun-product-component="review-platform"
        data-openbitfun-product-part="authGate"
        className={`review-platform__auth-gate review-platform__auth-gate--${mode}`}
        tone="warning"
        role="status"
        title={authChallengeTitle(authChallenge)}
        message={authChallenge.message}
        description={<Stack gap="3">
          <span data-openbitfun-product-component="review-platform" data-openbitfun-product-part="authCopy">
            {authChallenge.host} · {authChallenge.projectPath}<br />
            {selectedRemote.platform === 'github' ? 'CLI authorization' : 'Required scopes'}: {authChallengeScopes(authChallenge)}
          </span>
          <ToolbarGroup className="review-platform__wrap" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="authActions">
            <Button size="sm" variant="primary" onClick={handleOpenAuthModal} disabled={authSaving} leadingIcon={<KeyRound size={13} />}>

              {selectedRemote.platform === 'github' ? 'Authenticate' : authChallenge.state === 'missing' ? 'Add token' : 'Update token'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => refreshAuthSnapshot(selectedRemote.id)} disabled={authSaving || loading} leadingIcon={<Icon name="refresh" size="sm" />}>

              Retry
            </Button>
          </ToolbarGroup>
        </Stack>}
      />
    );
  }, [authChallenge, authSaving, handleOpenAuthModal, loading, refreshAuthSnapshot, selectedRemote]);

  const handleRetryDetail = useCallback(() => {
    if ((!repository && !workspacePath) || !selectedRemoteId || !selectedPrId) return;
    if (activeTab === 'overview') {
      void (async () => {
        await loadDetail(repository, selectedRemoteId, selectedPrId, { force: true });
        await loadDetailSection(repository, selectedRemoteId, selectedPrId, 'ci', ciPageIndex, CI_PAGE_SIZE, { force: true });
        await loadDetailSection(repository, selectedRemoteId, selectedPrId, 'reviews', reviewPageIndex, REVIEW_PAGE_SIZE, { force: true });
      })();
      return;
    }
    if (activeTab === 'changes') {
      void loadDetailSection(repository, selectedRemoteId, selectedPrId, 'files', changePageIndex, CHANGE_PAGE_SIZE, { force: true });
      return;
    }
    if (activeTab === 'commits') {
      void loadDetailSection(repository, selectedRemoteId, selectedPrId, 'commits', commitPageIndex, COMMIT_PAGE_SIZE, { force: true });
      return;
    }
    void loadDetail(repository, selectedRemoteId, selectedPrId, { force: true });
  }, [
    activeTab,
    changePageIndex,
    commitPageIndex,
    loadDetail,
    loadDetailSection,
    ciPageIndex,
    repository,
    reviewPageIndex,
    selectedPrId,
    selectedRemoteId,
    workspacePath,
  ]);

  const handleRefreshDetail = useCallback(async () => {
    if ((!repository && !workspacePath) || !selectedRemoteId || !selectedPrId) return;
    await loadDetail(repository, selectedRemoteId, selectedPrId, { force: true });
    if (activeTab === 'overview') {
      await loadDetailSection(repository, selectedRemoteId, selectedPrId, 'ci', ciPageIndex, CI_PAGE_SIZE, { force: true });
      await loadDetailSection(repository, selectedRemoteId, selectedPrId, 'reviews', reviewPageIndex, REVIEW_PAGE_SIZE, { force: true });
    } else if (activeTab === 'changes') {
      await loadDetailSection(repository, selectedRemoteId, selectedPrId, 'files', changePageIndex, CHANGE_PAGE_SIZE, { force: true });
    } else if (activeTab === 'commits') {
      await loadDetailSection(repository, selectedRemoteId, selectedPrId, 'commits', commitPageIndex, COMMIT_PAGE_SIZE, { force: true });
    }
  }, [activeTab, changePageIndex, ciPageIndex, commitPageIndex, loadDetail, loadDetailSection, repository, reviewPageIndex, selectedPrId, selectedRemoteId, workspacePath]);

  const displayPr = currentRevisionsVerified ? currentPullRequest : selectedPrFromList ?? currentPullRequest;
  const displayStatistics = selectedPrFromList && (!detail || samePullRequestRevisions(selectedPrFromList, detail))
    ? resolvedPullRequestStatistics(selectedPrFromList, detail)
    : displayPr;
  const displayLineStats = resolvedLineStats(displayStatistics);
  const emptyStateMessage = snapshot.message
    || (account && account.authState !== 'connected' && account.authState !== 'not_required' ? account.message : null)
    || (selectedRemote && selectedRemote.authState !== 'connected' && selectedRemote.authState !== 'not_required' ? selectedRemote.message : null)
    || (snapshot.remotes.length
      ? isGithubUserList && !query.trim()
        ? 'No open pull requests authored by the current GitHub CLI account.'
        : 'No pull requests match the current filter.'
      : 'No supported remotes were detected.');
  const checksStatusText = !displayPr || displayPr.checks.total === 0
    ? 'No checks'
    : displayPr.checks.failed > 0
      ? `${displayPr.checks.failed} failed`
      : displayPr.checks.pending > 0
        ? `${displayPr.checks.pending} pending`
        : 'All checks passed';
  const reviewStatusText = latestCurrentReview
    ? currentPullRequestReviewStatusText(latestCurrentReview)
    : latestStaleReview
      ? 'Previous Review is stale because the PR revisions or runtime evidence changed'
      : latestUnknownReview
        ? 'Review result cannot be matched to current PR revisions · refresh PR'
        : 'No Review has run for the current PR revisions';
  const handleOpenLatestReview = () => {
    const linked = latestCurrentReview ?? latestStaleReview ?? latestUnknownReview;
    const linkedParentSessionId = linked?.childSession.parentSessionId ?? linked?.parentSession?.sessionId;
    if (!linked || !linkedParentSessionId) return;
    openBtwSessionInAuxPane({
      childSessionId: linked.childSession.sessionId,
      parentSessionId: linkedParentSessionId,
      workspacePath: linked.childSession.workspacePath,
      expand: true,
      sessionKind: linked.kind,
      sessionTitle: linked.title,
      agentType: linked.childSession.config.agentType ?? (linked.kind === 'deep_review' ? 'DeepReview' : 'CodeReview'),
    });
  };

  return (
    <div data-openbitfun-product-component="review-platform" data-openbitfun-product-part="root" data-openbitfun-layout={detailOnly ? 'detail' : 'full'} data-openbitfun-view={detailOnly ? 'detail' : selectedPr ? panelView : 'list'} className={`review-platform${detailOnly ? ' review-platform--detail-only' : ''}`}>
      {!detailOnly && (
        <Toolbar className="review-platform__toolbar" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="chrome"
          leading={<Combobox
            className="review-platform__remote-select"
            aria-label="Repository"
            size="sm"
            value={selectedRemoteId ?? ''}
            options={remoteOptions}
            placeholder="Select repository"
            disabled={!remoteOptions.length || loading}
            onValueChange={handleRemoteChange}
          />}
          trailing={<ToolbarGroup data-openbitfun-product-component="review-platform" data-openbitfun-product-part="actions">
            <Tooltip content={selectedRemote?.platform === 'github' ? 'GitHub CLI authentication' : account?.authSource === 'stored' ? 'Update token' : 'Add token'}>
              <IconButton
                aria-label={selectedRemote?.platform === 'github' ? 'GitHub CLI authentication' : account?.authSource === 'stored' ? 'Update token' : 'Add token'}
                size="sm"
                disabled={!selectedRemote || selectedRemote.platform === 'unknown' || loading || authSaving}
                onClick={handleOpenAuthModal}
                icon={<KeyRound size={14} />}
              />
            </Tooltip>
            <Tooltip content="Refresh">
              <IconButton
                aria-label="Refresh"
                data-testid="review-platform-refresh"
                size="sm"
                onClick={() => void loadSnapshot(listRemoteId, { force: true, page: currentPageIndex + 1, userInitiated: true })}
                loading={loading}
                icon={<Icon name="refresh" size="sm" />}
              />
            </Tooltip>
          </ToolbarGroup>}
        />
      )}

      <div className={`review-platform__body${!detailOnly && !selectedPr ? ' review-platform__body--list-only' : ''}`} data-openbitfun-product-component="review-platform" data-openbitfun-product-part="body">
        {!detailOnly && (
          <NavigationPanel className="review-platform__list" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="listPane" aria-label="Pull request list">
            <NavigationPanelHeader data-openbitfun-product-component="review-platform" data-openbitfun-product-part="listToolbar">
              <Stack gap="2">
                {authChallenge && renderAuthGate('inline')}
                <SearchField
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder={isGithubUserList ? 'Search my open pull requests' : 'Search pull requests'}
                  aria-label="Search pull requests"
                  leadingIcon={<Icon name="search" size="sm" />}
                  clearLabel={query ? 'Clear search' : undefined}
                  onClear={() => setQuery('')}
                  size="sm"
                />
                {!isGithubUserList && (
                  <SegmentedControl
                    aria-label="Pull request state"
                    data-openbitfun-product-component="review-platform"
                    data-openbitfun-product-part="filters"
                    value={stateFilter}
                    variant="pills"
                    tone="neutral"
                    onValueChange={value => handleStateChange(value as ListStateFilter)}
                    options={(['all', 'open', 'draft', 'merged', 'closed'] as ListStateFilter[]).map(state => ({
                      value: state,
                      label: state === 'all' ? 'All' : stateLabel(state),
                      disabled: selectedRemote?.platform === 'gitee' && state !== 'all' && !snapshot.capabilities.supportedPullRequestStates?.includes(state),
                    }))}
                  />
                )}
                {selectedRemote?.platform === 'gitee' && !snapshot.capabilities.supportedPullRequestStates?.length && (
                  <Alert tone="warning" role="status" message={t('reviewPlatform.stateFilterUnsupported')} />
                )}
              </Stack>
            </NavigationPanelHeader>

            <NavigationPanelBody data-openbitfun-product-component="review-platform" data-openbitfun-product-part="listScroll">
              <NavigationPanelContent>
                {loading && (
                  <LoadingState size="sm" role="status" data-testid="review-platform-list-loading" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="loadingState">Loading pull requests...</LoadingState>
                )}
                {error && (
                  <Alert tone="error" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="errorState"
                    message={error.includes('review_platform_state_filter_unsupported') ? t('reviewPlatform.stateFilterUnsupported') : error}
                    description={
                      <Button size="sm" variant="outline" onClick={() => void loadSnapshot(listRemoteId, { force: true, page: currentPageIndex + 1, userInitiated: true })}>
                        Retry
                      </Button>
                    }
                  />
                )}
                {!loading && !error && !authChallenge && !visiblePullRequests.length && (
                  <Empty icon={<GitPullRequest />} description={emptyStateMessage} data-openbitfun-product-component="review-platform" data-openbitfun-product-part="emptyState" />
                )}
                {!loading && !error && visiblePullRequests.map(pr => {
                  const pullRequestRemote = pr.providerId
                    ? snapshot.remotes.find(remote => remote.id === pr.providerId)
                    : selectedRemote;
                  const selected = selectedPrId === pr.id && (!pr.providerId || pr.providerId === selectedRemoteId);
                  return (
                    <NavigationPanelItem data-openbitfun-product-component="review-platform" data-openbitfun-product-part="listItem"
                      data-testid="review-platform-pr-row"
                      data-pr-number={pr.number}
                      data-pr-state={pr.state}
                      data-openbitfun-state={selected ? 'selected' : ''}
                      key={`${pr.providerId ?? selectedRemoteId ?? 'remote'}:${pr.id}`}
                      selected={selected}
                      ref={selected ? selectedRowRef : undefined}
                      labelBehavior="static"
                      leading={getPrIcon(pr)}
                      onClick={() => {
                        if (pr.providerId && pr.providerId !== selectedRemoteId) {
                          setSelectedRemoteId(pr.providerId);
                          rememberRemote(workspaceId, pr.providerId);
                        }
                        panelFocusRequested.current = true;
                        setPanelView('detail');
                        setSelectedPrId(pr.id);
                      }}
                    >
                      <span className="review-platform__list-copy" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="listItemMain">
                        <OverflowText data-openbitfun-product-component="review-platform" data-openbitfun-product-part="listItemTitle">{pr.title}</OverflowText>
                        <OverflowText className="review-platform__meta" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="listItemMeta">
                          {[isGithubUserList && pullRequestRemote?.projectPath, `#${pr.number}`, pr.author, formatRelativeTime(pr.updatedAt)].filter(Boolean).join(' · ')}
                        </OverflowText>
                      </span>
                    </NavigationPanelItem>
                  );
                })}
              </NavigationPanelContent>
            </NavigationPanelBody>
            {!loading && !error && (totalPages > 1 || pagination.hasNext) && (
              <NavigationPanelFooter data-testid="review-platform-pagination" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="pagination">
                <Tooltip content="Previous page">
                  <IconButton
                    aria-label="Previous page"
                    data-testid="review-platform-previous-page"
                    size="sm"
                    disabled={currentPageIndex === 0}
                    onClick={() => handlePageChange(currentPageIndex - 1)}
                    icon={<Icon name="chevron-left" size="sm" />}
                  />
                </Tooltip>
                <span>
                  {pageStart}-{pageEnd} of {totalCount ?? `${pageEnd}+`}
                </span>
                <Tooltip content="Next page">
                  <IconButton
                    aria-label="Next page"
                    data-testid="review-platform-next-page"
                    size="sm"
                    disabled={!pagination.hasNext && currentPageIndex >= totalPages - 1}
                    onClick={() => handlePageChange(currentPageIndex + 1)}
                    icon={<Icon name="chevron-right" size="sm" />}
                  />
                </Tooltip>
              </NavigationPanelFooter>
            )}
          </NavigationPanel>
        )}

        {(detailOnly || selectedPr) && <main className="review-platform__detail" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="detailPane">
          {(!detailOnly || selectedPr) && (
            <Toolbar
              className="review-platform__detail-toolbar"
              data-openbitfun-product-component="review-platform"
              data-openbitfun-product-part="detailActions"
              leading={!detailOnly ? (
                <Button
                  className="review-platform__back"
                  ref={backButtonRef}
                  data-testid="review-platform-back"
                  size="sm"
                  variant="text"
                  leadingIcon={<Icon name="chevron-left" size="sm" />}
                  onClick={() => {
                    panelFocusRequested.current = true;
                    setPanelView('list');
                  }}
                >Pull requests</Button>
              ) : <OverflowText className="review-platform__meta">{selectedRemote?.projectPath}</OverflowText>}
              trailing={selectedPr && <ToolbarGroup>
                <Tooltip content={!parentSession ? 'Open or create a chat first' : 'Start Review'}>
                  <span>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={handleStartReview}
                      disabled={!parentSession || !repository || !selectedRemote || reviewLaunching || detailLoading || latestCurrentReview?.lifecycle === 'running'}
                      loading={reviewLaunching}
                      leadingIcon={<Icon name="spark" size="xs" />}
                    >{latestCurrentReview?.lifecycle === 'running' ? 'Review running' : 'Review'}</Button>
                  </span>
                </Tooltip>
                <Tooltip content="Pull request actions">
                  <IconButton
                    ref={detailMenuRef}
                    aria-label="Pull request actions"
                    aria-haspopup="menu"
                    aria-expanded={detailMenuOpen}
                    size="sm"
                    icon={<MoreHorizontal size={16} />}
                    onClick={() => setDetailMenuOpen(open => !open)}
                  />
                </Tooltip>
              </ToolbarGroup>}
            />
          )}
          {!selectedPr && detailOnly && (loading || detailLoading) && (
            <LoadingState className="review-platform__detail-empty" role="status">Loading pull request details...</LoadingState>
          )}

          {!selectedPr && detailOnly && !loading && !detailLoading && authChallenge && (
            <div className="review-platform__detail-empty">
              {renderAuthGate('detail')}
            </div>
          )}

          {!selectedPr && detailOnly && !loading && !detailLoading && !authChallenge && (detailError || error) && (
            <Empty
              className="review-platform__detail-empty"
              icon={<Icon name="info" tone="danger" />}
              description={detailError || error}
              actions={<>
                <Button size="sm" variant="outline" onClick={handleRetryDetail}>
                  Retry
                </Button>
                {selectedRemote && selectedRemote.platform !== 'unknown' && (
                  <Button size="sm" variant="outline" onClick={handleOpenAuthModal} disabled={authSaving} leadingIcon={<KeyRound size={13} />}>

                    {selectedRemote.platform === 'github' ? 'Authenticate' : account?.authSource === 'stored' ? 'Update token' : 'Add token'}
                  </Button>
                )}
              </>}
            />
          )}

          {!selectedPr && detailOnly && !loading && !detailLoading && !authChallenge && !detailError && !error && (
            <Empty
              className="review-platform__detail-empty"
              icon={<GitPullRequest />}
              description={snapshot.message || 'This pull request could not be resolved from the remotes of the current workspace.'}
              actions={<>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void loadSnapshot(undefined, { force: true, userInitiated: true })}
                >
                  Retry
                </Button>
                {initialPullRequestUrl && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleOpenExternal}
                    leadingIcon={<Icon name="arrow-up-right" size="xs" />}
                  >

                    Open in browser
                  </Button>
                )}
              </>}
            />
          )}

          {selectedPr && (
            <>
              <FormSection
                className="review-platform__detail-header"
                data-openbitfun-product-component="review-platform"
                data-openbitfun-product-part="detailHeader"
                headingAs="h3"
                title={<span data-openbitfun-product-component="review-platform" data-openbitfun-product-part="detailTitle">{selectedPr.title}</span>}
                description={
                  <Stack direction="horizontal" gap="2" align="center" wrap className="review-platform__detail-meta" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="detailMeta">
                    <StatusPill data-testid="review-platform-detail-state" tone={pullRequestStateTones[displayPr?.state ?? selectedPr.state]} data-openbitfun-product-component="review-platform" data-openbitfun-product-part="detailState">
                      {stateLabel(displayPr?.state ?? selectedPr.state)}
                    </StatusPill>
                    <span>#{selectedPr.number}</span>
                    <span>{displayPr?.author ?? selectedPr.author}</span>
                    <span>{formatAbsoluteTime(selectedPr.updatedAt) || formatRelativeTime(selectedPr.updatedAt)}</span>
                    {(displayPr?.reviewDecision === 'approved' || displayPr?.reviewDecision === 'changes_requested') && (
                      <StatusPill tone={displayPr.reviewDecision === 'approved' ? 'success' : 'danger'}>{decisionLabel(displayPr.reviewDecision)}</StatusPill>
                    )}
                  </Stack>
                }
              >
                <Stack gap="2" className="review-platform__meta" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="facts">
                  <OverflowText>{displayPr?.sourceBranch ?? selectedPr.sourceBranch} → {displayPr?.targetBranch ?? selectedPr.targetBranch}</OverflowText>
                  <Stack direction="horizontal" gap="2" align="center" wrap>
                    <span data-testid="review-platform-detail-files">{resolvedChangedFileCount(displayStatistics) ?? '—'} files</span>
                    {displayLineStats ? <ChangeCount data-testid="review-platform-detail-line-stats" additions={displayLineStats.additions} deletions={displayLineStats.deletions} /> : <span data-testid="review-platform-detail-line-stats">—</span>}
                  </Stack>
                </Stack>
              </FormSection>

              <div className="review-platform__tabs" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="tabs">
                {(detail?.limitations?.length ?? 0) > 0 && (
                  <Alert tone="warning" role="status" message={detail!.limitations!.map(limitation => {
                    switch (limitation) {
                      case 'gitee_file_list_limit': return t('reviewPlatform.fileLimit');
                      case 'gitee_commit_list_limit': return t('reviewPlatform.commitLimit');
                      case 'provider_comment_list_incomplete': return t('reviewPlatform.commentsLimited');
                      case 'provider_ci_list_incomplete': return t('reviewPlatform.checksLimited');
                      case 'provider_ci_head_unavailable': return t('reviewPlatform.ciHeadUnavailable');
                      default: return t('reviewPlatform.limited');
                    }
                  }).join(' ')} />
                )}
                <Toolbar className="review-platform__tab-bar" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="tabBar" leading={
                  <TabGroup
                    aria-label="Pull request details"
                    items={[
                      { value: 'overview', label: 'Overview' },
                      { value: 'changes', label: 'Changes' },
                      { value: 'commits', label: 'Commits' },
                    ]}
                    value={activeTab}
                    onValueChange={(value) => setActiveTab(value as DetailTab)}
                  />
                } />
                {activeTab === 'overview' && (
                  <ScrollArea className="review-platform__tab-content" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="tabContent">
                    {detailLoading && renderDetailLoading(detail ? 'Refreshing pull request...' : 'Loading pull request...')}
                    {detailError && <Alert tone="error" message={detailError} description={<Button size="sm" variant="outline" onClick={handleRetryDetail}>Retry</Button>} />}
                    {detail && (
                      <div className="review-platform__body-markdown" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="section">
                        {detail.body ? <MarkdownRenderer content={detail.body} basePath={workspacePath} /> : <p className="review-platform__meta">No description provided.</p>}
                      </div>
                    )}
                    {(latestCurrentReview || latestStaleReview || latestUnknownReview) && (
                      <CardHeader title="OpenBitFun Review" description={reviewStatusText} actions={
                        <Button size="sm" variant="text" onClick={handleOpenLatestReview}>Open Review</Button>
                      } />
                    )}
                    <Disclosure
                      key={'checks:' + selectedRemoteId + ':' + selectedPrId}
                      summary="Checks"
                      description={checksStatusText}
                      disabled={!detailLoading && ciItems.length === 0}
                      data-openbitfun-product-component="review-platform"
                      data-openbitfun-product-part="section"
                    >
                      <FieldGroup appearance="plain">
                        {pagedCiItems.map(item => {
                          const tone = ciItemTone(item);
                          const isCiExpanded = expandedCiItemIds.has(item.id);
                          const ciLog = ciLogById[item.id];
                          const ciLogLoading = ciLogLoadingIds.has(item.id);
                          const ciLogError = ciLogErrorById[item.id];
                          const logAvailable = canLoadCiLog(selectedRemote, item);
                          const expandable = canExpandCiItem(selectedRemote, item);
                          return (
                            <FieldRow data-openbitfun-product-component="review-platform" data-openbitfun-product-part="ciItem" key={item.id}>
                              <Stack gap="3">
                                <CardHeader
                                  data-openbitfun-product-component="review-platform"
                                  data-openbitfun-product-part="ciHead"
                                  title={<OverflowText>{item.name}</OverflowText>}
                                  description={<StatusPill tone={tone === 'passed' ? 'success' : tone === 'failed' ? 'danger' : 'warning'} data-openbitfun-product-component="review-platform" data-openbitfun-product-part="ciStatus">
                                    {ciItemStatusText(item)}
                                  </StatusPill>}
                                  actions={<ToolbarGroup>
                                    {expandable && (
                                      <Tooltip content={isCiExpanded ? 'Collapse details' : 'Expand details'}>
                                        <IconButton
                                          aria-label={isCiExpanded ? 'Collapse details' : 'Expand details'}
                                          size="sm"
                                          onClick={() => toggleCiExpanded(item)}
                                          disabled={ciLogLoading}
                                          aria-busy={ciLogLoading}
                                          aria-expanded={isCiExpanded}
                                          icon={isCiExpanded ? <Icon name="chevron-down" size="xs" /> : <Icon name="chevron-right" size="xs" />}
                                        />
                                      </Tooltip>
                                    )}
                                    <Tooltip content="Add this result to chat">
                                      <IconButton
                                        aria-label="Add this result to chat"
                                        size="sm"
                                        onClick={() => void handleAddCiItemContext(item)}
                                        disabled={!selectedPr}
                                        icon={<MessageSquareText size={13} />}
                                      />
                                    </Tooltip>
                                    {item.webUrl && (
                                      <Tooltip content="Open result in provider">
                                        <IconButton
                                          aria-label="Open result in provider"
                                          size="sm"
                                          onClick={() => void handleOpenCiUrl(item.webUrl)}
                                          icon={<Icon name="link" size="xs" />}
                                        />
                                      </Tooltip>
                                    )}
                                  </ToolbarGroup>}
                                />
                                {isCiExpanded && (
                                  <Stack gap="3" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="ciLog">
                                    <dl className="review-platform__ci-details">
                                      {item.stage && <div className="review-platform__fact-row"><dt>Stage</dt><dd>{item.stage}</dd></div>}
                                      {item.detail && <div className="review-platform__fact-row"><dt>Detail</dt><dd>{item.detail}</dd></div>}
                                      {item.webUrl && <div className="review-platform__fact-row"><dt>URL</dt><dd>{item.webUrl}</dd></div>}
                                    </dl>
                                    {ciLogLoading && renderDetailLoading('Loading check details...')}
                                    {!ciLogLoading && ciLogError && logAvailable && (
                                      <Alert tone="error" message={ciLogError} description={<Button size="sm" variant="outline" onClick={() => void loadCiLog(item)}>Retry</Button>} />
                                    )}
                                    {!ciLogLoading && !ciLogError && (ciLog?.log || item.log) && <pre tabIndex={0} aria-label={item.name} className="review-platform__ci-log-block">{ciLog?.log || item.log}</pre>}
                                    {!ciLogLoading && !ciLogError && ciLog && !ciLog.log && !item.log && ciLog.message && <Alert role="status" message={ciLog.message} />}
                                  </Stack>
                                )}
                              </Stack>
                            </FieldRow>
                          );
                        })}
                      </FieldGroup>
                      {renderDetailPagination('Checks', ciPage, ciTotal, setCiPageIndex)}
                    </Disclosure>

                    <Disclosure
                      key={'comments:' + selectedRemoteId + ':' + selectedPrId}
                      summary={'Comments (' + reviewItemCount + ')'}
                      disabled={!detailLoading && reviewThreads.length === 0}
                      data-openbitfun-product-component="review-platform"
                      data-openbitfun-product-part="section"
                    >
                      <FieldGroup appearance="plain">
                        {pagedReviewThreads.map(thread => {
                          const parent = thread.replyToProviderCommentId
                            ? reviewThreadByCommentId.get(thread.replyToProviderCommentId)
                            : null;
                          return (
                            <FieldRow data-openbitfun-product-component="review-platform" data-openbitfun-product-part="thread" key={thread.id}>
                              <Stack gap="3">
                                <CardHeader
                                  data-openbitfun-product-component="review-platform"
                                  data-openbitfun-product-part="threadHead"
                                  title={thread.author}
                                  description={formatRelativeTime(thread.updatedAt) || formatAbsoluteTime(thread.updatedAt)}
                                  actions={<ToolbarGroup>
                                    {thread.kind === 'review' && <StatusPill tone="neutral">Review</StatusPill>}
                                    {thread.resolved && <StatusPill tone="success">Resolved</StatusPill>}
                                  </ToolbarGroup>}
                                />
                                {parent && (
                                  <Disclosure summary={'Reply to @' + parent.author}>
                                    <div className="review-platform__body-markdown"><MarkdownRenderer content={parent.body} basePath={workspacePath} /></div>
                                  </Disclosure>
                                )}
                                <div className="review-platform__body-markdown" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="threadBody"><MarkdownRenderer content={thread.body} basePath={workspacePath} /></div>
                                {thread.filePath && <OverflowText className="review-platform__thread-anchor">{thread.filePath}{thread.line ? `:${thread.line}` : ''}</OverflowText>}
                              </Stack>
                            </FieldRow>
                          );
                        })}
                      </FieldGroup>
                      {renderDetailPagination('Comments', reviewPage, reviewThreads.length, setReviewPageIndex)}
                    </Disclosure>
                  </ScrollArea>
                )}

                {activeTab === 'changes' && (
                  <ScrollArea className="review-platform__tab-content" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="fileList">
                    {detailError && (
                      <Alert tone="error" message={detailError} description={
                        <Button size="sm" variant="outline" onClick={handleRetryDetail}>
                          Retry
                        </Button>
                      } />
                    )}
                    {detailLoading && renderDetailLoading(pagedChangedFiles.length ? 'Refreshing files...' : 'Loading files...')}
                    <FieldGroup appearance="plain">
                      {pagedChangedFiles.map(file => {
                        const key = fileKey(file);
                        const isExpanded = expandedFileKeys.has(key);
                        return (
                          <FieldRow key={key} padding="none" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="fileRow">
                            <Disclosure
                              data-openbitfun-product-component="review-platform"
                              data-openbitfun-product-part="fileCard"
                              summary={file.path}
                              description={<span className="review-platform__inline-meta">
                                <StatusPill tone={file.status === 'added' ? 'success' : file.status === 'deleted' ? 'danger' : 'neutral'} data-openbitfun-product-component="review-platform" data-openbitfun-product-part="fileStatus">{file.status}</StatusPill>
                                <ChangeCount additions={file.additions} deletions={file.deletions} data-openbitfun-product-component="review-platform" data-openbitfun-product-part="fileDelta" />
                              </span>}
                              open={isExpanded}
                              onOpenChange={() => toggleFileExpanded(key)}
                              unmountOnClose
                              actions={<Tooltip content="Add to chat">
                                <IconButton aria-label={`Add ${file.path} to chat`} size="sm" onClick={() => void handleAddFileDiffContext(file)} disabled={!selectedPr} icon={<MessageSquareText size={13} />} />
                              </Tooltip>}
                            >
                              {file.patch ? (
                                <pre tabIndex={0} className="review-platform__diff-block" data-openbitfun-product-component="review-platform" data-openbitfun-product-part="diff" aria-label={`Diff for ${file.path}`}>
                                  {file.patch.split('\n').map((line, index) => (
                                    <span key={`${file.path}-${index}`} className={diffLineClass(line)}>
                                      {line || ' '}
                                    </span>
                                  ))}
                                </pre>
                              ) : (
                                <Empty imageSize="sm" icon={<Icon name="files" />} description="No inline diff is available for this file." />
                              )}
                            </Disclosure>
                          </FieldRow>
                        );
                      })}
                    </FieldGroup>
                    {!detailLoading && detail && detail.files.length === 0 && (
                      <Empty imageSize="sm" icon={<Icon name="files" />} description={detail.changedFileCountKnown === false
                        ? 'Changed files are currently unavailable from this provider.'
                        : 'No changed files were returned by this provider.'} />
                    )}
                    {renderDetailPagination('Files', changePage, changedFiles.length, setChangePageIndex)}
                  </ScrollArea>
                )}

                {activeTab === 'commits' && (
                  <ScrollArea className="review-platform__tab-content">
                    {detailError && (
                      <Alert tone="error" message={detailError} description={
                        <Button size="sm" variant="outline" onClick={handleRetryDetail}>
                          Retry
                        </Button>
                      } />
                    )}
                    {detailLoading && renderDetailLoading(pagedCommits.length ? 'Refreshing commits...' : 'Loading commits...')}
                    <FieldGroup appearance="plain">
                      {pagedCommits.map(commit => (
                        <FieldRow key={commit.hash}>
                          <CardHeader
                            leading={<Icon name="commit" size="sm" />}
                            title={commit.title}
                            description={`${commit.author} · ${formatRelativeTime(commit.committedAt)} · ${commit.shortHash}`}
                          />
                        </FieldRow>
                      ))}
                    </FieldGroup>
                    {!detailLoading && detail && commits.length === 0 && (
                      <Empty imageSize="sm" icon={<Icon name="commit" />} description="No commits were returned by this provider." />
                    )}
                    {renderDetailPagination('Commits', commitPage, commits.length, setCommitPageIndex)}
                  </ScrollArea>
                )}
              </div>
            </>
          )}
        </main>}
      </div>
      <MenuPopover
        open={detailMenuOpen}
        anchorRef={detailMenuRef}
        onClose={() => setDetailMenuOpen(false)}
        aria-label="Pull request actions"
        items={[
          {
            id: 'add-context', label: 'Add to chat', icon: <MessageSquareText size={14} />,
            disabled: !selectedPr,
            submenu: [
              { id: 'add-overview', label: 'Pull request overview', onSelect: () => void handleFillPrContext() },
              ...(activeTab === 'overview' ? [
                { id: 'add-checks', label: 'Checks on this page', disabled: !detail || detailLoading || !ciItems.length, onSelect: () => void handleAddCiPageContext() },
                { id: 'add-comments', label: 'Comments on this page', disabled: !detail || detailLoading || !reviewThreads.length, onSelect: () => void handleAddReviewsContext() },
              ] : []),
              ...(activeTab === 'commits' ? [
                { id: 'add-commits', label: 'Commits on this page', disabled: !detail || detailLoading || !commits.length, onSelect: () => void handleAddCommitsContext() },
              ] : []),
            ],
          },
          {
            id: 'open-external', label: 'Open in browser', icon: <Icon name="arrow-up-right" size="sm" />,
            disabled: !selectedPr?.webUrl && !initialPullRequestUrl, onSelect: () => void handleOpenExternal(),
          },
          {
            id: 'refresh', label: 'Refresh pull request', icon: <Icon name="refresh" size="sm" />,
            disabled: !selectedPr || detailLoading, onSelect: () => void handleRefreshDetail(),
          },
          { id: 'account-separator', label: '', separator: true },
          {
            id: 'authenticate', label: selectedRemote?.platform === 'github' ? 'GitHub CLI authentication' : account?.authSource === 'stored' ? 'Update token' : 'Add token',
            icon: <KeyRound size={14} />, disabled: !selectedRemote || selectedRemote.platform === 'unknown' || authSaving,
            onSelect: handleOpenAuthModal,
          },
        ]}
      />
      <Dialog
        open={authModalOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !authSaving) {
            setAuthModalOpen(false);
            setAuthError(null);
          }
        }}
        size="sm"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{selectedRemote?.platform === 'github' ? 'GitHub CLI authentication' : `${selectedRemote ? providerLabel(selectedRemote) : 'Provider'} token`}</DialogTitle>
          </DialogHeading>
          <DialogClose disabled={authSaving} />
        </DialogHeader>
        <DialogBody>
          <form
            id={authFormId}
            onSubmit={(event) => {
              event.preventDefault();
              void handleSaveAuthToken();
            }}
          >
            <Stack gap="4">
              <CardHeader title={selectedRemote?.projectPath ?? ''} description={
                [selectedRemote?.host, account?.label, authLabel(account), account && authSourceLabel(account.authSource)].filter(Boolean).join(' · ')
              } />
              {selectedRemote?.platform === 'github' ? (
                <Stack gap="3">
                  <Alert role="status" message="Run this command in the integrated terminal, finish the GitHub CLI flow, then retry." />
                  <pre tabIndex={0} className="review-platform__ci-log-block">{`gh auth login --hostname ${selectedRemote.host}`}</pre>
                  {authError && <Alert tone="error" message={authError} />}
                </Stack>
              ) : (
                <Field label="Token" controlWidth="fill" error={authError ?? undefined}>
                  <DesignInput
                    type="password"
                    autoComplete="off"
                    autoFocus
                    value={authToken}
                    disabled={authSaving}
                    onChange={event => {
                      setAuthToken(event.target.value);
                      if (authError) setAuthError(null);
                    }}
                  />
                </Field>
              )}
            </Stack>
          </form>
        </DialogBody>
        <DialogFooter>
          {account?.authSource === 'stored' && (
            <Button type="button" size="sm" variant="text" disabled={!selectedRemote || authSaving || loading} onClick={() => void handleClearAuthToken()}>
              Clear token
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="fill"
            disabled={authSaving}
            onClick={() => {
              setAuthModalOpen(false);
              setAuthError(null);
            }}
          >
            Cancel
          </Button>
          {selectedRemote?.platform === 'github' ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={authSaving}
                onClick={() => void handleCopyGithubAuthCommand()}
                leadingIcon={<Icon name="duplicate" size="xs" />}
              >

                Copy
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                loading={authSaving}
                onClick={() => void handleOpenGithubAuthTerminal()}
                leadingIcon={<Icon name="terminal" size="xs" />}
              >

                Open terminal
              </Button>
            </>
          ) : (
            <Button
              type="submit"
              form={authFormId}
              size="sm"
              variant="primary"
              loading={authSaving}
              disabled={!authToken.trim()}
            >
              Save
            </Button>
          )}
        </DialogFooter>
      </Dialog>
      {deepReviewConsentDialog}
    </div>
  );
};

export default ReviewPlatformPanel;
