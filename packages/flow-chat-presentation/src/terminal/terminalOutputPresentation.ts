import {
  readActiveTypographyTokenNumber,
  readActiveTypographyTokenPx,
  readActiveTypographyTokenValue,
} from '@openbitfun/design-tokens/typography-runtime';

export function readTerminalOutputFontFamily(target?: Element | null): string {
  return readActiveTypographyTokenValue('font.family.mono', target);
}

/** xterm and its plain-text preview share the public compact code-output role. */
export function readTerminalOutputTypography(target?: Element | null) {
  return {
    fontFamily: readTerminalOutputFontFamily(target),
    fontSize: readActiveTypographyTokenPx('type.code.output.fontSize', target),
    fontWeight: readActiveTypographyTokenNumber('type.code.output.fontWeight', target),
    fontWeightBold: readActiveTypographyTokenNumber('font.weight.bold', target),
    lineHeight: readActiveTypographyTokenNumber('type.code.output.lineHeight', target),
  };
}

let cachedDevicePixelRatio = 0;
let cachedRowHeight = 0;
let cachedTypography = '';

export function getEstimatedTerminalOutputRowHeight(): number {
  const typography = readTerminalOutputTypography();
  const defaultRowHeight = Math.ceil(typography.fontSize * typography.lineHeight);
  if (typeof window === 'undefined') {
    return defaultRowHeight;
  }

  const devicePixelRatio = window.devicePixelRatio || 1;
  const typographyKey = JSON.stringify([typography, document.fonts?.status]);
  if (cachedRowHeight > 0 && cachedDevicePixelRatio === devicePixelRatio && cachedTypography === typographyKey) {
    return cachedRowHeight;
  }

  try {
    if (typeof OffscreenCanvas === 'undefined') {
      return defaultRowHeight;
    }

    const context = new OffscreenCanvas(100, 100).getContext('2d');
    if (!context) {
      return defaultRowHeight;
    }

    context.font = `${typography.fontWeight} ${typography.fontSize}px ${typography.fontFamily}`;
    const metrics = context.measureText('W');
    const fontHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    if (!Number.isFinite(fontHeight) || fontHeight <= 0) {
      return defaultRowHeight;
    }

    const deviceCharHeight = Math.ceil(fontHeight * devicePixelRatio);
    const deviceCellHeight = Math.floor(deviceCharHeight * typography.lineHeight);
    cachedDevicePixelRatio = devicePixelRatio;
    cachedTypography = typographyKey;
    cachedRowHeight = deviceCellHeight / devicePixelRatio;
    return cachedRowHeight;
  } catch {
    return defaultRowHeight;
  }
}

export function prepareReadOnlyTerminalOutput(content: string): string {
  const prepared = content
    // A fresh xterm has no prior rows for absolute cursor positions to target.
    // eslint-disable-next-line no-control-regex -- terminal control sequences are expected here.
    .replace(/\x1b\[\d*(?:;\d*)?[Hf]/g, '\r\n');

  // Walk the trailing CSI sequences backwards, then remove the preceding line
  // breaks. An unanchored newline-run regex retries at every newline when a
  // large blank region is followed by text, causing quadratic backtracking.
  let suffixStart = prepared.length;
  while (suffixStart > 0) {
    let cursor = suffixStart - 1;
    const final = prepared.charCodeAt(cursor);
    if (final < 0x40 || final > 0x7e) break;
    cursor -= 1;
    while (cursor >= 0 && prepared.charCodeAt(cursor) >= 0x20 && prepared.charCodeAt(cursor) <= 0x2f) cursor -= 1;
    while (cursor >= 0 && prepared.charCodeAt(cursor) >= 0x30 && prepared.charCodeAt(cursor) <= 0x3f) cursor -= 1;
    if (cursor < 1 || prepared[cursor] !== '[' || prepared.charCodeAt(cursor - 1) !== 0x1b) break;
    suffixStart = cursor - 1;
  }
  let end = suffixStart;
  while (end > 0 && (prepared[end - 1] === '\r' || prepared[end - 1] === '\n')) end -= 1;
  return end === suffixStart ? prepared : prepared.slice(0, end) + prepared.slice(suffixStart);
}

export function stripTerminalControlSequences(content: string): string {
  // Unterminated OSC/DCS strings must not restart an unbounded wildcard search
  // at every later opener. Scan fixed delimiters once, keeping incomplete text.
  // eslint-disable-next-line no-control-regex -- terminal control sequences are expected here.
  const delimiters = /\x1b[\]PX_^]|\x07|\x1b\\/g;
  const parts: string[] = [];
  let start = -1;
  let copiedThrough = 0;
  let match: RegExpExecArray | null;
  while ((match = delimiters.exec(content)) !== null) {
    const terminator = match[0] === '\x07' || match[0] === '\x1b\\';
    if (start < 0) {
      if (!terminator) start = match.index;
    } else if (terminator) {
      parts.push(content.slice(copiedThrough, start));
      copiedThrough = delimiters.lastIndex;
      start = -1;
    }
  }
  const withoutStrings = copiedThrough === 0 ? content : parts.join('') + content.slice(copiedThrough);
  return withoutStrings
    // eslint-disable-next-line no-control-regex -- terminal control sequences are expected here.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex -- terminal control sequences are expected here.
    .replace(/\x1b[ -/]*[@-~]/g, '');
}

export function takeLastTerminalRows(content: string, maxRows?: number): string {
  if (!maxRows || maxRows <= 0) {
    return content;
  }

  let rowCount = 0;
  let cursor = content.length;
  while (cursor > 0 && rowCount < maxRows) {
    const previousBreak = content.lastIndexOf('\n', cursor - 1);
    if (previousBreak < 0) {
      return content;
    }
    rowCount += 1;
    cursor = previousBreak;
  }

  return content.slice(cursor + 1);
}

interface TerminalOutputHeightOptions {
  rowHeight: number;
  minHeight: number;
  maxHeight: number;
  maxRows?: number;
}

export function calculateTerminalOutputHeight(
  content: string,
  { rowHeight, minHeight, maxHeight, maxRows }: TerminalOutputHeightOptions,
): number {
  const heightForRows = (rows: number) => Math.ceil(Math.max(rowHeight, rows * rowHeight));
  const alignHeightToRows = (height: number, mode: 'floor' | 'ceil') => {
    const rows = mode === 'ceil'
      ? Math.ceil(height / rowHeight)
      : Math.floor(height / rowHeight);
    return heightForRows(Math.max(1, rows));
  };
  const effectiveMinHeight = alignHeightToRows(minHeight, 'ceil');
  const effectiveMaxHeight = maxRows != null && maxRows > 0
    ? heightForRows(maxRows)
    : alignHeightToRows(maxHeight, 'floor');
  const boundedMaxHeight = Math.max(effectiveMinHeight, effectiveMaxHeight);
  // Height saturates at this row count; do not allocate every output line just
  // to size a small preview. Invalid geometry still follows the math below.
  const rowLimit = rowHeight > 0 && Number.isFinite(rowHeight) && Number.isFinite(boundedMaxHeight)
    ? Math.max(1, Math.ceil(boundedMaxHeight / rowHeight))
    : Infinity;
  let lineCount = 1;
  for (let index = 0; index < content.length && lineCount < rowLimit; index += 1) {
    if (content[index] === '\r') {
      lineCount += 1;
      if (content[index + 1] === '\n') index += 1;
    } else if (content[index] === '\n') {
      lineCount += 1;
    }
  }
  const visibleRows = maxRows != null && maxRows > 0
    ? Math.min(lineCount, maxRows)
    : lineCount;
  const estimatedHeight = heightForRows(Math.max(1, visibleRows));

  return Math.min(Math.max(estimatedHeight, effectiveMinHeight), boundedMaxHeight);
}

export interface TerminalOutputFallbackModel {
  content: string;
  height: number;
}

export function buildTerminalOutputFallbackModel(
  content: string,
  options: { minHeight?: number; maxHeight?: number; maxRows?: number },
): TerminalOutputFallbackModel {
  const rowHeight = getEstimatedTerminalOutputRowHeight();
  const preparedContent = prepareReadOnlyTerminalOutput(content);
  const preview = stripTerminalControlSequences(
    takeLastTerminalRows(preparedContent, options.maxRows),
  );

  return {
    content: preview,
    height: calculateTerminalOutputHeight(preview, {
      rowHeight,
      minHeight: options.minHeight ?? rowHeight,
      maxHeight: options.maxHeight ?? 300,
      maxRows: options.maxRows,
    }),
  };
}
