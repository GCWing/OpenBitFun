import yaml from 'yaml';

export interface IdentityDocument {
  name: string;
  creature: string;
  vibe: string;
  avatar: string;
  emoji: string;
  body: string;
}

export const EMPTY_IDENTITY_DOCUMENT: IdentityDocument = {
  name: '',
  creature: '',
  vibe: '',
  avatar: '',
  emoji: '',
  body: '',
};

const FRONTMATTER_FIELDS: Array<keyof Omit<IdentityDocument, 'body'>> = [
  'name',
  'creature',
  'vibe',
  'avatar',
  'emoji',
];

export interface MarkdownFrontmatterSections {
  hasFrontmatter: boolean;
  frontmatter: string;
  body: string;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeShortField(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function serializeScalar(value: string): string {
  return yaml.stringify(value).trimEnd();
}

export function splitMarkdownFrontmatter(content: string): MarkdownFrontmatterSections {
  const normalizedContent = normalizeLineEndings(content || '');
  const frontmatterMatch = normalizedContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!frontmatterMatch) {
    return {
      hasFrontmatter: false,
      frontmatter: '',
      body: normalizedContent.trimEnd(),
    };
  }

  return {
    hasFrontmatter: true,
    frontmatter: frontmatterMatch[1] ?? '',
    body: (frontmatterMatch[2] ?? '').replace(/^\n+/, '').trimEnd(),
  };
}

export function joinMarkdownFrontmatter(
  frontmatter: string,
  body: string,
  options?: { preserveFrontmatterBlock?: boolean }
): string {
  const normalizedFrontmatter = normalizeLineEndings(frontmatter || '')
    .replace(/^\n+/, '')
    .trimEnd();
  const normalizedBody = normalizeLineEndings(body || '')
    .replace(/^\n+/, '')
    .trimEnd();

  if (!normalizedFrontmatter && !options?.preserveFrontmatterBlock) {
    return normalizedBody ? `${normalizedBody}\n` : '';
  }

  return `---\n${normalizedFrontmatter}\n---\n\n${normalizedBody}`.trimEnd() + '\n';
}

const parsedDocCache = new Map<string, IdentityDocument>();

export function parseIdentityDocument(content: string): IdentityDocument {
  const cached = parsedDocCache.get(content);
  if (cached) return cached;

  const sections = splitMarkdownFrontmatter(content);
  let doc: IdentityDocument;
  if (!sections.hasFrontmatter) {
    doc = {
      ...EMPTY_IDENTITY_DOCUMENT,
      body: sections.body.trim(),
    };
  } else {
    const parsed = (yaml.parse(sections.frontmatter) || {}) as Record<string, unknown>;
    doc = {
      name: normalizeShortField(parsed.name),
      creature: normalizeShortField(parsed.creature),
      vibe: normalizeShortField(parsed.vibe),
      avatar: normalizeShortField(parsed.avatar),
      emoji: normalizeShortField(parsed.emoji),
      body: sections.body,
    };
  }

  if (parsedDocCache.size > 256) parsedDocCache.clear();
  parsedDocCache.set(content, doc);
  return doc;
}

export function serializeIdentityDocument(document: IdentityDocument): string {
  const normalized = {
    name: normalizeShortField(document.name),
    creature: normalizeShortField(document.creature),
    vibe: normalizeShortField(document.vibe),
    avatar: normalizeShortField(document.avatar),
    emoji: normalizeShortField(document.emoji),
    body: normalizeLineEndings(document.body || '').replace(/^\n+/, '').trimEnd(),
  };

  const frontmatter = FRONTMATTER_FIELDS
    .map((field) => {
      const value = normalized[field];
      return value ? `${field}: ${serializeScalar(value)}` : `${field}:`;
    })
    .join('\n');

  return joinMarkdownFrontmatter(frontmatter, normalized.body);
}

export function getIdentityFilePath(workspaceRoot: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${normalizedRoot}/IDENTITY.md`;
}
