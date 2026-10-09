import { Check as LucideCheck, Copy as LucideCopy, FileText as LucideFileText } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import { MobileButton, MobileIconButton, MobileLink } from '@openbitfun/ui/mobile';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { RemoteArtifactImage } from './RemoteArtifactImage';

const SYNTAX_LANGUAGES = { bash, c, cpp, csharp, css, diff, go, java, javascript, json, jsx, kotlin, markdown, markup, php, python, ruby, rust, sql, swift, tsx, typescript, yaml };
Object.entries(SYNTAX_LANGUAGES).forEach(([name, grammar]) => SyntaxHighlighter.registerLanguage(name, grammar));
SyntaxHighlighter.registerLanguage('cs', csharp);
SyntaxHighlighter.registerLanguage('html', markup);
SyntaxHighlighter.registerLanguage('js', javascript);
SyntaxHighlighter.registerLanguage('md', markdown);
SyntaxHighlighter.registerLanguage('py', python);
SyntaxHighlighter.registerLanguage('rb', ruby);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('ts', typescript);
SyntaxHighlighter.registerLanguage('xml', markup);
SyntaxHighlighter.registerLanguage('yml', yaml);

export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for insecure contexts (HTTP)
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
  return Promise.resolve();
}

const CopyButton: React.FC<{ code: string }> = ({ code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await copyToClipboard(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <MobileIconButton
      appearance="plain"
      aria-label={copied ? 'Copied' : 'Copy code'}
      className={`copy-button${copied ? ' copy-success' : ''}`}
      icon={copied ? (
        <LucideCheck width="14" height="14" stroke="currentColor" aria-hidden="true" />
      ) : (
        <LucideCopy width="14" height="14" stroke="currentColor" aria-hidden="true" />
      )}
      onClick={handleCopy}
      size="sm"
    />
  );
};
const COMPUTER_LINK_PREFIX = 'computer://';
const FILE_LINK_PREFIX = 'file://';
const WORKSPACE_FOLDER_PLACEHOLDER = '{{workspaceFolder}}';
const CODE_FILE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyw', 'pyi',
  'rs', 'go', 'java', 'kt', 'kts', 'scala', 'groovy',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'hh',
  'cs', 'rb', 'php', 'swift',
  'vue', 'svelte',
  'css', 'scss', 'less', 'sass',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml',
  'md', 'mdx', 'rst', 'txt',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto',
  'lock', 'env', 'ini', 'cfg', 'conf',
  'cj', 'ets',
  'editorconfig', 'gitignore',
  'log',
]);

const DOWNLOADABLE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff', 'tif',
  'zip', 'tar', 'gz', 'bz2', '7z', 'rar', 'dmg', 'iso', 'xz',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma',
  'mp4', 'avi', 'mkv', 'mov', 'webm', 'wmv', 'flv',
  'csv', 'tsv', 'sqlite', 'db', 'parquet',
  'epub', 'mobi', 'html', 'htm',
  'apk', 'ipa', 'exe', 'msi', 'deb', 'rpm',
  'ttf', 'otf', 'woff', 'woff2',
]);

function normalizeFileLikeHref(rawHref: string): string {
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

  // Normalize URI-like Windows absolute paths with a leading slash before the drive letter.
  if (/^\/[A-Za-z]:[\\/]/.test(filePath)) {
    filePath = filePath.slice(1);
  }

  try {
    return decodeURIComponent(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Detect local file links: absolute paths, file:// URLs, computer:// URLs, and
 * relative paths pointing to downloadable files. Returns the normalized file
 * path or null.
 *
 * - Absolute paths (`/Users/.../file.pdf`): use CODE_FILE_EXTENSIONS blacklist
 * - Relative paths (`report.pptx`, `./output.pdf`): use DOWNLOADABLE_EXTENSIONS whitelist
 */
function isLocalFileLink(href: string): string | null {
  if (!href || href === '/') return null;

  let filePath: string;
  if (
    href.startsWith(COMPUTER_LINK_PREFIX) ||
    href.startsWith(FILE_LINK_PREFIX) ||
    href.startsWith('file:')
  ) {
    filePath = normalizeFileLikeHref(href);
  } else if (href.includes('://') || href.startsWith('#') || href.startsWith('//')) {
    return null;
  } else {
    filePath = normalizeFileLikeHref(href);
  }

  if (filePath.startsWith('/')) {
    const segments = filePath.split('/').filter(Boolean);
    if (segments.length < 2) return null;
  }

  const fileName = filePath.split('/').pop() || '';
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx <= 0) return null;

  const ext = fileName.slice(dotIdx + 1).toLowerCase();
  if (!ext) return null;

  if (filePath.startsWith('/')) {
    if (CODE_FILE_EXTENSIONS.has(ext)) return null;
  } else {
    if (!DOWNLOADABLE_EXTENSIONS.has(ext)) return null;
  }

  return filePath;
}

function resolveFileReferenceHref(href: string): string | null {
  if (/^openbitfun:\/\/(?:runtime|current-session)\//.test(href)) return href;
  if (
    href.startsWith(COMPUTER_LINK_PREFIX) ||
    href.startsWith(FILE_LINK_PREFIX) ||
    href.startsWith('file:')
  ) {
    return normalizeFileLikeHref(href);
  }
  return isLocalFileLink(href);
}

interface ProjectedFileReference {
  path: string;
}

function projectFileReferences(content: string): ProjectedFileReference[] {
  const references: ProjectedFileReference[] = [];
  const seen = new Set<string>();
  const addReference = (href: string) => {
    const path = resolveFileReferenceHref(href);
    if (!path || seen.has(path)) return;
    seen.add(path);
    references.push({ path });
  };

  // Code examples describe references but do not offer attachments.
  const prose = content.replace(/(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\2[^\n]*(?=\n|$)|$)/g, '$1')
    .replace(/(`+)[^`]*?\1/g, '');
  // Markdown attachment links stay readable inline; their richer cards are
  // projected into a separate block below the message, matching HarmonyOS.
  const markdownLinkPattern = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g;
  for (const match of prose.matchAll(markdownLinkPattern)) {
    addReference(match[1] || match[2] || '');
  }

  // Preserve support for assistant output that emits a bare computer/file URI.
  const bareReferencePattern = /(?:computer|file):\/\/[^\s<>()\]]+/g;
  for (const match of prose.matchAll(bareReferencePattern)) {
    addReference(match[0].replace(/[.,;:!?，。；：！？]+$/, ''));
  }

  return references.slice(0, 4);
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const FileTextIcon: React.FC<{ size?: number; className?: string }> = ({ size = 20, className }) => (
  <LucideFileText width={size} height={size} className={className} aria-hidden="true" />
);

type FileCardState =
  | { status: 'loading' }
  | { status: 'ready'; name: string; size: number; mimeType: string }
  | { status: 'downloading'; name: string; size: number; mimeType: string; progress: number }
  | { status: 'done'; name: string; size: number; mimeType: string }
  | { status: 'error'; message: string };

interface FileCardProps {
  path: string;
  onGetFileInfo: (path: string) => Promise<{ name: string; size: number; mimeType: string }>;
  onDownload: (path: string, onProgress?: (downloaded: number, total: number) => void) => Promise<void>;
}

const FileCard: React.FC<FileCardProps> = ({ path, onGetFileInfo, onDownload }) => {
  const { t } = useI18n();
  const [state, setState] = useState<FileCardState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const onGetFileInfoRef = useRef(onGetFileInfo);
  onGetFileInfoRef.current = onGetFileInfo;

  // The owning host resolves metadata on demand, so a failure is not final: a
  // file can appear after the message that names it, and a target switch can
  // fail the request. Keep the reason and make the lookup repeatable.
  useEffect(() => {
    let cancelled = false;
    onGetFileInfoRef.current(path)
      .then(({ name, size, mimeType }) => {
        if (!cancelled) setState({ status: 'ready', name, size, mimeType });
      })
      .catch((err) => {
        if (!cancelled)
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [path, attempt]);

  const handleRetry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt(value => value + 1);
  }, []);

  const handleClick = useCallback(async () => {
    if (state.status !== 'ready' && state.status !== 'done') return;
    const info = state as { status: 'ready' | 'done'; name: string; size: number; mimeType: string };
    setState({ status: 'downloading', name: info.name, size: info.size, mimeType: info.mimeType, progress: 0 });
    try {
      await onDownload(path, (downloaded, total) => {
        setState(prev => {
          if (prev.status !== 'downloading') return prev;
          return { ...prev, progress: total > 0 ? downloaded / total : 0 };
        });
      });
      setState({ status: 'done', name: info.name, size: info.size, mimeType: info.mimeType });
    } catch {
      setState({ status: 'ready', name: info.name, size: info.size, mimeType: info.mimeType });
    }
  }, [state, path, onDownload]);

  if (state.status === 'loading') {
    return (
      <span className="file-card" data-status="loading">
        <span className="file-card__icon"><FileTextIcon size={20} /></span>
        <span className="file-card__placeholder">{t('chat.fileLoading')}</span>
      </span>
    );
  }
  if (state.status === 'error') {
    // The reason used to live only in `title`, which no touch host shows. Keep
    // the failure readable and repeatable instead of a dead, dimmed card.
    return (
      <span className="file-card" data-status="error">
        <span className="file-card__icon"><FileTextIcon size={20} /></span>
        <span className="file-card__copy">
          <span className="file-card__name">{t('chat.fileUnavailable')}</span>
          <span className="file-card__reason">{state.message}</span>
        </span>
        <MobileButton appearance="plain" className="file-card__retry" onClick={handleRetry}>
          {t('devices.retry')}
        </MobileButton>
      </span>
    );
  }

  const { name, size } = state as { name: string; size: number; mimeType: string; status: string };
  const isDownloading = state.status === 'downloading';
  const isDone = state.status === 'done';

  return (
    <MobileButton
      appearance="plain"
      className="file-card"
      data-status={state.status}
      onClick={handleClick}
      title={isDownloading ? t('chat.fileDownloading') : isDone ? t('chat.fileDownloaded') : t('chat.clickToDownload')}
    >
      <span className="file-card__icon"><FileTextIcon size={20} /></span>
      <span className="file-card__copy">
        <span className="file-card__name">{name}</span>
        <span className="file-card__meta">{formatFileSize(size)}</span>
      </span>
      <span className="file-card__action">
        {isDownloading ? `${Math.round((state as any).progress * 100)}%` : isDone ? '✓' : '↓'}
      </span>
    </MobileButton>
  );
};
export function normalizeMathDelimiters(content: string): string {
  if (!content) return content;
  const hasDisplayBracket = content.includes('\\[');
  const hasInlineBracket = content.includes('\\(');
  const hasRawBlockDollars = /(^|[^\\])\$\$[^\n]+?\$\$/.test(content);
  if (!hasDisplayBracket && !hasInlineBracket && !hasRawBlockDollars) {
    return content;
  }

  const codeBlocks: { key: string; content: string }[] = [];
  let placeholderIndex = 0;

  // Protect code fences
  let transformed = content.replace(/(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\2[^\n]*(?=\n|$)|$)/g, (match) => {
    const key = `@@MATH_CODE_BLOCK_${placeholderIndex++}@@`;
    codeBlocks.push({ key, content: match });
    return key;
  });

  // Protect inline code spans
  transformed = transformed.replace(/(`+)((?:[^\n`]|(?!\1)`)*?)\1/g, (match) => {
    const key = `@@MATH_CODE_INLINE_${placeholderIndex++}@@`;
    codeBlocks.push({ key, content: match });
    return key;
  });

  // Normalize single-line $$...$$ to multi-line $$ \n ... \n $$ so remark-math recognises block math
  transformed = transformed.replace(/(^|[^\\])\$\$([^\n]+?)\$\$/g, (_, prefix, math) => `${prefix}\n\n$$\n${math.trim()}\n$$\n\n`);

  // Normalize \[ ... \] to block math $$ ... $$
  transformed = transformed.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `\n\n$$\n${math.trim()}\n$$\n\n`);

  // Normalize \( ... \) to inline math $ ... $
  transformed = transformed.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`);

  // Restore protected code blocks using function replacer to avoid special replacement patterns ($$, $&, $', etc.)
  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    const { key, content: code } = codeBlocks[i];
    transformed = transformed.replace(key, () => code);
  }

  return transformed;
}

interface MarkdownContentProps {
  content: string;
  onFileDownload?: (path: string, onProgress?: (downloaded: number, total: number) => void) => Promise<void>;
  onGetFileInfo?: (path: string) => Promise<{ name: string; size: number; mimeType: string }>;
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, onFileDownload, onGetFileInfo }) => {
  const { isDark } = useTheme();
  const syntaxTheme = isDark ? vscDarkPlus : vs;
  const normalizedContent = useMemo(() => normalizeMathDelimiters(content), [content]);
  const fileReferences = useMemo(
    () => onFileDownload && onGetFileInfo ? projectFileReferences(content) : [],
    [content, onFileDownload, onGetFileInfo],
  );

  const components: React.ComponentProps<typeof ReactMarkdown>['components'] = useMemo(() => ({
    code({ className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const codeStr = String(children).replace(/\n$/, '');
      const hasMultipleLines = codeStr.includes('\n');
      const isCodeBlock = className?.startsWith('language-') || hasMultipleLines;

      if (!isCodeBlock) {
        return (
          <code className="inline-code" {...props}>
            {children}
          </code>
        );
      }

      return (
        <div className="code-block-wrapper">
          <CopyButton code={codeStr} />
          <SyntaxHighlighter
            language={match?.[1] || 'text'}
            style={syntaxTheme}
            showLineNumbers={true}
            customStyle={{
              margin: 0,
              borderRadius: '8px',
              fontSize: 'var(--openbitfun-type-code-sm-font-size)',
              lineHeight: 'var(--openbitfun-type-body-md-line-height)',
            }}
            codeTagProps={{
              style: {
                fontFamily: 'var(--openbitfun-type-code-md-font-family)',
              },
            }}
            lineNumberStyle={{
              color: 'var(--openbitfun-color-content-muted)',
              paddingRight: '1em',
              textAlign: 'right' as const,
              userSelect: 'none' as const,
              minWidth: '2.5em',
            }}
          >
            {codeStr}
          </SyntaxHighlighter>
        </div>
      );
    },

    img({ src, alt, title }: React.ImgHTMLAttributes<HTMLImageElement>) {
      if (!src) return <span>{alt}</span>;
      if (/^(https?:|data:image\/|\/\/)/i.test(src)) {
        return <img className="markdown-output-image" src={src} alt={alt || ''} title={title} loading="lazy" />;
      }
      return <RemoteArtifactImage path={normalizeFileLikeHref(src)} alt={alt} title={title} onDownload={onFileDownload} />;
    },

    a({ href, children }: any) {
      const filePath = typeof href === 'string' ? resolveFileReferenceHref(href) : null;
      if (filePath && onFileDownload) {
        return (
          <MobileButton
            appearance="plain"
            className="file-link"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void onFileDownload(filePath).catch(() => {}); }}
            type="button"
          >
            {children}
          </MobileButton>
        );
      }

      // Fallback: render as plain text for computer:// links without handler,
      // or as a regular link for http(s) links.
      if (typeof href === 'string') {
        // Open all external links in a new tab.
        const isExternalLink = href.startsWith('http://') || href.startsWith('https://');
        if (isExternalLink) {
          return (
            <MobileLink
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </MobileLink>
          );
        }
      }

      return <span style={{ textDecoration: 'underline', opacity: 0.7 }}>{children}</span>;
    },

    table({ children }: any) {
      return (
        <div className="table-wrapper">
          <table>{children}</table>
        </div>
      );
    },

    blockquote({ children }: any) {
      return <blockquote className="custom-blockquote">{children}</blockquote>;
    },
  }), [syntaxTheme, isDark, onFileDownload, onGetFileInfo]);

  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
        components={components}
        urlTransform={(url, key) => {
          if (key === 'src' && /^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml|avif);base64,/i.test(url)) return url;
          if (/^[A-Za-z]:[\\/]/.test(url)) return url;
          if (url.startsWith('computer://') || /^openbitfun:\/\/(?:runtime|current-session)\//.test(url)) return url;
          if (/^(https?|mailto|tel|file):/i.test(url) || url.startsWith('#') || url.startsWith('/')) {
            return url;
          }
          // Preserve relative paths without a protocol (e.g. "report.pptx",
          // "./output.pdf"). Unknown schemes remain blocked.
          if (!url.includes(':')) return url;
          return '';
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
      {fileReferences.length > 0 && onGetFileInfo && onFileDownload && (
        <div className="message-file-cards">
          {fileReferences.map((reference) => (
            <FileCard
              key={reference.path}
              path={reference.path}
              onGetFileInfo={onGetFileInfo}
              onDownload={onFileDownload}
            />
          ))}
        </div>
      )}
    </>
  );
};
