/**
 * Editor default configuration (single source of truth).
 */

import type { EditorConfig, MinimapConfig, GuidesConfig, ScrollbarConfig, HoverConfig, SuggestConfig, QuickSuggestionsConfig, InlayHintsConfig } from './types';
import {
  getTypographyTokenNumber,
  getTypographyTokenPx,
  readActiveTypographyTokenValue,
} from '@/infrastructure/design-system/typographyRuntime';

export const DEFAULT_EDITOR_FONT_SIZE = getTypographyTokenPx('font.size.base');
/** An empty persisted value follows the design system's current code font. */
export const DEFAULT_EDITOR_FONT_FAMILY = '';
export function resolveEditorFontFamily(fontFamily?: string): string {
  return fontFamily?.trim() || readActiveTypographyTokenValue('font.family.mono');
}
export const DEFAULT_EDITOR_LINE_HEIGHT = getTypographyTokenNumber('lineHeight.base');
export const DEFAULT_EDITOR_INLAY_FONT_SIZE = getTypographyTokenPx('font.size.xs');
export const DEFAULT_EDITOR_FONT_WEIGHT: EditorConfig['fontWeight'] =
  getTypographyTokenNumber('font.weight.regular') >= 600 ? 'bold' : 'normal';

export const DEFAULT_MINIMAP_CONFIG: MinimapConfig = {
  enabled: true,
  side: 'right',
  size: 'proportional',
};

export const DEFAULT_GUIDES_CONFIG: GuidesConfig = {
  indentation: true,
  bracketPairs: true,
  bracketPairsHorizontal: 'active',
  highlightActiveBracketPair: true,
  highlightActiveIndentation: true,
};

export const DEFAULT_SCROLLBAR_CONFIG: ScrollbarConfig = {
  vertical: 'auto',
  horizontal: 'auto',
  verticalScrollbarSize: 10,
  horizontalScrollbarSize: 12,
  useShadows: false,
};

export const DEFAULT_HOVER_CONFIG: HoverConfig = {
  enabled: true,
  delay: 100,
  sticky: true,
  above: false,
};

export const DEFAULT_SUGGEST_CONFIG: SuggestConfig = {
  showKeywords: true,
  showSnippets: true,
  preview: true,
  showInlineDetails: true,
};

export const DEFAULT_QUICK_SUGGESTIONS_CONFIG: QuickSuggestionsConfig = {
  other: true,
  comments: false,
  strings: false,
};

export const DEFAULT_INLAY_HINTS_CONFIG: InlayHintsConfig = {
  enabled: 'on',
  fontSize: DEFAULT_EDITOR_INLAY_FONT_SIZE,
  fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
  padding: false,
};

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  // Appearance
  fontSize: DEFAULT_EDITOR_FONT_SIZE,
  fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
  fontWeight: DEFAULT_EDITOR_FONT_WEIGHT,
  lineHeight: DEFAULT_EDITOR_LINE_HEIGHT,
  cursorStyle: 'line',
  cursorBlinking: 'smooth',
  renderWhitespace: 'selection',
  renderLineHighlight: 'line',

  // Behavior
  tabSize: 4,
  insertSpaces: true,
  detectIndentation: true,
  wordWrap: 'off',
  autoSave: 'afterDelay',
  autoSaveDelay: 1000,
  scrollBeyondLastLine: false,
  smoothScrolling: true,

  // Features
  lineNumbers: 'on',
  minimap: { ...DEFAULT_MINIMAP_CONFIG },
  formatOnSave: false,
  formatOnPaste: false,
  trimAutoWhitespace: true,

  // Advanced
  semanticHighlighting: true,
  bracketPairColorization: true,
  guides: { ...DEFAULT_GUIDES_CONFIG },
  scrollbar: { ...DEFAULT_SCROLLBAR_CONFIG },
  hover: { ...DEFAULT_HOVER_CONFIG },
  suggest: { ...DEFAULT_SUGGEST_CONFIG },
  quickSuggestions: { ...DEFAULT_QUICK_SUGGESTIONS_CONFIG },
  inlayHints: { ...DEFAULT_INLAY_HINTS_CONFIG },
};

/** Deep merge configuration (source overrides target) */
export function mergeConfig<T extends Record<string, any>>(
  target: T,
  source: Partial<T> | undefined
): T {
  if (!source) {
    return target;
  }

  const result = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (
        sourceValue !== undefined &&
        typeof sourceValue === 'object' &&
        sourceValue !== null &&
        !Array.isArray(sourceValue) &&
        typeof targetValue === 'object' &&
        targetValue !== null &&
        !Array.isArray(targetValue)
      ) {
        (result as any)[key] = mergeConfig(targetValue, sourceValue);
      } else if (sourceValue !== undefined) {
        (result as any)[key] = sourceValue;
      }
    }
  }

  return result;
}

export function getFullConfig(partial?: Partial<EditorConfig>): EditorConfig {
  return mergeConfig(DEFAULT_EDITOR_CONFIG, partial);
}
