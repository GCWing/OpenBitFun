import { visit } from 'unist-util-visit';

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const ENCODED_WINDOWS_DRIVE_PATH = /^[A-Za-z]:(?:%5C|%2F)/i;

interface RehypeWindowsDrivePathsOptions {
  /** Original Markdown source, used when parsing escaped Windows paths loses separators. */
  markdownSource?: string;
}

interface NodePosition {
  start?: { offset?: number };
  end?: { offset?: number };
}

function extractDestinationFromMarkdown(source: string, position: NodePosition | undefined): string | undefined {
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
    return undefined;
  }

  const snippet = source.slice(start, end);
  // Use the last destination in case an anchor contains an image in its label.
  const markerIndex = snippet.lastIndexOf('](');
  if (markerIndex === -1) {
    return undefined;
  }

  let destination = snippet.slice(markerIndex + 2).trim();
  if (destination.endsWith(')')) {
    destination = destination.slice(0, -1).trimEnd();
  }

  if (destination.startsWith('<')) {
    const closeIndex = destination.indexOf('>');
    return closeIndex === -1 ? undefined : destination.slice(1, closeIndex);
  }

  const whitespaceIndex = destination.search(/[\t\r\n ]/);
  return whitespaceIndex === -1 ? destination : destination.slice(0, whitespaceIndex);
}

function extractSourceAttribute(source: string, position: NodePosition | undefined, property: string): string | undefined {
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
    return undefined;
  }

  const snippet = source.slice(start, end);
  const match = snippet.match(new RegExp(`\\b${property}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function sourceValueForProperty(source: string | undefined, node: any, property: string): string | undefined {
  if (!source || property !== 'src') {
    return undefined;
  }

  return extractDestinationFromMarkdown(source, node.position)
    ?? extractSourceAttribute(source, node.position, property);
}

function asWindowsFileUrl(value: string, allowEncoded = true): string | undefined {
  if (WINDOWS_DRIVE_PATH.test(value)) {
    return `file:///${value.replace(/\\/g, '/')}`;
  }

  if (!allowEncoded || !ENCODED_WINDOWS_DRIVE_PATH.test(value)) {
    return undefined;
  }

  try {
    const decoded = decodeURIComponent(value);
    return WINDOWS_DRIVE_PATH.test(decoded)
      ? `file:///${decoded.replace(/\\/g, '/')}`
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mark Windows drive-letter paths as local file references before
 * rehype-sanitize evaluates their apparent protocol (`C:`). The canonical
 * `file:///C:/...` form also keeps the transformed value a valid file URI if
 * another renderer ever observes it before local-path normalization.
 */
export function rehypeWindowsDrivePaths(options: RehypeWindowsDrivePathsOptions = {}) {
  return (tree: unknown) => {
    visit(tree, 'element', (node: any) => {
      if (!node.properties) return;
      for (const property of ['src', 'href']) {
        const value = node.properties?.[property];
        const sourceValue = sourceValueForProperty(options.markdownSource, node, property);
        const localValue = typeof sourceValue === 'string' ? sourceValue : value;
        if (typeof localValue === 'string') {
          const fileUrl = asWindowsFileUrl(localValue, property === 'src');
          if (fileUrl) {
            node.properties[property] = fileUrl;
          }
        }
      }
    });
  };
}
