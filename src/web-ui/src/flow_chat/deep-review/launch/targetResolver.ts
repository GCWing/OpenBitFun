import type { GitWorkspaceScope } from '@/infrastructure/api/service-api/GitAPI';
import { gitAPI, systemAPI, workspaceAPI } from '@/infrastructure/api';
import {
  isGitRepositoryNotFoundError,
  isGitRepositoryUntrustedError,
} from '@/infrastructure/api/errors/TauriCommandError';
import type {
  GitChangedFile,
  GitDiffParams,
  GitStatus,
} from '@/infrastructure/api/service-api/GitAPI';
import type { ReviewTeamChangeStats } from '@/shared/services/reviewTeamService';
import {
  buildGitRangeReviewTargetEvidence,
  buildUnknownReviewTargetEvidence,
  buildWorkspaceReviewTargetEvidence,
  stableReviewFingerprint,
  type ReviewTargetEvidence,
} from '@/shared/services/reviewTeamService';
import {
  classifyReviewTargetFromFiles,
  classifyReviewTargetFromPathChanges,
  createUnknownReviewTargetClassification,
  type ReviewTargetClassification,
  type ReviewTargetPathChange,
} from '@/shared/services/reviewTargetClassifier';
import { createLogger } from '@/shared/utils/logger';
import {
  collectWorkspaceDiffFilePaths,
  extractExplicitReviewFilePaths,
  hasUnresolvedPathLikeReviewFocus,
  parseSlashCommandGitTarget,
} from './commandParser';

const log = createLogger('DeepReviewService');
const REVIEW_UNTRACKED_FILE_LIMIT = 32;
const REVIEW_UNTRACKED_READ_CONCURRENCY = 4;
const REVIEW_UNTRACKED_MAX_BYTES = 16 * 1024;
const REVIEW_UNTRACKED_TOTAL_BYTES = 256 * 1024;

export interface ResolvedDeepReviewTarget {
  target: ReviewTargetClassification;
  changeStats: ReviewTeamChangeStats;
  targetEvidence: ReviewTargetEvidence;
}

/**
 * Preserves actionable Git failures through evidence-gathering catches.
 * Repository discovery and ownership errors have specific launch messages;
 * collapsing them into "unknown" would hide both the reason and the remedy.
 * Other failures still degrade to unavailable evidence.
 */
function rethrowActionableGitError(error: unknown): void {
  if (isGitRepositoryUntrustedError(error) || isGitRepositoryNotFoundError(error)) {
    throw error;
  }
}

async function resolveRevision(
  workspace: GitWorkspaceScope,
  revision: string,
): Promise<string | undefined> {
  try {
    return await gitAPI.resolveRevision(workspace, revision);
  } catch (error) {
    rethrowActionableGitError(error);
    log.warn('Failed to resolve Git revision for Review target evidence', {
      workspace,
      revision,
      error,
    });
    return undefined;
  }
}

async function resolveDiff(
  workspace: GitWorkspaceScope,
  params: GitDiffParams,
): Promise<string | undefined> {
  try {
    return await gitAPI.getDiff(workspace, { ...params, reviewSafe: true });
  } catch (error) {
    rethrowActionableGitError(error);
    log.warn('Failed to resolve Git diff for Review target evidence', {
      workspace,
      params,
      error,
    });
    return undefined;
  }
}

function countReviewTargetFiles(target: ReviewTargetClassification): number {
  return target.files.filter((file) => !file.excluded).length;
}

export function buildUnknownChangeStats(
  target: ReviewTargetClassification,
): ReviewTeamChangeStats {
  return {
    fileCount: countReviewTargetFiles(target),
    lineCountSource: 'unknown',
  };
}

export function countChangedLinesFromUnifiedDiff(diff: string): number | undefined {
  if (!diff.trim()) {
    return undefined;
  }

  let changedLines = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (
      (line.startsWith('+') && !/^\+\+\+\s/.test(line)) ||
      (line.startsWith('-') && !/^---\s/.test(line))
    ) {
      changedLines += 1;
    }
  }

  return changedLines;
}

function buildDiffChangeStats(
  target: ReviewTargetClassification,
  totalLinesChanged: number | undefined,
): ReviewTeamChangeStats {
  if (totalLinesChanged === undefined) {
    return buildUnknownChangeStats(target);
  }

  return {
    fileCount: countReviewTargetFiles(target),
    totalLinesChanged,
    lineCountSource: 'diff_stat',
  };
}

function isWindowsWorkspacePath(workspacePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(workspacePath) || /^\\\\[^\\]/.test(workspacePath);
}

function isAbsoluteWorkspacePath(path: string, windows: boolean): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/)/.test(path) || (windows && /^\\\\/.test(path));
}

function normalizePath(path: string, workspacePath: string): string {
  const platformPath = isWindowsWorkspacePath(workspacePath)
    ? path.replace(/\\/g, '/')
    : path;
  return platformPath.replace(/^\.\/+/, '');
}

function hasParentTraversal(path: string, workspacePath: string): boolean {
  const normalized = isWindowsWorkspacePath(workspacePath)
    ? path.replace(/\\/g, '/')
    : path;
  return normalized.split('/').some((segment) => segment === '..');
}

function workspaceRelativeTargetPath(
  path: string,
  workspacePath: string,
): string | undefined {
  const normalized = normalizePath(path, workspacePath);
  if (hasParentTraversal(normalized, workspacePath)) {
    return undefined;
  }
  const root = normalizePath(workspacePath, workspacePath).replace(/\/+$/, '');
  const absolute = isAbsoluteWorkspacePath(normalized, isWindowsWorkspacePath(workspacePath));
  if (!absolute) return normalized;

  const windows = isWindowsWorkspacePath(workspacePath);
  const comparablePath = windows ? normalized.toLowerCase() : normalized;
  const comparableRoot = windows ? root.toLowerCase() : root;
  if (!comparablePath.startsWith(`${comparableRoot}/`)) {
    return undefined;
  }
  return normalized.slice(root.length + 1);
}

function bindTargetToWorkspace(
  target: ReviewTargetClassification,
  workspacePath: string,
): ReviewTargetClassification | undefined {
  const changes: ReviewTargetPathChange[] = [];
  for (const file of target.files) {
    const path = workspaceRelativeTargetPath(file.normalizedPath, workspacePath);
    const oldPath = file.normalizedOldPath
      ? workspaceRelativeTargetPath(file.normalizedOldPath, workspacePath)
      : undefined;
    if (!path || (file.normalizedOldPath && !oldPath)) {
      return undefined;
    }
    changes.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status: file.status,
    });
  }
  return classifyReviewTargetFromPathChanges(changes, target.source);
}

function normalizeWorkspaceStatus(status: string): ReviewTargetPathChange['status'] {
  const normalized = status.trim().toLowerCase();
  if (['added', 'modified', 'deleted', 'renamed', 'copied'].includes(normalized)) {
    return normalized as ReviewTargetPathChange['status'];
  }
  const raw = status.toUpperCase();
  if (raw.includes('R')) return 'renamed';
  if (raw.includes('A') || raw.includes('?')) return 'added';
  if (raw.includes('D')) return 'deleted';
  if (raw.includes('M') || raw.includes('T')) return 'modified';
  return 'unknown';
}

function refineWorkspaceTarget(
  target: ReviewTargetClassification,
  status: GitStatus,
  changedFiles: GitChangedFile[],
  workspacePath: string,
): ReviewTargetClassification {
  const requestedPaths = new Set(target.files.flatMap((file) => [
    normalizePath(file.normalizedPath, workspacePath),
    ...(file.normalizedOldPath
      ? [normalizePath(file.normalizedOldPath, workspacePath)]
      : []),
  ]));
  const candidates = new Map<string, ReviewTargetPathChange>();
  for (const file of changedFiles) {
    const path = normalizePath(file.path, workspacePath);
    candidates.set(path, {
      path,
      ...(file.old_path
        ? { oldPath: normalizePath(file.old_path, workspacePath) }
        : {}),
      status: file.status,
    });
  }
  for (const file of [...status.staged, ...status.unstaged]) {
    const path = normalizePath(file.path, workspacePath);
    if (!candidates.has(path)) {
      candidates.set(path, {
        path,
        status: normalizeWorkspaceStatus(file.status),
      });
    }
  }
  for (const untracked of status.untracked) {
    const path = normalizePath(untracked, workspacePath);
    if (!candidates.has(path)) {
      candidates.set(path, { path, status: 'added' });
    }
  }
  for (const conflict of status.conflicts) {
    const path = normalizePath(conflict, workspacePath);
    candidates.set(path, { path, status: 'unknown' });
  }

  const changes = [...candidates.values()].filter((change) =>
    requestedPaths.has(change.path) ||
    Boolean(change.oldPath && requestedPaths.has(change.oldPath))
  );
  for (const file of target.files) {
    const path = normalizePath(file.normalizedPath, workspacePath);
    const oldPath = file.normalizedOldPath
      ? normalizePath(file.normalizedOldPath, workspacePath)
      : undefined;
    const represented = changes.some((change) =>
      change.path === path || change.oldPath === path ||
      Boolean(oldPath && (change.path === oldPath || change.oldPath === oldPath))
    );
    if (!represented) {
      changes.push({ path, ...(oldPath ? { oldPath } : {}), status: file.status });
    }
  }
  return classifyReviewTargetFromPathChanges(changes, target.source);
}

function workspaceFilePath(workspacePath: string, filePath: string): string {
  if (isAbsoluteWorkspacePath(filePath, isWindowsWorkspacePath(workspacePath))) {
    return isWindowsWorkspacePath(workspacePath)
      ? filePath.replace(/\\/g, '/')
      : filePath;
  }
  const rootPath = isWindowsWorkspacePath(workspacePath)
    ? workspacePath.replace(/\\/g, '/')
    : workspacePath;
  return `${rootPath.replace(/\/+$/, '')}/${normalizePath(filePath, workspacePath)}`;
}

async function findMissingWorkspacePaths(
  workspacePath: string,
  paths: string[],
): Promise<string[]> {
  const results = await Promise.all([...new Set(paths)].map(async (path) => ({
    path,
    exists: await systemAPI.checkPathExists(
      workspaceFilePath(workspacePath, path),
    ),
  })));
  return results.flatMap(({ path, exists }) => exists ? [] : [path]);
}

function missingExplicitTarget(
  target: ReviewTargetClassification,
): ResolvedDeepReviewTarget {
  return {
    target,
    changeStats: buildUnknownChangeStats(target),
    targetEvidence: buildUnknownReviewTargetEvidence(
      target,
      'explicit_target_path_not_found',
    ),
  };
}

function countTextFileLines(content: string): number {
  if (!content) {
    return 0;
  }
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.length;
}

async function resolveUntrackedContentFacts(
  workspace: GitWorkspaceScope,
  untrackedPaths: string[],
  remoteConnectionId?: string,
): Promise<{
  fingerprints: Record<string, string>;
  lineCounts: Record<string, number>;
}> {
  // File IO is routed by the owning workspace ID; the repository path is the IO root.
  const workspacePath = workspace.repositoryPath ?? '';
  const workspaceId = workspace.workspaceId?.trim() || undefined;
  const boundedPaths = untrackedPaths.slice(0, REVIEW_UNTRACKED_FILE_LIMIT);
  const entries: Array<readonly [string, string, number | undefined]> =
    untrackedPaths.map((path) => [
      normalizePath(path, workspacePath),
      'unavailable',
      undefined,
    ] as const);
  let reservedBytes = 0;
  let nextIndex = 0;
  const readNext = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= boundedPaths.length) {
      return;
    }
    const filePath = boundedPaths[index];
    try {
      const absolutePath = workspaceFilePath(workspacePath, filePath);
      const metadata = workspaceId
        ? await workspaceAPI.getWorkspaceFileMetadata(workspaceId, absolutePath)
        : await workspaceAPI.getFileMetadata(absolutePath);
      if (
        metadata.isSymlink ||
        !metadata.isFile ||
        metadata.size > REVIEW_UNTRACKED_MAX_BYTES ||
        reservedBytes + metadata.size > REVIEW_UNTRACKED_TOTAL_BYTES
      ) {
        entries[index] = [normalizePath(filePath, workspacePath), 'unavailable', undefined] as const;
        await readNext();
        return;
      }
      reservedBytes += metadata.size;
      const content = workspaceId
        ? await workspaceAPI.readWorkspaceFile(workspaceId, absolutePath)
        : remoteConnectionId
          ? await workspaceAPI.readFileContent(
              absolutePath,
              undefined,
              remoteConnectionId,
            )
          : await workspaceAPI.readFileContent(absolutePath);
      entries[index] = [
        normalizePath(filePath, workspacePath),
        stableReviewFingerprint(content),
        countTextFileLines(content),
      ] as const;
    } catch (error) {
      log.warn('Failed to fingerprint untracked Review target file', {
        workspacePath,
        filePath,
        error,
      });
      entries[index] = [normalizePath(filePath, workspacePath), 'unavailable', undefined] as const;
    }
    await readNext();
  };
  await Promise.all(
    Array.from(
      { length: Math.min(REVIEW_UNTRACKED_READ_CONCURRENCY, boundedPaths.length) },
      () => readNext(),
    ),
  );
  return {
    fingerprints: Object.fromEntries(entries.map(([path, fingerprint]) => [path, fingerprint])),
    lineCounts: Object.fromEntries(entries.flatMap(([path, , lineCount]) =>
      lineCount === undefined ? [] : [[path, lineCount]]
    )),
  };
}

export interface ResolvedCurrentFileReviewSnapshot {
  target: ReviewTargetClassification;
  changeStats: ReviewTeamChangeStats;
  targetEvidence: ReviewTargetEvidence;
}

export async function resolveCurrentFileReviewSnapshot(
  workspace: GitWorkspaceScope | undefined,
  target: ReviewTargetClassification,
  remoteConnectionId?: string,
  knownStatus?: GitStatus,
): Promise<ResolvedCurrentFileReviewSnapshot> {
  const workspacePath = workspace?.repositoryPath;
  if (!workspacePath) {
    return {
      target,
      changeStats: buildUnknownChangeStats(target),
      targetEvidence: buildUnknownReviewTargetEvidence(
        target,
        'workspace_unavailable_for_file_scope',
      ),
    };
  }
  const workspaceTarget = bindTargetToWorkspace(target, workspacePath);
  if (!workspaceTarget) {
    const unavailableTarget = createUnknownReviewTargetClassification(target.source);
    return {
      target: unavailableTarget,
      changeStats: buildUnknownChangeStats(unavailableTarget),
      targetEvidence: buildUnknownReviewTargetEvidence(
        unavailableTarget,
        'target_path_outside_workspace',
      ),
    };
  }
  if (remoteConnectionId) {
    return {
      target: workspaceTarget,
      changeStats: buildUnknownChangeStats(workspaceTarget),
      targetEvidence: buildUnknownReviewTargetEvidence(
        workspaceTarget,
        'remote_workspace_review_unavailable',
      ),
    };
  }
  const targetFiles = workspaceTarget.files
    .filter((file) => !file.excluded)
    .map((file) => normalizePath(file.normalizedPath, workspacePath));
  try {
    const [status, changedFiles] = await Promise.all([
      knownStatus
        ? Promise.resolve(knownStatus)
        : gitAPI.getStatus(workspace!, 'review_file_scope_snapshot'),
      gitAPI.getChangedFiles(workspace!, {
        source: 'HEAD',
        reviewSafe: true,
      }),
    ]);
    const resolvedTarget = refineWorkspaceTarget(
      workspaceTarget,
      status,
      changedFiles,
      workspacePath,
    );
    const resolvedTargetFiles = resolvedTarget.files
      .filter((file) => !file.excluded)
      .map((file) => normalizePath(file.normalizedPath, workspacePath));
    const targetDiffPaths = [...new Set(resolvedTarget.files.flatMap((file) => [
      ...(file.normalizedOldPath
        ? [normalizePath(file.normalizedOldPath, workspacePath)]
        : []),
      normalizePath(file.normalizedPath, workspacePath),
    ]))];
    const targetPathSet = new Set(resolvedTargetFiles);
    const targetUntracked = status.untracked.filter((path) =>
      targetPathSet.has(normalizePath(path, workspacePath))
    );
    const [baseRevision, diff, untrackedFacts] = await Promise.all([
      resolveRevision(workspace!, 'HEAD'),
      resolveDiff(workspace!, {
        source: 'HEAD',
        files: targetDiffPaths,
      }),
      resolveUntrackedContentFacts(
        workspace!,
        targetUntracked,
        remoteConnectionId,
      ),
    ]);
    const targetEvidence = buildWorkspaceReviewTargetEvidence({
      target: resolvedTarget,
      baseRevision,
      diff,
      status,
      untrackedContentFingerprints: untrackedFacts.fingerprints,
    });

    const changedPaths = new Set(
      collectWorkspaceDiffFilePaths(status).map((path) => normalizePath(path, workspacePath)),
    );
    const untrackedPaths = new Set(
      status.untracked.map((path) => normalizePath(path, workspacePath)),
    );
    const untrackedDirectoryPrefixes = [...untrackedPaths].filter((path) => path.endsWith('/'));
    const untrackedDirectoryTargets = new Set(resolvedTargetFiles.filter((file) =>
      untrackedDirectoryPrefixes.some((prefix) => file.startsWith(prefix))
    ));
    const conflictPaths = new Set(
      status.conflicts.map((path) => normalizePath(path, workspacePath)),
    );
    const changedTargetFiles = resolvedTargetFiles.filter((file) =>
      changedPaths.has(file) || untrackedDirectoryTargets.has(file)
    );
    if (untrackedDirectoryTargets.size > 0) {
      return {
        target: resolvedTarget,
        changeStats: buildUnknownChangeStats(resolvedTarget),
        targetEvidence,
      };
    }
    if (changedTargetFiles.some((file) => conflictPaths.has(file))) {
      return {
        target: resolvedTarget,
        changeStats: buildUnknownChangeStats(resolvedTarget),
        targetEvidence,
      };
    }
    const trackedChangedFiles = changedTargetFiles.filter((file) => !untrackedPaths.has(file));
    const trackedLineCount = countChangedLinesFromUnifiedDiff(diff ?? '');
    if (trackedChangedFiles.length > 0 && trackedLineCount === undefined) {
      return {
        target: resolvedTarget,
        changeStats: buildUnknownChangeStats(resolvedTarget),
        targetEvidence,
      };
    }
    let totalLinesChanged = trackedLineCount ?? 0;
    for (const file of changedTargetFiles) {
      if (!untrackedPaths.has(file)) {
        continue;
      }
      const lineCount = untrackedFacts.lineCounts[file];
      if (lineCount === undefined) {
        return {
          target: resolvedTarget,
          changeStats: buildUnknownChangeStats(resolvedTarget),
          targetEvidence,
        };
      }
      totalLinesChanged += lineCount;
    }
    return {
      target: resolvedTarget,
      changeStats: buildDiffChangeStats(resolvedTarget, totalLinesChanged),
      targetEvidence,
    };
  } catch (error) {
    rethrowActionableGitError(error);
    log.warn('Failed to resolve file-scoped Review snapshot', {
      workspacePath,
      targetFiles,
      error,
    });
    return {
      target: workspaceTarget,
      changeStats: buildUnknownChangeStats(workspaceTarget),
      targetEvidence: buildUnknownReviewTargetEvidence(
        workspaceTarget,
        'file_scope_target_evidence_failed',
      ),
    };
  }
}

export async function resolveCurrentFileReviewChangeStats(
  workspace: GitWorkspaceScope,
  target: ReviewTargetClassification,
  knownStatus?: GitStatus,
  remoteConnectionId?: string,
): Promise<ReviewTeamChangeStats> {
  return (await resolveCurrentFileReviewSnapshot(
    workspace,
    target,
    remoteConnectionId,
    knownStatus,
  )).changeStats;
}

export async function resolveSlashCommandReviewTarget(
  commandFocus: string,
  workspace?: GitWorkspaceScope,
  remoteConnectionId?: string,
): Promise<ResolvedDeepReviewTarget> {
  const workspacePath = workspace?.repositoryPath;
  if (/(?:^|\s)\S+\.\.\.\S+(?:\s|$)/.test(commandFocus)) {
    const target = createUnknownReviewTargetClassification('slash_command_git_ref');
    return {
      target,
      changeStats: buildUnknownChangeStats(target),
      targetEvidence: buildUnknownReviewTargetEvidence(
        target,
        'three_dot_git_range_not_supported',
      ),
    };
  }
  const gitTarget = parseSlashCommandGitTarget(commandFocus);
  const explicitFilePaths = extractExplicitReviewFilePaths(commandFocus);
  if (gitTarget && explicitFilePaths.length > 0) {
    const target = createUnknownReviewTargetClassification('slash_command_git_ref');
    return {
      target,
      changeStats: buildUnknownChangeStats(target),
      targetEvidence: buildUnknownReviewTargetEvidence(
        target,
        'combined_git_range_and_file_filter_not_supported',
      ),
    };
  }
  if (explicitFilePaths.length > 0) {
    const target = classifyReviewTargetFromFiles(
      explicitFilePaths,
      'slash_command_explicit_files',
    );
    if (!workspacePath) {
      return {
        target,
        changeStats: buildUnknownChangeStats(target),
        targetEvidence: buildUnknownReviewTargetEvidence(
          target,
          'workspace_unavailable_for_file_scope',
        ),
      };
    }

    const workspaceTarget = bindTargetToWorkspace(target, workspacePath);
    if (!workspaceTarget) {
      return {
        target,
        changeStats: buildUnknownChangeStats(target),
        targetEvidence: buildUnknownReviewTargetEvidence(
          target,
          'target_path_outside_workspace',
        ),
      };
    }

    try {
      if (remoteConnectionId) {
        return resolveCurrentFileReviewSnapshot(
          workspace,
          workspaceTarget,
          remoteConnectionId,
        );
      }

      const [status, changedFiles] = await Promise.all([
        gitAPI.getStatus(workspace!, 'review_explicit_scope_snapshot'),
        gitAPI.getChangedFiles(workspace!, {
          source: 'HEAD',
          reviewSafe: true,
        }),
      ]);
      const candidatePaths = new Set<string>();
      for (const file of changedFiles) {
        candidatePaths.add(normalizePath(file.path, workspacePath).replace(/\/+$/, ''));
        if (file.old_path) {
          candidatePaths.add(normalizePath(file.old_path, workspacePath).replace(/\/+$/, ''));
        }
      }
      for (const path of collectWorkspaceDiffFilePaths(status)) {
        candidatePaths.add(normalizePath(path, workspacePath).replace(/\/+$/, ''));
      }
      const requested = workspaceTarget.files
        .filter((file) => !file.excluded)
        .map((file) => {
          const normalized = normalizePath(file.normalizedPath, workspacePath);
          const normalizedPath = normalized.replace(/\/+$/, '');
          const exactFileExists = candidatePaths.has(normalizedPath);
          const containsChangedFiles = [...candidatePaths].some((candidate) => (
            candidate.startsWith(`${normalizedPath}/`)
          ));
          return {
            path: normalizedPath,
            directory:
              /[\\/]$/.test(file.normalizedPath) ||
              (!exactFileExists && containsChangedFiles),
          };
        });
      const matchesRequestedPath = (path: string): boolean => {
        const normalized = normalizePath(path, workspacePath).replace(/\/+$/, '');
        return requested.some((entry) => (
          normalized === entry.path ||
          (entry.directory && normalized.startsWith(`${entry.path}/`))
        ));
      };
      const scopedChanges: ReviewTargetPathChange[] = changedFiles
        .filter((file) => (
          matchesRequestedPath(file.path) ||
          Boolean(file.old_path && matchesRequestedPath(file.old_path))
        ))
        .map((file) => ({
          path: file.path,
          oldPath: file.old_path,
          status: file.status,
        }));
      const represented = new Set(scopedChanges.flatMap((change) => [
        normalizePath(change.path, workspacePath),
        ...(change.oldPath ? [normalizePath(change.oldPath, workspacePath)] : []),
      ]));
      for (const path of collectWorkspaceDiffFilePaths(status)) {
        const normalized = normalizePath(path, workspacePath);
        if (matchesRequestedPath(normalized) && !represented.has(normalized)) {
          scopedChanges.push({ path: normalized, status: 'unknown' });
          represented.add(normalized);
        }
      }
      const requestedHasScopedChange = (entry: (typeof requested)[number]): boolean =>
        scopedChanges.some((change) => [change.path, change.oldPath]
          .filter((path): path is string => Boolean(path))
          .map((path) => normalizePath(path, workspacePath).replace(/\/+$/, ''))
          .some((path) => (
            path === entry.path ||
            (entry.directory && path.startsWith(`${entry.path}/`))
          )));
      const missingPaths = await findMissingWorkspacePaths(
        workspacePath,
        requested
          .filter((entry) => !requestedHasScopedChange(entry))
          .map((entry) => entry.path),
      );
      if (missingPaths.length > 0) {
        return missingExplicitTarget(workspaceTarget);
      }
      if (scopedChanges.length === 0) {
        return {
          target: workspaceTarget,
          changeStats: buildUnknownChangeStats(workspaceTarget),
          targetEvidence: buildUnknownReviewTargetEvidence(
            workspaceTarget,
            'explicit_file_scope_has_no_workspace_changes',
          ),
        };
      }
      const scopedTarget = classifyReviewTargetFromPathChanges(
        scopedChanges,
        'slash_command_explicit_files',
      );
      return resolveCurrentFileReviewSnapshot(
        workspace,
        scopedTarget,
        remoteConnectionId,
        status,
      );
    } catch (error) {
      rethrowActionableGitError(error);
      log.warn('Failed to resolve explicit Review file scope', {
        workspacePath,
        explicitFilePaths,
        error,
      });
      return {
        target,
        changeStats: buildUnknownChangeStats(target),
        targetEvidence: buildUnknownReviewTargetEvidence(
          target,
          'file_scope_target_evidence_failed',
        ),
      };
    }
  }

  if (!gitTarget && hasUnresolvedPathLikeReviewFocus(commandFocus)) {
    const target = createUnknownReviewTargetClassification('slash_command_explicit_files');
    return {
      target,
      changeStats: buildUnknownChangeStats(target),
      targetEvidence: buildUnknownReviewTargetEvidence(
        target,
        'explicit_target_unrecognized',
      ),
    };
  }

  if (gitTarget) {
    if (remoteConnectionId) {
      const target = createUnknownReviewTargetClassification('slash_command_git_ref');
      return {
        target,
        changeStats: buildUnknownChangeStats(target),
        targetEvidence: buildUnknownReviewTargetEvidence(
          target,
          'remote_exact_diff_unavailable',
        ),
      };
    }
    if (!workspacePath) {
      const target = createUnknownReviewTargetClassification('slash_command_git_ref');
      return {
        target,
        changeStats: buildUnknownChangeStats(target),
        targetEvidence: buildUnknownReviewTargetEvidence(
          target,
          'workspace_unavailable_for_git_range',
        ),
      };
    }

    try {
      const [baseRevision, headRevision] = await Promise.all([
        resolveRevision(workspace!, gitTarget.source ?? 'HEAD'),
        resolveRevision(workspace!, gitTarget.target ?? 'HEAD'),
      ]);
      if (!baseRevision || !headRevision) {
        throw new Error('Git range revisions could not be resolved to immutable commit ids');
      }
      const immutableTarget = { source: baseRevision, target: headRevision };
      const [changedFiles, diff, workspaceHeadRevision, status] =
        await Promise.all([
          gitAPI.getChangedFiles(workspace!, {
            ...immutableTarget,
            reviewSafe: true,
          }),
          resolveDiff(workspace!, immutableTarget),
          resolveRevision(workspace!, 'HEAD'),
          gitAPI.getStatus(workspace!, 'deep_review_git_range_binding').catch((error) => {
            rethrowActionableGitError(error);
            log.warn('Failed to resolve workspace binding for Git range Review', {
              workspacePath,
              error,
            });
            return undefined;
          }),
        ]);
      const target = classifyReviewTargetFromPathChanges(
        changedFiles.map((file) => ({
          path: file.path,
          oldPath: file.old_path,
          status: file.status,
        })),
        'slash_command_git_ref',
      );
      const changeStats = buildDiffChangeStats(
        target,
        diff === undefined ? undefined : countChangedLinesFromUnifiedDiff(diff),
      );
      return {
        target,
        changeStats,
        targetEvidence: buildGitRangeReviewTargetEvidence({
          target,
          changedFiles,
          baseRevision,
          headRevision,
          workspaceHeadRevision,
          status,
          diff,
        }),
      };
    } catch (error) {
      rethrowActionableGitError(error);
      log.warn('Failed to resolve Git target for Deep Review target', {
        workspacePath,
        gitTarget,
        error,
      });
      const target = createUnknownReviewTargetClassification('slash_command_git_ref');
      return {
        target,
        changeStats: buildUnknownChangeStats(target),
        targetEvidence: buildUnknownReviewTargetEvidence(
          target,
          'git_range_resolution_failed',
        ),
      };
    }
  }

  if (remoteConnectionId) {
    const target = createUnknownReviewTargetClassification('workspace_diff');
    return {
      target,
      changeStats: buildUnknownChangeStats(target),
      targetEvidence: buildUnknownReviewTargetEvidence(
        target,
        'remote_workspace_review_unavailable',
      ),
    };
  }

  if (workspacePath) {
    try {
      const status = await gitAPI.getStatus(workspace!, 'deep_review_target_resolver');
      const target = classifyReviewTargetFromFiles(
        collectWorkspaceDiffFilePaths(status),
        'workspace_diff',
      );
      const snapshot = await resolveCurrentFileReviewSnapshot(
        workspace,
        target,
        remoteConnectionId,
        status,
      );
      return {
        target: snapshot.target,
        changeStats: snapshot.changeStats,
        targetEvidence: snapshot.targetEvidence,
      };
    } catch (error) {
      rethrowActionableGitError(error);
      log.warn('Failed to resolve workspace diff for Deep Review target', {
        workspacePath,
        error,
      });
    }
  }

  const target = createUnknownReviewTargetClassification(
    commandFocus ? 'manual_prompt' : 'unknown',
  );
  return {
    target,
    changeStats: buildUnknownChangeStats(target),
    targetEvidence: buildUnknownReviewTargetEvidence(
      target,
      'review_target_unresolved',
    ),
  };
}
