import { Check as LucideCheck, Copy as LucideCopy } from 'lucide-react';
import { useResourceFileAccess, type ResourceFileAccess } from '@/infrastructure/api/ResourceFileContext';
/**
 * Markdown component
 * Used to render Markdown-formatted text
 */

import React, { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, Component, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { Tooltip } from '@openbitfun/ui';
import remarkGfm from 'remark-gfm';
import { remarkAutolinkBoundaries } from './remarkAutolinkBoundaries';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { visit } from 'unist-util-visit';
import { i18nService } from '@/infrastructure/i18n';
import { MermaidBlock } from './MermaidBlock';
import { AsyncPrismSyntaxHighlighter } from './AsyncPrismSyntaxHighlighter';
import { buildMarkdownPrismStyle } from './markdownPrismTheme';
import { globalAPI, systemAPI, workspaceAPI } from '@/infrastructure/api';
import { getPrismLanguageFromAlias } from '@/infrastructure/language-detection';
import { useAppearance } from '@/infrastructure/appearance';
import { contextMenuController } from '@/shared/context-menu-system/core/ContextMenuController';
import { ContextType, type CustomContext, type MenuItem } from '@/shared/context-menu-system/types';
import { createTab, openCanvasArtifactTab, openFileInBestTarget } from '@/shared/utils/tabUtils';
import { isHtmlFilePath, openHtmlFileInExternalBrowser } from '@/shared/utils/htmlFilePreview';
import { createLogger } from '@/shared/utils/logger';
import type { LineRange } from '@/shared/editor/LineRange';
import { parseCanvasArtifactReference } from '@/shared/utils/canvasArtifactReference';
import {
  isStartupRenderTraceEnabled,
  recordReactRenderProfile,
  startupTrace,
} from '@/shared/utils/startupTrace';
import path from 'path-browserify';
import { getActiveSurfaceScope, onSurfaceActivated, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import './Markdown.scss';
import { useStreamingTextReveal } from './useStreamingTextReveal';
import { SessionMarkdownImage, type SessionImageReader } from './SessionMarkdownImage';
import { rehypeSourceRange, type MarkdownSourceRange } from './rehypeSourceRange';

const log = createLogger('Markdown');
const COMPUTER_LINK_PREFIX = 'computer://';
const FILE_LINK_PREFIX = 'file://';
const CANVAS_LINK_PREFIX = 'openbitfun-canvas://';
const WORKSPACE_FOLDER_PLACEHOLDER = '{{workspaceFolder}}';

const MarkdownMathRenderer = React.lazy(() => import('./MarkdownMathRenderer'));

function markdownUrlTransform(value: string, key?: string): string {
  if (/^openbitfun:\/\/(?:runtime|current-session)\//.test(value)) return value;
  // These references are resolved through the owning host, never by the browser.
  if (/^(computer:\/\/|file:)/i.test(value)) return value;
  if (key === 'src' && /^data:image\/(png|jpeg|gif|webp|bmp|svg\+xml|avif);base64,/i.test(value)) return value;
  if (value.startsWith(CANVAS_LINK_PREFIX) && parseCanvasArtifactReference(value)) {
    return value;
  }
  return defaultUrlTransform(value);
}

// Module-level cache so that all simultaneously-mounting Markdown instances
// (e.g. dozens of history blocks after a workspace switch) share a single
// IPC round-trip for the workspace path. The in-flight deduplication in
// GlobalAPI already coalesces concurrent calls into one; this cache avoids
// even triggering a new IPC call while the result is still fresh.
const workspacePathCache = new Map<string, { path: string | undefined; at: number }>();
const WORKSPACE_PATH_CACHE_MS = 5000;

function translateMarkdownLabel(key: string, options?: Record<string, unknown>): string {
  return i18nService.t(`components:${key}`, options);
}

export interface MarkdownTraceContext {
  turnId?: string;
  roundId?: string;
  itemId?: string;
}

interface MarkdownRenderTraceProps {
  startedAtMs: number;
  contentLength: number;
  hasCodeBlock: boolean;
  hasTable: boolean;
  isStreaming: boolean;
  traceContext?: MarkdownTraceContext;
}

const MarkdownRenderTrace: React.FC<MarkdownRenderTraceProps> = ({
  startedAtMs,
  contentLength,
  hasCodeBlock,
  hasTable,
  isStreaming,
  traceContext,
}) => {
  useLayoutEffect(() => {
    recordReactRenderProfile(startupTrace, {
      component: 'MarkdownRenderer',
      phase: 'commit',
      actualDurationMs: performance.now() - startedAtMs,
      contentLength,
      turnId: traceContext?.turnId,
      roundId: traceContext?.roundId,
      itemId: traceContext?.itemId,
      hasCodeBlock,
      hasTable,
      isStreaming,
    });
  });

  return null;
};

async function getWorkspacePathCached(): Promise<string | undefined> {
  const scope = getActiveSurfaceScope();
  const cached = workspacePathCache.get(scope.surfaceId);
  if (cached && Date.now() - cached.at < WORKSPACE_PATH_CACHE_MS) return cached.path;
  const result = await globalAPI.getCurrentWorkspacePath();
  scope.assertCurrent('resolve markdown workspace');
  workspacePathCache.set(scope.surfaceId, { path: result, at: Date.now() });
  return result;
}

function mayNeedWorkspacePathForMarkdownLinks(content: string): boolean {
  if (!content) {
    return false;
  }

  if (
    content.includes(COMPUTER_LINK_PREFIX) ||
    content.includes(FILE_LINK_PREFIX) ||
    content.includes(WORKSPACE_FOLDER_PLACEHOLDER)
  ) {
    return true;
  }

  const hasMarkdownLinkSyntax = content.includes('](');
  const hasRawAnchorSyntax = content.includes('<a') || content.includes('<A');
  if (!hasMarkdownLinkSyntax && !hasRawAnchorSyntax) {
    return false;
  }

  // Be conservative: false positives only cost one cached workspace lookup,
  // while false negatives could make relative local links display poorly.
  if (
    hasMarkdownLinkSyntax &&
    /!?\[[^\]]+\]\(\s*(?!https?:|mailto:|data:|asset:|tauri:|visualization:|tab:|openbitfun-canvas:|#)[^)]+\)/i.test(content)
  ) {
    return true;
  }

  return hasRawAnchorSyntax &&
    /<a\s+[^>]*href=["']\s*(?!https?:|mailto:|visualization:|tab:|openbitfun-canvas:|#)[^"']+["']/i.test(content);
}

function mayContainMarkdownMath(content: string): boolean {
  if (!content) {
    return false;
  }

  if (content.includes('$$') || content.includes('\\(') || content.includes('\\[')) {
    return true;
  }

  return /(^|[^\\$])\$[^$\n]{1,240}\$(?!\d)/.test(content);
}

/** Catches render errors from react-markdown/remark-gfm (e.g. RegExp in transformGfmAutolinkLiterals) and shows plain text fallback. */
class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallbackContent: string },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    log.error('Markdown render error, showing plain text fallback', { message: error.message });
  }

  componentDidUpdate(prevProps: { fallbackContent: string }) {
    if (prevProps.fallbackContent !== this.props.fallbackContent && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="markdown-renderer markdown-renderer--fallback" style={{ whiteSpace: 'pre-wrap' }} data-openbitfun-component="markdown" data-openbitfun-part="fallback" data-openbitfun-state="fallback">
          {this.props.fallbackContent}
        </div>
      );
    }
    return this.props.children;
  }
}
const LOCAL_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const EDITOR_OPENABLE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyw', 'pyi',
  'rs', 'go', 'java', 'kt', 'kts', 'scala', 'groovy',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'hh',
  'cs', 'rb', 'php', 'swift', 'dart', 'lua', 'r', 'jl',
  'vue', 'svelte',
  'html', 'htm', 'css', 'scss', 'less', 'sass',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml',
  'md', 'mdx', 'rst', 'txt', 'csv', 'tsv', 'pdf',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto',
  'ini', 'cfg', 'conf', 'env', 'lock',
  'gitignore', 'gitattributes', 'editorconfig',
  'log', 'dockerfile', 'makefile', 'mk', 'gradle',
  'properties', 'plist', 'tex', 'mermaid', 'svg',
]);
const EDITOR_OPENABLE_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'cmakelists.txt',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.prettierignore',
  '.eslintrc',
  '.eslintignore',
  '.stylelintrc',
  '.stylelintignore',
  '.babelrc',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  'gemfile',
  'rakefile',
  'podfile',
  'brewfile',
  'justfile',
  'procfile',
  'license',
  'readme',
  'readme.md',
  'readme.txt',
]);

const localImageDataUrlCache = new Map<string, string>();
const localImageRequestCache = new Map<string, Promise<string>>();

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'details', 'summary'],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a || []), 'href', 'title'],
    code: [...(defaultSchema.attributes?.code || []), 'className'],
    div: [...(defaultSchema.attributes?.div || []), 'align'],
    details: [...(defaultSchema.attributes?.details || []), 'open'],
    img: [...(defaultSchema.attributes?.img || []), 'src', 'alt', 'title', 'width', 'height', 'align'],
    input: [...(defaultSchema.attributes?.input || []), 'type', 'checked', 'disabled'],
    p: [...(defaultSchema.attributes?.p || []), 'align'],
    pre: [...(defaultSchema.attributes?.pre || []), 'className'],
    summary: [...(defaultSchema.attributes?.summary || [])],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href || []), 'openbitfun-canvas', 'computer', 'file', 'tab', 'visualization', 'openbitfun'],
    src: [...(defaultSchema.protocols?.src || []), 'asset', 'data', 'http', 'https', 'tauri', 'computer', 'file', 'openbitfun'],
  },
};

function remarkAutolinkInternalLinks() {
  return (tree: any) => {
    visit(tree, 'text', (node: any, index: number | undefined, parent: any) => {
      if (index === undefined || !parent || !Array.isArray(parent.children)) {
        return;
      }

      if (parent.type === 'link' || parent.type === 'linkReference') {
        return;
      }

      const value = node.value;
      if (
        typeof value !== 'string'
        || (
          !value.includes(COMPUTER_LINK_PREFIX)
          && !value.includes(FILE_LINK_PREFIX)
          && !value.includes(CANVAS_LINK_PREFIX)
        )
      ) {
        return;
      }

      const re = /(computer:\/\/|file:\/\/|openbitfun-canvas:\/\/)[^\s<>()]+/g;
      let match: RegExpExecArray | null;
      let lastIndex = 0;
      const nextChildren: any[] = [];

      while ((match = re.exec(value)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const url = match[0];

        if (start > lastIndex) {
          nextChildren.push({
            type: 'text',
            value: value.slice(lastIndex, start)
          });
        }

        nextChildren.push({
          type: 'link',
          url,
          title: null,
          children: [{ type: 'text', value: url }]
        });

        lastIndex = end;
      }

      if (nextChildren.length === 0) {
        return;
      }

      if (lastIndex < value.length) {
        nextChildren.push({
          type: 'text',
          value: value.slice(lastIndex)
        });
      }

      parent.children.splice(index, 1, ...nextChildren);
      return index + nextChildren.length;
    });
  };
}

function normalizeFileLikeHref(rawHref: string): string {
  if (/^openbitfun:\/\/(?:runtime|current-session)\//.test(rawHref)) return rawHref;
  let filePath = rawHref;

  if (rawHref.startsWith(COMPUTER_LINK_PREFIX)) {
    filePath = rawHref.slice(COMPUTER_LINK_PREFIX.length);
  } else if (rawHref.startsWith(FILE_LINK_PREFIX)) {
    filePath = rawHref.slice(FILE_LINK_PREFIX.length);
  } else if (rawHref.startsWith('file:')) {
    filePath = rawHref.slice('file:'.length);
  }

  if (filePath.startsWith(WORKSPACE_FOLDER_PLACEHOLDER)) {
    filePath = filePath.slice(WORKSPACE_FOLDER_PLACEHOLDER.length);
    if (filePath.startsWith('/')) {
      filePath = filePath.slice(1);
    }
  }

  // Normalize URI-style Windows drive paths to native absolute paths.
  if (/^\/[A-Za-z]:[\\/]/.test(filePath)) {
    filePath = filePath.slice(1);
  }

  try {
    return decodeURIComponent(filePath);
  } catch {
    return filePath;
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function normalizeDisplayPath(filePath: string): string {
  const normalized = normalizePath(filePath);

  if (/^[A-Za-z]:\//.test(normalized)) {
    return normalized.replace(/\//g, '\\');
  }

  if (/^\/[A-Za-z]:\//.test(normalized)) {
    return normalized.slice(1).replace(/\//g, '\\');
  }

  return normalized;
}

function isAbsoluteFilesystemPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (/^[A-Za-z]:/.test(normalized) || /^\/[A-Za-z]:/.test(normalized)) {
    return true;
  }

  return normalized.startsWith('/') && !normalized.startsWith('//');
}

function resolveBaseRelativePath(targetPath: string, basePath?: string): string {
  if (/^openbitfun:\/\/(?:runtime|current-session)\//.test(targetPath)) return targetPath;
  if (!targetPath || !basePath || isAbsoluteFilesystemPath(targetPath)) {
    return targetPath;
  }

  const normalizedTarget = normalizePath(targetPath);
  if (normalizedTarget.startsWith('./') || normalizedTarget.startsWith('../')) {
    return path.normalize(path.join(basePath, normalizedTarget));
  }

  return path.normalize(path.join(basePath, normalizedTarget));
}

function resolveDisplayFilePath(targetPath: string, basePath?: string, workspacePath?: string): string {
  const baseResolved = resolveBaseRelativePath(targetPath, basePath);

  if (!baseResolved || isAbsoluteFilesystemPath(baseResolved) || !workspacePath) {
    return normalizeDisplayPath(baseResolved);
  }

  return normalizeDisplayPath(resolveBaseRelativePath(baseResolved, workspacePath));
}

function extractMarkdownLinkHrefFromSource(
  markdownSource: string,
  position?: { start?: { offset?: number }; end?: { offset?: number } },
): string | undefined {
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
    return undefined;
  }

  const snippet = markdownSource.slice(start, end);
  const markerIndex = snippet.indexOf('](');
  if (markerIndex === -1 || !snippet.endsWith(')')) {
    return undefined;
  }

  return snippet.slice(markerIndex + 2, -1);
}

function isLocalAssetPath(src: string): boolean {
  if (!src) {
    return false;
  }

  return !/^(https?:|data:|asset:|tauri:|\/\/)/i.test(src);
}

function normalizeExternalImageSrc(src: string): string {
  const githubBlobMatch = src.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i,
  );

  if (githubBlobMatch) {
    const [, owner, repo, ref, assetPath] = githubBlobMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${assetPath}`;
  }

  return src;
}

function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  const mimeTypes: Record<string, string> = {
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  };

  return mimeTypes[ext || ''] || 'image/jpeg';
}

/** Where an inline image is read from: an ID-owned workspace or, for ID-less callers, a legacy connection. */
interface LocalImageOwner {
  workspaceId?: string;
  remoteConnectionId?: string;
}

function getLocalImageCacheKey(localPath: string, owner: LocalImageOwner, scope: SurfaceScope, access?: ResourceFileAccess | null): string {
  const ownerKey = owner.workspaceId ? `workspace:${owner.workspaceId}` : `legacy:${owner.remoteConnectionId ?? ''}`;
  return scope.key('markdown-image', scope.epoch, access?.scope.surfaceId, ownerKey, localPath);
}

async function getLocalImageDataUrl(
  localPath: string,
  owner: LocalImageOwner,
  scope: SurfaceScope,
  access?: ResourceFileAccess | null,
): Promise<string> {
  const cacheKey = getLocalImageCacheKey(localPath, owner, scope, access);
  const requestKey = cacheKey;
  const cachedDataUrl = localImageDataUrlCache.get(cacheKey);
  if (cachedDataUrl) {
    return cachedDataUrl;
  }

  const pendingRequest = localImageRequestCache.get(requestKey);
  if (pendingRequest) {
    return pendingRequest;
  }

  const request = (async () => {
    const base64Content = access ? await access.files.readFileContent(localPath, 'base64')
      : owner.workspaceId ? await workspaceAPI.readWorkspaceFile(owner.workspaceId, localPath, 'base64')
      : await workspaceAPI.readFileContent(localPath, 'base64', owner.remoteConnectionId);
    scope.assertCurrent('read markdown image');
    const dataUrl = `data:${getMimeType(localPath)};base64,${base64Content}`;
    localImageDataUrlCache.set(cacheKey, dataUrl);
    localImageRequestCache.delete(requestKey);
    return dataUrl;
  })().catch((error) => {
    localImageRequestCache.delete(requestKey);
    throw error;
  });

  localImageRequestCache.set(requestKey, request);
  return request;
}

interface MarkdownImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  basePath?: string;
  /** Owning workspace ID; authoritative for the read when present. */
  workspaceId?: string;
  /** Legacy owner selector for renderers without a workspace ID. */
  remoteConnectionId?: string;
}

const ScopedMarkdownImage: React.FC<MarkdownImageProps & { scope: SurfaceScope }> = ({
  scope,
  src,
  alt,
  className,
  basePath,
  workspaceId,
  remoteConnectionId,
  onLoad,
  onError,
  ...imgProps
}) => {
  const fileAccess = useResourceFileAccess();
  const ownerWorkspaceId = fileAccess ? fileAccess.scope.workspaceId : workspaceId;
  const connectionId = fileAccess ? fileAccess.scope.remoteConnectionId : remoteConnectionId;
  const owner = useMemo<LocalImageOwner>(
    () => ({ workspaceId: ownerWorkspaceId, remoteConnectionId: connectionId }),
    [ownerWorkspaceId, connectionId],
  );
  const rawSrc = typeof src === 'string' ? normalizeExternalImageSrc(src) : '';
  const localPath = useMemo(() => {
    if (!rawSrc || !isLocalAssetPath(rawSrc)) {
      return null;
    }

    return resolveBaseRelativePath(normalizeFileLikeHref(rawSrc), basePath);
  }, [basePath, rawSrc]);
  const cacheKey = localPath
    ? getLocalImageCacheKey(localPath, owner, scope, fileAccess)
    : null;
  const [resolvedSrc, setResolvedSrc] = useState(() => {
    if (!rawSrc) {
      return '';
    }

    if (!localPath || !cacheKey) {
      return rawSrc;
    }

    return localImageDataUrlCache.get(cacheKey) || LOCAL_IMAGE_PLACEHOLDER;
  });
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>(
    rawSrc ? 'loading' : 'error',
  );

  useEffect(() => {
    if (!rawSrc) {
      setResolvedSrc('');
      setLoadState('error');
      return;
    }

    if (!localPath || !cacheKey) {
      setResolvedSrc(rawSrc);
      setLoadState('loading');
      return;
    }

    const cachedDataUrl = localImageDataUrlCache.get(cacheKey);
    if (cachedDataUrl) {
      setResolvedSrc(cachedDataUrl);
      setLoadState('loading');
      return;
    }

    let cancelled = false;
    setResolvedSrc(LOCAL_IMAGE_PLACEHOLDER);
    setLoadState('loading');

    void getLocalImageDataUrl(localPath, owner, scope, fileAccess)
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }

        setResolvedSrc(dataUrl);
        // Wait for the browser's load event before considering the decoded
        // image ready. A successful filesystem read does not prove the bytes
        // are a displayable image.
        setLoadState('loading');
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        log.error('Failed to load local markdown image', {
          path: localPath,
          workspaceId: owner.workspaceId,
          remoteConnectionId: owner.remoteConnectionId,
          error,
        });
        // Never hand a failed local path back to the browser. That produces a
        // native broken-image glyph and retries the invalid source whenever
        // the surrounding Markdown is reconciled.
        setResolvedSrc('');
        setLoadState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, localPath, rawSrc, owner, fileAccess, scope]);

  if (loadState === 'error') {
    return (
      <span
        className="markdown-image-fallback"
        data-openbitfun-component="markdown"
        data-openbitfun-part="imageFallback"
        title={typeof alt === 'string' && alt ? alt : undefined}
      >
        {typeof alt === 'string' ? alt : null}
      </span>
    );
  }

  return (
    <img
      {...imgProps}
      alt={alt}
      className={[
        className,
        loadState === 'loading' ? 'markdown-image markdown-image--loading' : '',
      ].filter(Boolean).join(' ')}
      loading="lazy"
      src={resolvedSrc}
      onLoad={(event) => {
        if (resolvedSrc !== LOCAL_IMAGE_PLACEHOLDER) {
          setLoadState('loaded');
        }
        onLoad?.(event);
      }}
      onError={(event) => {
        setLoadState('error');
        onError?.(event);
      }}
    />
  );
};

const MarkdownImage: React.FC<MarkdownImageProps> = (props) => {
  const fileAccess = useResourceFileAccess();
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  // Reset before paint when the source or host changes; old pixels must not
  // survive for one render while an effect starts the new read.
  return <ScopedMarkdownImage key={JSON.stringify([scope.epoch, props.src, props.basePath, props.workspaceId, props.remoteConnectionId, fileAccess?.scope.surfaceId, fileAccess?.scope.workspaceId, fileAccess?.scope.remoteConnectionId, fileAccess?.scope.workspacePath])} {...props} scope={scope} />;
};

function isEditorOpenableFilePath(filePath: string): boolean {
  const normalizedPath = filePath.trim().replace(/[?#].*$/, '');
  const fileName = normalizedPath.split(/[\\/]/).pop()?.toLowerCase() || '';

  if (!fileName) {
    return false;
  }

  if (EDITOR_OPENABLE_BASENAMES.has(fileName)) {
    return true;
  }

  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx <= 0) {
    return false;
  }

  return EDITOR_OPENABLE_EXTENSIONS.has(fileName.slice(dotIdx + 1));
}

/** Human-readable label for Prism language ids (code block toolbar). */
function formatCodeLanguageLabel(lang: string): string {
  if (!lang) return 'Text';
  const key = lang.toLowerCase();
  const aliases: Record<string, string> = {
    js: 'JavaScript',
    jsx: 'JavaScript',
    mjs: 'JavaScript',
    cjs: 'JavaScript',
    ts: 'TypeScript',
    tsx: 'TSX',
    py: 'Python',
    rs: 'Rust',
    go: 'Go',
    rb: 'Ruby',
    sh: 'Shell',
    bash: 'Bash',
    zsh: 'Zsh',
    fish: 'Fish',
    md: 'Markdown',
    yml: 'YAML',
    yaml: 'YAML',
    json: 'JSON',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    sass: 'Sass',
    less: 'Less',
    cpp: 'C++',
    cxx: 'C++',
    hpp: 'C++',
    hxx: 'C++',
    cc: 'C++',
    c: 'C',
    cs: 'C#',
    fs: 'F#',
    swift: 'Swift',
    kt: 'Kotlin',
    java: 'Java',
    sql: 'SQL',
    graphql: 'GraphQL',
    dockerfile: 'Dockerfile',
    makefile: 'Makefile',
    toml: 'TOML',
    xml: 'XML',
    rust: 'Rust',
    typescript: 'TypeScript',
    javascript: 'JavaScript',
  };
  if (aliases[key]) return aliases[key];
  const raw = lang.replace(/[_-]/g, ' ');
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

export interface FlowCodeBlockFallbackProps {
  code: string;
  language: string;
  bodyStyle: React.CSSProperties;
  codeTagStyle: React.CSSProperties;
  gutterColor: string;
}

/**
 * Lightweight, stable line-numbered code renderer used while the surrounding
 * markdown is still streaming. Its layout deliberately matches the
 * `react-syntax-highlighter` `showLineNumbers` output: a fixed-width inline
 * line-number column followed by the line content, separated visually by the
 * same padding. This keeps the code block from visibly jumping when streaming
 * completes and the heavy Prism highlighter takes over.
 */
const CodeBlockFallback: React.FC<FlowCodeBlockFallbackProps> = ({
  code,
  language,
  bodyStyle,
  codeTagStyle,
  gutterColor,
}) => {
  const lineCount = code.length === 0 ? 1 : code.split('\n').length;
  let gutterText = '';
  for (let i = 1; i <= lineCount; i++) {
    gutterText += i === lineCount ? `${i}` : `${i}\n`;
  }

  return (
    <pre
      className={`language-${language} code-block-fallback code-block-fallback--linenumbers`}
      style={bodyStyle}
      data-openbitfun-component="markdown"
      data-openbitfun-part="codePre"
    >
      <code
        style={{ ...codeTagStyle, display: 'flex' }}
        data-openbitfun-component="markdown"
        data-openbitfun-part="codeContent"
      >
        <span
          aria-hidden="true"
          style={{
            flex: 'none',
            display: 'block',
            minWidth: '3em',
            paddingRight: '1em',
            textAlign: 'right',
            color: gutterColor,
            userSelect: 'none',
            whiteSpace: 'pre',
          }}
        >
          {gutterText}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            display: 'block',
            whiteSpace: 'pre',
          }}
        >
          {code}
        </span>
      </code>
    </pre>
  );
};

const CopyButton: React.FC<{ code: string }> = ({ code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      log.warn('Failed to copy code', { error });
    }
  };

  return (
    <button 
      className={`copy-button${copied ? ' copy-success' : ''}`}
      onClick={handleCopy}
      title={copied ? translateMarkdownLabel('markdown.copySuccess') : translateMarkdownLabel('markdown.copyCode')}
    >
      {copied ? (
        <LucideCheck width="16" height="16" stroke="currentColor" aria-hidden="true" />
      ) : (
        <LucideCopy width="16" height="16" stroke="currentColor" aria-hidden="true" />
      )}
    </button>
  );
};

export interface MarkdownRendererProps {
  content: string;
  /** Display a region while resolving Markdown references against all content. */
  sourceRange?: MarkdownSourceRange;
  /** Owning workspace ID; content opened from links is routed by it. `basePath` is only the IO root. */
  workspaceId?: string;
  basePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  className?: string;
  isStreaming?: boolean;
  expandDetailsByDefault?: boolean;
  onOpenVisualization?: (visualization: any) => void;
  onFileViewRequest?: (filePath: string, fileName: string, lineRange?: LineRange) => void;
  /** File IO belongs to the supplied callback; host explorer/browser actions are unavailable. */
  fileActionsViaCallbackOnly?: boolean;
  onImageRead?: SessionImageReader;
  onFileDownload?: (path: string) => Promise<void>;
  onTabOpen?: (tabInfo: any) => void;
  onHttpLinkClick?: (url: string, event: React.MouseEvent<HTMLAnchorElement>) => boolean | void;
  traceContext?: MarkdownTraceContext;
}

function useLiveValueRef<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export const MarkdownRenderer = React.memo<MarkdownRendererProps>(({
  content, 
  sourceRange,
  workspaceId,
  basePath,
  remoteConnectionId,
  remoteSshHost,
  className = '',
  isStreaming = false,
  expandDetailsByDefault = false,
  onOpenVisualization,
  onFileViewRequest,
  fileActionsViaCallbackOnly = false,
  onImageRead,
  onFileDownload,
  onTabOpen,
  onHttpLinkClick,
  traceContext,
}) => {
  const fileAccess = useResourceFileAccess();
  const fileAccessRef = useLiveValueRef(fileAccess);
  const { current: appearance } = useAppearance();
  const isLight = appearance?.mode === 'light';
  const surfaceScope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [resolvedWorkspace, setResolvedWorkspace] = useState<{ epoch: number; path: string } | null>(null);
  const currentWorkspacePath = resolvedWorkspace?.epoch === surfaceScope.epoch ? resolvedWorkspace.path : '';
  // Keep streaming flag out of `components` memo deps so flipping streaming
  // mode does not rebuild the entire ReactMarkdown component map (that remount
  // looked like the chat pane refreshed when a turn finished).
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const basePathRef = useLiveValueRef(basePath);
  const remoteConnectionIdRef = useLiveValueRef(fileAccess ? fileAccess.scope.remoteConnectionId : remoteConnectionId);
  const remoteSshHostRef = useLiveValueRef(remoteSshHost);
  const workspaceIdRef = useLiveValueRef(fileAccess ? fileAccess.scope.workspaceId : workspaceId);
  const currentWorkspacePathRef = useLiveValueRef(fileAccess?.scope.workspacePath ?? currentWorkspacePath);
  const expandDetailsByDefaultRef = useLiveValueRef(expandDetailsByDefault);
  const onOpenVisualizationRef = useLiveValueRef(onOpenVisualization);
  const onFileViewRequestRef = useLiveValueRef(onFileViewRequest);
  const fileActionsViaCallbackOnlyRef = useLiveValueRef(fileActionsViaCallbackOnly);
  const onImageReadRef = useLiveValueRef(onImageRead);
  const onFileDownloadRef = useLiveValueRef(onFileDownload);
  const onTabOpenRef = useLiveValueRef(onTabOpen);
  const onHttpLinkClickRef = useLiveValueRef(onHttpLinkClick);
  const traceContextRef = useLiveValueRef(traceContext);
  const sourceRangeRef = useLiveValueRef(sourceRange);
  
  const syntaxTheme = useMemo(() => buildMarkdownPrismStyle(isLight), [isLight]);
  const syntaxThemeRef = useLiveValueRef(syntaxTheme);
  const isLightRef = useLiveValueRef(isLight);
  
  const contentStr = typeof content === 'string' ? content : String(content || '');
  const renderTraceEnabled = isStartupRenderTraceEnabled();
  const renderTraceStartedAtMs = renderTraceEnabled ? performance.now() : null;

  const markdownContent = useMemo(() => {
    let body = contentStr;
    // While streaming, the model may emit an opening ```lang fence long before
    // the closing ```. react-markdown then flips between parsing the tail as a
    // paragraph (raw text) and as a fenced code block as more tokens arrive,
    // which unmounts/remounts the code block and shifts its position every
    // tick. Append a synthetic closing fence so the AST stays a stable code
    // block from the moment the opening fence appears.
    if (isStreaming) {
      const fenceMatches = body.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm);
      if (fenceMatches && fenceMatches.length % 2 === 1) {
        const lastFence = fenceMatches[fenceMatches.length - 1].trim();
        const needsLeadingNewline = !body.endsWith('\n');
        body = `${body}${needsLeadingNewline ? '\n' : ''}${lastFence}`;
      }
    }

    return body;
  }, [contentStr, isStreaming]);
  const markdownContentRef = useLiveValueRef(markdownContent);

  const needsWorkspacePathForLinks = useMemo(
    () => mayNeedWorkspacePathForMarkdownLinks(markdownContent),
    [markdownContent],
  );

  useEffect(() => {
    if (fileActionsViaCallbackOnly || !needsWorkspacePathForLinks || currentWorkspacePath || basePath) {
      return;
    }

    let cancelled = false;

    void getWorkspacePathCached()
      .then((workspacePath) => {
        if (!cancelled && workspacePath) {
          setResolvedWorkspace({ epoch: surfaceScope.epoch, path: workspacePath });
        }
      })
      .catch((error) => {
        log.warn('Failed to resolve workspace path for markdown links', { error });
      });

    return () => {
      cancelled = true;
    };
  }, [basePath, currentWorkspacePath, fileActionsViaCallbackOnly, needsWorkspacePathForLinks, surfaceScope]);

  const markdownFeatureProfile = useMemo(() => ({
    contentLength: markdownContent.length,
    hasCodeBlock: /^[ \t]{0,3}(`{3,}|~{3,})/m.test(markdownContent),
    hasTable: /^[ \t]*\|.+\|[ \t]*$/m.test(markdownContent),
  }), [markdownContent]);
  const shouldUseMathRenderer = useMemo(
    () => mayContainMarkdownMath(markdownContent),
    [markdownContent],
  );

  // Parse line ranges like #L42 / 1-20
  const parseLineRange = useCallback((hash: string): LineRange | undefined => {
    const cleanHash = hash.replace(/^#/, '');

    const lineMatchWithL = cleanHash.match(/^L(\d+)(?:-L?(\d+))?$/i);
    if (lineMatchWithL) {
      const start = parseInt(lineMatchWithL[1], 10);
      const end = lineMatchWithL[2] ? parseInt(lineMatchWithL[2], 10) : undefined;
      return { start, end };
    }

    const lineMatchWithoutL = cleanHash.match(/^(\d+)(?:-(\d+))?$/);
    if (lineMatchWithoutL) {
      const start = parseInt(lineMatchWithoutL[1], 10);
      const end = lineMatchWithoutL[2] ? parseInt(lineMatchWithoutL[2], 10) : undefined;
      return { start, end };
    }

    return undefined;
  }, []);

  const handleFileViewRequest = useCallback((filePath: string, fileName: string, lineRange?: LineRange) => {
    if (onFileViewRequestRef.current) onFileViewRequestRef.current(filePath, fileName, lineRange);
    else if (fileAccessRef.current) openFileInBestTarget({ filePath, fileName, jumpToRange: lineRange, scope: fileAccessRef.current.scope });
  }, [onFileViewRequestRef, fileAccessRef]);

  const handleOpenVisualization = useCallback((visualization: any) => {
    onOpenVisualizationRef.current?.(visualization);
  }, [onOpenVisualizationRef]);

  const handleTabOpen = useCallback((tabInfo: any) => {
    onTabOpenRef.current?.(tabInfo);
  }, [onTabOpenRef]);

  const handleRevealInExplorer = useCallback(async (filePath: string) => {
    if (fileActionsViaCallbackOnlyRef.current) return;
    const latestBasePath = basePathRef.current;
    const latestWorkspacePath = currentWorkspacePathRef.current;
    let targetPath = resolveDisplayFilePath(filePath, latestBasePath, latestWorkspacePath);
    try {
      if (!isAbsoluteFilesystemPath(targetPath)) {
        const workspacePath = await globalAPI.getCurrentWorkspacePath();
        targetPath = resolveDisplayFilePath(
          filePath,
          latestBasePath,
          workspacePath || latestWorkspacePath,
        );
      }

      await workspaceAPI.revealInExplorer(targetPath);
    } catch (error) {
      log.error('Failed to reveal file in explorer', { filePath: targetPath, error });
    }
  }, [basePathRef, currentWorkspacePathRef, fileActionsViaCallbackOnlyRef]);

  const showLinkContextMenu = useCallback((
    event: React.MouseEvent<HTMLElement>,
    items: MenuItem[],
    customType: string,
    data: Record<string, unknown>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();

    const position = { x: event.clientX, y: event.clientY };
    const context: CustomContext = {
      type: ContextType.CUSTOM,
      customType,
      data,
      event: event.nativeEvent,
      targetElement: event.currentTarget,
      position,
      timestamp: Date.now(),
    };

    void contextMenuController.show(position, items, context);
  }, []);

  const canOpenInBuiltInBrowser = useCallback((targetElement: HTMLElement | null): boolean => {
    if (typeof window === 'undefined' || !targetElement) {
      return false;
    }

    return Boolean(
      targetElement.closest('.openbitfun-session-scene') &&
      targetElement.closest('.modern-flowchat-container, .flow-chat-container')
    );
  }, []);

  const handleCopyLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch (error) {
      log.warn('Failed to copy markdown link', { url, error });
    }
  }, []);

  const handleOpenExternalLink = useCallback(async (url: string) => {
    try {
      await systemAPI.openExternal(url);
    } catch (error) {
      log.error('Failed to open external URL', { url, error });
    }
  }, []);

  const handleOpenBuiltInBrowserLink = useCallback((url: string) => {
    if (typeof window === 'undefined') {
      return;
    }

    const duplicateCheckKey = `browser-panel:${url}`;
    createTab({
      type: 'browser',
      title: translateMarkdownLabel('markdown.openInBuiltInBrowser'),
      data: { url },
      metadata: { duplicateCheckKey },
      checkDuplicate: true,
      duplicateCheckKey,
      replaceExisting: false,
      mode: 'agent',
    });
  }, []);

  const handleLocalFileContextMenu = useCallback((
    event: React.MouseEvent<HTMLElement>,
    filePath: string,
    displayPath: string,
    fileName: string,
    lineRange?: LineRange,
  ) => {
    const items: MenuItem[] = [];
    const isHtmlFile = isHtmlFilePath(filePath) && canOpenInBuiltInBrowser(event.currentTarget);

    if (fileActionsViaCallbackOnlyRef.current) {
      items.push({
        id: 'markdown-open-remote-file',
        label: i18nService.t('common:actions.open'),
        icon: 'FileText',
        onClick: () => handleFileViewRequest(filePath, fileName, lineRange),
      });
      if (onFileDownloadRef.current) items.push({
        id: 'markdown-download-remote-file',
        label: i18nService.t('common:actions.download'),
        icon: 'Download',
        onClick: () => { void onFileDownloadRef.current?.(filePath).catch(() => {}); },
      });
    } else if (isHtmlFile) {
      const workspacePath = currentWorkspacePathRef.current || basePathRef.current;
      const remoteConnectionId = remoteConnectionIdRef.current;
      const openFileOptions = {
        filePath,
        fileName,
        workspaceId: workspaceIdRef.current,
        workspacePath,
        remoteConnectionId,
      };

      items.push(
        {
          id: 'markdown-open-html-as-text',
          label: i18nService.t('common:actions.open'),
          icon: 'FileText',
          onClick: () => openFileInBestTarget({
            ...openFileOptions,
            editorType: 'code-editor',
            jumpToRange: lineRange,
          }),
        },
        {
          id: 'markdown-open-html-in-integrated-browser',
          label: i18nService.t('common:file.openInIntegratedBrowser'),
          icon: 'PanelRightOpen',
          onClick: () => openFileInBestTarget({
            ...openFileOptions,
            editorType: 'html-preview',
          }),
        },
        {
          id: 'markdown-open-html-in-system-browser',
          label: i18nService.t('common:file.openInSystemBrowser'),
          icon: 'ExternalLink',
          disabled: Boolean(remoteConnectionId),
          onClick: () => {
            if (remoteConnectionId) return;
            void openHtmlFileInExternalBrowser(displayPath || filePath);
          },
        },
      );
    }

    items.push(
      {
        id: 'markdown-open-in-explorer',
        label: translateMarkdownLabel('markdown.openInExplorer'),
        icon: 'FolderOpen',
        disabled: fileActionsViaCallbackOnlyRef.current,
        onClick: () => handleRevealInExplorer(displayPath || filePath),
      },
      {
        id: 'markdown-copy-file-path',
        label: translateMarkdownLabel('markdown.copyFilePath'),
        icon: 'Copy',
        onClick: () => void handleCopyLink(displayPath || filePath),
      },
    );

    showLinkContextMenu(event, items, 'markdown-local-file-link', {
      filePath,
      displayPath,
    });
  }, [
    basePathRef,
    canOpenInBuiltInBrowser,
    currentWorkspacePathRef,
    handleRevealInExplorer,
    handleFileViewRequest,
    fileActionsViaCallbackOnlyRef,
    onFileDownloadRef,
    handleCopyLink,
    remoteConnectionIdRef,
    workspaceIdRef,
    showLinkContextMenu,
  ]);

  const handleWebLinkContextMenu = useCallback((event: React.MouseEvent<HTMLElement>, url: string) => {
    const targetElement = event.currentTarget;
    const items: MenuItem[] = [];

    if (canOpenInBuiltInBrowser(targetElement)) {
      items.push({
        id: 'markdown-open-in-built-in-browser',
        label: translateMarkdownLabel('markdown.openInBuiltInBrowser'),
        icon: 'PanelRightOpen',
        onClick: () => handleOpenBuiltInBrowserLink(url),
      });
    }

    items.push(
      {
        id: 'markdown-open-in-browser',
        label: translateMarkdownLabel('markdown.openInBrowser'),
        icon: 'ExternalLink',
        onClick: () => void handleOpenExternalLink(url),
      },
      {
        id: 'markdown-copy-link',
        label: translateMarkdownLabel('markdown.copyLink'),
        icon: 'Copy',
        onClick: () => void handleCopyLink(url),
      },
    );

    showLinkContextMenu(event, items, 'markdown-web-link', { url });
  }, [
    canOpenInBuiltInBrowser,
    handleCopyLink,
    handleOpenBuiltInBrowserLink,
    handleOpenExternalLink,
    showLinkContextMenu,
  ]);
  
  /**
   * Keep renderer component identities stable while Markdown content streams.
   *
   * React treats each function in this map as a component type. Rebuilding the
   * map for every chunk remounts all existing custom-rendered nodes, including
   * images and every paragraph below them. Values that must stay current are
   * read from live refs when react-markdown invokes the stable renderers.
   */
  const components = useMemo(() => ({
    code({ node: _node, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const language = match ? match[1] : '';
      const code = String(children).replace(/\n$/, '');
      
      const hasMultipleLines = code.includes('\n');
      const isCodeBlock = className?.startsWith('language-') || hasMultipleLines;
      
      if (!isCodeBlock) {
        return (
          <code className="inline-code" {...props}>
            {children}
          </code>
        );
      }
      
      const streaming = isStreamingRef.current;

      if (language.toLowerCase().startsWith('mermaid')) {
        return (
          <MermaidBlock
            code={code}
            isStreaming={streaming}
          />
        );
      }
      
      const normalizedLang = getPrismLanguageFromAlias(language);
      const codeBodyStyle: React.CSSProperties = {
        margin: 0,
        borderRadius: '0 0 8px 8px',
        fontSize: 'var(--openbitfun-type-code-md-font-size)',
        lineHeight: 'var(--openbitfun-type-code-md-line-height)',
      };
      const codeTagStyle: React.CSSProperties = {
        fontFamily: 'var(--openbitfun-type-code-md-font-family)',
        fontWeight: 'var(--openbitfun-type-code-md-font-weight)',
      };
      const gutterColor = isLightRef.current
        ? 'color-mix(in srgb, var(--openbitfun-color-content-on-light) 40%, var(--openbitfun-color-content-on-dark))'
        : 'color-mix(in srgb, var(--openbitfun-color-content-on-dark) 40%, var(--openbitfun-color-content-on-light))';

      return (
        <div className={`code-block-wrapper${hasMultipleLines ? '' : ' code-block-wrapper--single-line'}`} data-openbitfun-component="markdown" data-openbitfun-part="codeBlock" data-openbitfun-state={streaming ? 'streaming' : undefined}>
          <div className="code-block-toolbar" data-openbitfun-component="markdown" data-openbitfun-part="codeToolbar">
            <span className="code-block-lang">{formatCodeLanguageLabel(normalizedLang)}</span>
            <CopyButton code={code} />
          </div>
          <div className="code-block-body" data-openbitfun-component="markdown" data-openbitfun-part="codeBody">
            {/*
              Always mount AsyncPrismSyntaxHighlighter. While streaming,
              preferFallback keeps the lightweight line-numbered pre so we do
              not remount Fallback ↔ Prism when the turn finishes (that remount
              flashed the chat pane).
            */}
            <AsyncPrismSyntaxHighlighter
              language={normalizedLang}
              style={syntaxThemeRef.current}
              showLineNumbers={true}
              customStyle={codeBodyStyle}
              codeTagProps={{ style: codeTagStyle }}
              lineNumberStyle={{
                color: gutterColor,
                paddingRight: '1em',
                textAlign: 'right',
                userSelect: 'none',
                minWidth: '3em'
              }}
              preferFallback={streaming}
              fallback={CodeBlockFallback}
              fallbackProps={{
                code,
                language: normalizedLang,
                bodyStyle: codeBodyStyle,
                codeTagStyle,
                gutterColor,
              }}
              traceContext={traceContextRef.current}
            >
              {code}
            </AsyncPrismSyntaxHighlighter>
          </div>
        </div>
      );
    },
    
    a({ node, href, children, ...props }: any) {
      const hrefValue = href || node?.properties?.href || extractMarkdownLinkHrefFromSource(
        markdownContentRef.current,
        node?.position,
      );
      const isHashLink = typeof hrefValue === 'string' && hrefValue.startsWith('#');
      const isVisualizationLink = typeof hrefValue === 'string' && hrefValue.startsWith('visualization:');
      const isTabLink = typeof hrefValue === 'string' && hrefValue.startsWith('tab:');
      const isCanvasLink = typeof hrefValue === 'string' && hrefValue.startsWith(CANVAS_LINK_PREFIX);
      const isHttpLink = typeof hrefValue === 'string' &&
        (hrefValue.startsWith('http://') || hrefValue.startsWith('https://'));
      const isMailtoLink = typeof hrefValue === 'string' && hrefValue.startsWith('mailto:');

      if (typeof hrefValue === 'string' && !isVisualizationLink && !isTabLink && !isCanvasLink && !isHttpLink && !isMailtoLink && !isHashLink) {
        let filePath = normalizeFileLikeHref(hrefValue);

        let lineRange: LineRange | undefined;

        const hashIndex = filePath.indexOf('#');
        if (hashIndex !== -1) {
          const hash = filePath.substring(hashIndex);
          filePath = filePath.substring(0, hashIndex);
          lineRange = parseLineRange(hash);
        } else {
          // Note: exclude Windows drive letters (e.g. C:)
          const colonMatch = filePath.match(/^(.+?):(\d+)(?:-(\d+))?$/);
          if (colonMatch) {
            const [, pathBeforeColon, startLine, endLine] = colonMatch;
            const isWindowsDrive = /^[A-Za-z]:$/.test(pathBeforeColon);

            if (!isWindowsDrive) {
              filePath = pathBeforeColon;
              lineRange = {
                start: parseInt(startLine, 10),
                end: endLine ? parseInt(endLine, 10) : undefined
              };
            }
          }
        }

        if (!fileActionsViaCallbackOnlyRef.current) filePath = resolveBaseRelativePath(filePath, basePathRef.current);
        const displayFilePath = resolveDisplayFilePath(
          filePath,
          undefined,
          currentWorkspacePathRef.current,
        );

        const fileName = filePath.split(/[\\/]/).pop() || filePath;

        const isFolder = filePath.endsWith('/');
        const editorOpenable = isEditorOpenableFilePath(filePath);
        const shouldRevealInExplorer = !editorOpenable;
        if (!isFolder) {
          const fileLinkButton = (
            <button
              className="file-link"
              data-openbitfun-component="markdown"
              data-openbitfun-part="fileLink"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (shouldRevealInExplorer && !fileActionsViaCallbackOnlyRef.current) {
                  void handleRevealInExplorer(displayFilePath || filePath);
                  return;
                }
                handleFileViewRequest(filePath, fileName, lineRange);
              }}
              onContextMenu={(e) => handleLocalFileContextMenu(
                e,
                filePath,
                displayFilePath,
                fileName,
                lineRange,
              )}
              type="button"
              style={{
                cursor: 'pointer',
                textDecoration: 'underline',
                background: 'none',
                border: 'none',
                font: 'inherit'
              }}
            >
              {children}
            </button>
          );

          return (
            <Tooltip
              content={<span className="markdown-link-path-tooltip">{displayFilePath || filePath}</span>}
              placement="top"
              delay={300}
            >
              {fileLinkButton}
            </Tooltip>
          );
        }
      }

      if (isCanvasLink && typeof hrefValue === 'string') {
        return (
          <button
            className="canvas-link"
            data-openbitfun-component="markdown"
            data-openbitfun-part="canvasLink"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const opened = openCanvasArtifactTab({
                artifactReference: hrefValue,
                workspaceId: workspaceIdRef.current,
                workspacePath: basePathRef.current || currentWorkspacePathRef.current || undefined,
                remoteConnectionId: remoteConnectionIdRef.current,
                remoteSshHost: remoteSshHostRef.current,
                sourceMetadata: { type: 'markdown-link' },
                metadata: { fromMarkdown: true },
              });
              if (!opened) {
                log.warn('Ignored invalid Canvas artifact link', { artifactReference: hrefValue });
              }
            }}
            type="button"
            style={{
              cursor: 'pointer',
              textDecoration: 'underline',
              background: 'none',
              border: 'none',
              font: 'inherit',
            }}
          >
            {children}
          </button>
        );
      }
      
      if (isVisualizationLink && typeof hrefValue === 'string') {
        const vizData = hrefValue.replace('visualization:', '');
        
        return (
          <button
            className="visualization-link"
            data-openbitfun-component="markdown"
            data-openbitfun-part="visualizationLink"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              try {
                const visualization = JSON.parse(decodeURIComponent(vizData));
                handleOpenVisualization(visualization);
              } catch (error) {
                log.error('Failed to parse visualization data', { error });
              }
            }}
            type="button"
          >
            {children}
          </button>
        );
      }
      
      if (isTabLink && typeof hrefValue === 'string') {
        const tabData = hrefValue.replace('tab:', '');
        
        return (
          <button
            className="tab-link"
            data-openbitfun-component="markdown"
            data-openbitfun-part="tabLink"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              try {
                const tabInfo = JSON.parse(decodeURIComponent(tabData));
                handleTabOpen(tabInfo);
              } catch (error) {
                log.error('Failed to parse tab data', { error });
              }
            }}
            type="button"
            style={{ 
              cursor: 'pointer',
              textDecoration: 'underline',
              background: 'none',
              border: 'none',
              font: 'inherit'
            }}
          >
            {children}
          </button>
        );
      }
      
      if (isHttpLink && typeof hrefValue === 'string') {
        return (
          <a 
            href={hrefValue} 
            {...props}
            onClick={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (onHttpLinkClickRef.current?.(hrefValue, e)) {
                return;
              }
              const hasExternalOpenModifier = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
              if (canOpenInBuiltInBrowser(e.currentTarget) && !hasExternalOpenModifier) {
                handleOpenBuiltInBrowserLink(hrefValue);
                return;
              }
              try {
                await systemAPI.openExternal(hrefValue);
              } catch (error) {
                log.error('Failed to open external URL', { url: hrefValue, error });
              }
            }}
            onContextMenu={(e) => handleWebLinkContextMenu(e, hrefValue)}
            style={{ cursor: 'pointer', textDecoration: 'underline' }}
          >
            {children}
          </a>
        );
      }

      if (isMailtoLink && typeof hrefValue === 'string') {
        return (
          <a href={hrefValue} {...props}>
            {children}
          </a>
        );
      }
      
      return (
        <a 
          href={typeof hrefValue === 'string' ? hrefValue : undefined} 
          {...props}
          onClick={(e) => {
            e.preventDefault();
            if (isHashLink && sourceRangeRef.current) {
              const target = document.getElementById(hrefValue.slice(1));
              target?.scrollIntoView({ block: 'nearest' });
              target?.focus({ preventScroll: true });
            }
          }}
          style={{ cursor: 'pointer' }}
        >
          {children}
        </a>
      );
    },
    
    table({ children }: any) {
      return (
        <div className="table-wrapper" data-openbitfun-component="markdown" data-openbitfun-part="table">
          <table>{children}</table>
        </div>
      );
    },

    details({ children, open, ...props }: any) {
      return (
        <details {...props} open={open ?? expandDetailsByDefaultRef.current}>
          {children}
        </details>
      );
    },

    img({ node: _node, ...props }: any) {
      if (onImageReadRef.current && isLocalAssetPath(props.src || '')) {
        return <SessionMarkdownImage path={normalizeFileLikeHref(props.src)} alt={props.alt} title={props.title}
          read={onImageReadRef.current} download={onFileDownloadRef.current} />;
      }
      // Dispatch observers have no local filesystem ownership. Do not mount
      // MarkdownImage here: even its initial state can reuse controller bytes
      // from the local image cache before its read effect runs.
      if (fileActionsViaCallbackOnlyRef.current && !/^(https?:|data:)/i.test(props.src || '')) {
        const label = translateMarkdownLabel('markdown.remoteImageUnavailable');
        return (
          <span
            className="markdown-image-fallback"
            data-openbitfun-component="markdown"
            data-openbitfun-part="imageFallback"
            title={label}
          >
            {props.alt ? `${props.alt} — ${label}` : label}
          </span>
        );
      }
      return (
        <MarkdownImage
          {...props}
          basePath={basePathRef.current || currentWorkspacePathRef.current}
          workspaceId={workspaceIdRef.current}
          remoteConnectionId={remoteConnectionIdRef.current}
        />
      );
    },
    
    blockquote({ children }: any) {
      return <blockquote className="custom-blockquote" data-openbitfun-component="markdown" data-openbitfun-part="blockquote">{children}</blockquote>;
    },
    
    ul({ children, ...props }: any) {
      return <ul {...props}>{children}</ul>;
    },
    
    ol({ children, ...props }: any) {
      return <ol {...props}>{children}</ol>;
    },
    
    li({ children, ...props }: any) {
      return <li {...props}>{children}</li>;
    },
    
    p({ children, align, style, ...props }: any) {
      return (
        <p
          {...props}
          style={align ? { ...style, textAlign: align } : style}
        >
          {children}
        </p>
      );
    }
  }), [
    onFileDownloadRef,
    onImageReadRef,
    handleFileViewRequest,
    handleRevealInExplorer,
    handleLocalFileContextMenu,
    handleWebLinkContextMenu,
    canOpenInBuiltInBrowser,
    handleOpenBuiltInBrowserLink,
    handleOpenVisualization,
    handleTabOpen,
    parseLineRange,
    basePathRef,
    currentWorkspacePathRef,
    expandDetailsByDefaultRef,
    fileActionsViaCallbackOnlyRef,
    isLightRef,
    markdownContentRef,
    onHttpLinkClickRef,
    remoteConnectionIdRef,
    remoteSshHostRef,
    workspaceIdRef,
    syntaxThemeRef,
    traceContextRef,
    sourceRangeRef,
  ]);
  
  const textRevealRef = useRef<HTMLDivElement>(null);
  useStreamingTextReveal(textRevealRef, sourceRange ? contentStr.slice(sourceRange.start, sourceRange.end) : contentStr, isStreaming);

  const wrapperClassName = `markdown-renderer ${className}`.trim();
  const basicMarkdownRenderer = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkAutolinkBoundaries, remarkAutolinkInternalLinks]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], [rehypeSourceRange, sourceRange]]}
      urlTransform={markdownUrlTransform}
      components={components}
    >
      {markdownContent}
    </ReactMarkdown>
  );

  return (
    <div ref={textRevealRef} className={wrapperClassName} data-openbitfun-component="markdown" data-openbitfun-part="root" data-openbitfun-state={isStreaming ? 'streaming' : undefined}>
      {renderTraceEnabled && renderTraceStartedAtMs !== null && (
        <MarkdownRenderTrace
          startedAtMs={renderTraceStartedAtMs}
          contentLength={markdownFeatureProfile.contentLength}
          hasCodeBlock={markdownFeatureProfile.hasCodeBlock}
          hasTable={markdownFeatureProfile.hasTable}
          isStreaming={isStreaming}
          traceContext={traceContext}
        />
      )}
      <MarkdownErrorBoundary fallbackContent={sourceRange ? markdownContent.slice(sourceRange.start, sourceRange.end) : markdownContent}>
        {shouldUseMathRenderer ? (
          <React.Suspense fallback={basicMarkdownRenderer}>
            <MarkdownMathRenderer
              markdownContent={markdownContent}
              components={components}
              sanitizeSchema={sanitizeSchema}
              remarkAutolinkComputerFileLinks={remarkAutolinkInternalLinks}
              urlTransform={markdownUrlTransform}
              sourceRange={sourceRange}
            />
          </React.Suspense>
        ) : basicMarkdownRenderer}
      </MarkdownErrorBoundary>
      
    </div>
  );
});
