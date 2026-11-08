import type { ReviewPlatformRemote } from '@/infrastructure/api';

export interface PullRequestLinkTarget {
  readonly webUrl: string;
  readonly host: string;
  readonly projectPath: string;
  readonly pullRequestId: string;
}

const BACKSLASH_PATTERN = /\\/g;
const GIT_SUFFIX_PATTERN = /\.git$/i;
const EDGE_SLASHES_PATTERN = /^\/+|\/+$/g;

function cleanSegment(segment: string): string {
  if (segment.indexOf('%') === -1) {
    return segment;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizeProjectPath(value: string): string {
  return value
    .replace(BACKSLASH_PATTERN, '/')
    .replace(GIT_SUFFIX_PATTERN, '')
    .replace(EDGE_SLASHES_PATTERN, '')
    .toLowerCase();
}

const PARSE_CACHE_LIMIT = 256;
const parseCache = new Map<string, PullRequestLinkTarget | null>();

export function parsePullRequestUrl(value: string): PullRequestLinkTarget | null {
  const cached = parseCache.get(value);
  if (cached !== undefined) {
    return cached;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    if (parseCache.size >= PARSE_CACHE_LIMIT) {
      const oldestKey = parseCache.keys().next().value;
      if (oldestKey !== undefined) parseCache.delete(oldestKey);
    }
    parseCache.set(value, null);
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    if (parseCache.size >= PARSE_CACHE_LIMIT) {
      const oldestKey = parseCache.keys().next().value;
      if (oldestKey !== undefined) parseCache.delete(oldestKey);
    }
    parseCache.set(value, null);
    return null;
  }

  const segments = url.pathname
    .split('/')
    .map(cleanSegment)
    .filter(Boolean);

  let target: PullRequestLinkTarget | null = null;

  const mergeRequestIndex = segments.findIndex(segment => segment === 'merge_requests');
  if (mergeRequestIndex >= 0 && segments[mergeRequestIndex + 1]) {
    const projectEnd = segments[mergeRequestIndex - 1] === '-'
      ? mergeRequestIndex - 1
      : mergeRequestIndex;
    const projectPath = segments.slice(0, projectEnd).join('/');
    if (projectPath) {
      target = Object.freeze({
        webUrl: url.toString(),
        host: url.host.toLowerCase(),
        projectPath,
        pullRequestId: segments[mergeRequestIndex + 1],
      });
    }
  }

  if (!target) {
    const pullIndex = segments.findIndex(segment => segment === 'pull' || segment === 'pulls');
    if (pullIndex >= 0 && segments[pullIndex + 1]) {
      const projectPath = segments.slice(0, pullIndex).join('/');
      if (projectPath) {
        target = Object.freeze({
          webUrl: url.toString(),
          host: url.host.toLowerCase(),
          projectPath,
          pullRequestId: segments[pullIndex + 1],
        });
      }
    }
  }

  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    const oldestKey = parseCache.keys().next().value;
    if (oldestKey !== undefined) parseCache.delete(oldestKey);
  }
  parseCache.set(value, target);
  return target;
}

const remoteNormalizedPathCache = new WeakMap<ReviewPlatformRemote, string>();

export function remoteMatchesPullRequestLink(remote: ReviewPlatformRemote, target: PullRequestLinkTarget): boolean {
  if (remote.host.toLowerCase() !== target.host) {
    return false;
  }

  const targetProject = normalizeProjectPath(target.projectPath);
  let remoteProject = remoteNormalizedPathCache.get(remote);
  if (remoteProject === undefined) {
    remoteProject = normalizeProjectPath(remote.projectPath);
    if (!remoteProject) {
      try {
        const remoteUrl = new URL(remote.webUrl || remote.url);
        remoteProject = normalizeProjectPath(remoteUrl.pathname);
      } catch {
        remoteProject = '';
      }
    }
    remoteNormalizedPathCache.set(remote, remoteProject);
  }

  return Boolean(targetProject && remoteProject && targetProject === remoteProject);
}
