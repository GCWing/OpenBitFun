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
  return content
    // A fresh xterm has no prior rows for absolute cursor positions to target.
    // eslint-disable-next-line no-control-regex -- terminal control sequences are expected here.
    .replace(/\x1b\[\d*;?\d*[Hf]/g, '\r\n')
    // Avoid moving the cursor to an otherwise empty trailing row.
    // eslint-disable-next-line no-control-regex -- terminal control sequences are expected here.
    .replace(/(?:\r\n|\r|\n)+((?:\x1b\[[0-?]*[ -/]*[@-~])*)$/g, '$1');
}

export function stripTerminalControlSequences(content: string): string {
  return content
    // eslint-disable-next-line no-control-regex -- terminal control sequences are expected here.
    .replace(/\x1b[\]PX_^][\s\S]*?(?:\x07|\x1b\\)/g, '')
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
  const lineCount = content ? content.split(/\r\n|\r|\n/).length : 1;
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
