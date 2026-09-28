import type { GrepSearchResultBlock, GrepSearchResultLine } from '@openbitfun/ui/flow-chat';
import { formatSessionViewPreviewText } from './sessionViewPreview';

export interface GrepSearchPreviewOptions {
  outputMode?: string;
  showLineNumbers?: boolean;
  multiline?: boolean;
}

function parseNumberedLine(text: string): { path: string; line: GrepSearchResultLine } | undefined {
  // Native and workspace search use path:line:text and path-line:text.
  // Keep drive letters and quoted display paths intact; code may contain colons.
  const match = /^("(?:[^"\\]|\\.)*"|(?:[A-Za-z]:[\\/])?[^:\r\n]+):(\d+):(.*)$/.exec(text);
  const context = /^("(?:[^"\\]|\\.)*"|(?:[A-Za-z]:[\\/])?[^:\r\n]+)-(\d+):(.*)$/.exec(text);
  // A numeric filename suffix can make the two formats ambiguous.
  if ((!match && !context) || (match && context)) return undefined;
  const parts = (match ?? context)!;
  const lineNumber = Number(parts[2]);
  if (!Number.isSafeInteger(lineNumber)) return undefined;
  return {
    path: parts[1],
    line: { kind: match ? 'match' : 'context', lineNumber, text: parts[3] },
  };
}

/** Project numbered excerpts without changing result records or dropping raw output. */
export function projectGrepSearchResults(
  value: string,
  options: GrepSearchPreviewOptions = {},
): GrepSearchResultBlock[] {
  const text = formatSessionViewPreviewText(value);
  if (!text) return [];
  const fallback: GrepSearchResultBlock[] = [{ kind: 'text', text }];
  if (
    (options.outputMode !== undefined && options.outputMode !== 'content')
    || options.showLineNumbers === false
    // Native multiline matches can include unprefixed physical lines.
    || options.multiline === true
  ) return fallback;

  const blocks: GrepSearchResultBlock[] = [];
  let currentFile: { kind: 'file'; path: string; lines: GrepSearchResultLine[] } | undefined;
  let gapBefore = false;
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === '--' && currentFile && index + 1 < lines.length) {
      const next = parseNumberedLine(lines[index + 1]);
      if (next?.path === currentFile.path) {
        gapBefore = true;
        continue;
      }
    }

    const parsed = parseNumberedLine(raw);
    if (parsed) {
      if (currentFile?.path !== parsed.path) {
        currentFile = { kind: 'file', path: parsed.path, lines: [] };
        blocks.push(currentFile);
      }
      currentFile.lines.push(gapBefore ? { ...parsed.line, gapBefore: true } : parsed.line);
    } else {
      // Notices, partial lines and unfamiliar formats stay in their original order.
      currentFile = undefined;
      const previous = blocks.at(-1);
      if (previous?.kind === 'text') previous.text += '\n' + raw;
      else blocks.push({ kind: 'text', text: raw });
    }
    gapBefore = false;
  }

  return blocks.some(block => block.kind === 'file') ? blocks : fallback;
}
