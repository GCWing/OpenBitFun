/**
 * Editor options builder.
 * Converts config to Monaco options, handles special field transforms
 * (e.g., lineHeight calculation), and merges preset and runtime config.
 */

import type * as monaco from 'monaco-editor';
import type { EditorConfig, EditorConfigPartial, EditorPresetName, EditorPresetConfig } from '../config/types';
import { DEFAULT_EDITOR_CONFIG, mergeConfig, resolveEditorFontFamily } from '../config/defaults';
import { getPreset } from '../config/presets';
import { monacoAppearanceAdapter } from '@/infrastructure/appearance/adapters/MonacoAppearanceAdapter';

export interface EditorOptionsInput {
  config?: EditorConfigPartial;
  preset?: EditorPresetName;
  /** Runtime overrides from component props */
  overrides?: EditorOptionsOverrides;
}

export interface EditorOptionsOverrides {
  readOnly?: boolean;
  lineNumbers?: boolean | 'on' | 'off' | 'relative' | 'interval';
  minimap?: boolean;
  fontSize?: number;
  tabSize?: number;
  wordWrap?: 'off' | 'on' | 'wordWrapColumn' | 'bounded';
  language?: string;
}

/**
 * Build Monaco editor options from config, preset, and overrides.
 * Merge order: defaults <- preset <- user config <- runtime overrides.
 */
export function buildEditorOptions(
  input: EditorOptionsInput = {}
): monaco.editor.IStandaloneEditorConstructionOptions {
  const { config, preset, overrides } = input;
  
  const presetConfig: EditorPresetConfig = preset ? getPreset(preset) : {};
  
  const mergedConfig = mergeConfig(
    mergeConfig(DEFAULT_EDITOR_CONFIG, presetConfig as EditorConfigPartial),
    config
  );
  
  const finalConfig = applyOverrides(mergedConfig, presetConfig, overrides);
  
  return convertToMonacoOptions(finalConfig, presetConfig);
}

function applyOverrides(
  config: EditorConfig,
  _presetConfig: EditorPresetConfig,
  overrides?: EditorOptionsOverrides
): EditorConfig {
  if (!overrides) {
    return config;
  }
  
  const result = { ...config };
  
  if (overrides.lineNumbers !== undefined) {
    if (typeof overrides.lineNumbers === 'boolean') {
      result.lineNumbers = overrides.lineNumbers ? 'on' : 'off';
    } else {
      result.lineNumbers = overrides.lineNumbers;
    }
  }
  
  if (overrides.minimap !== undefined) {
    result.minimap = {
      ...result.minimap,
      enabled: overrides.minimap,
    };
  }
  
  if (overrides.fontSize !== undefined) {
    result.fontSize = overrides.fontSize;
  }
  if (overrides.tabSize !== undefined) {
    result.tabSize = overrides.tabSize;
  }
  if (overrides.wordWrap !== undefined) {
    result.wordWrap = overrides.wordWrap;
  }
  return result;
}

function convertToMonacoOptions(
  config: EditorConfig,
  presetConfig: EditorPresetConfig
): monaco.editor.IStandaloneEditorConstructionOptions {
  // lineHeight: Monaco uses pixels (0 = default)
  const lineHeight = config.lineHeight 
    ? Math.round(config.fontSize * config.lineHeight)
    : 0;
  
  const themeId = monacoAppearanceAdapter.getCurrentThemeId();
  
  const options: monaco.editor.IStandaloneEditorConstructionOptions = {
    theme: themeId,
    automaticLayout: true,
    
    fontSize: config.fontSize,
    fontFamily: resolveEditorFontFamily(config.fontFamily),
    fontWeight: config.fontWeight,
    lineHeight,
    cursorStyle: config.cursorStyle,
    cursorBlinking: config.cursorBlinking,
    renderWhitespace: config.renderWhitespace,
    renderLineHighlight: config.renderLineHighlight,
    
    tabSize: config.tabSize,
    insertSpaces: config.insertSpaces,
    detectIndentation: config.detectIndentation,
    wordWrap: config.wordWrap,
    scrollBeyondLastLine: config.scrollBeyondLastLine,
    smoothScrolling: config.smoothScrolling,
    
    readOnly: presetConfig.readOnly ?? false,
    lineNumbers: config.lineNumbers,
    lineNumbersMinChars: 3,
    lineDecorationsWidth: 0,
    glyphMargin: false,
    showFoldingControls: 'never',
    minimap: {
      enabled: config.minimap.enabled,
      side: config.minimap.side,
      size: config.minimap.size,
    },
    
    contextmenu: presetConfig.contextmenu ?? true,
    links: presetConfig.links ?? true,
    folding: presetConfig.folding ?? true,
    codeLens: presetConfig.codeLens ?? true,
    
    'semanticHighlighting.enabled': config.semanticHighlighting,
    bracketPairColorization: {
      enabled: config.bracketPairColorization,
      independentColorPoolPerBracketType: true,
    },
    
    guides: {
      indentation: config.guides.indentation,
      bracketPairs: config.guides.bracketPairs,
      // Monaco expects boolean | 'active', convert our string values
      bracketPairsHorizontal: config.guides.bracketPairsHorizontal === 'active' 
        ? 'active' 
        : config.guides.bracketPairsHorizontal === 'true',
      highlightActiveBracketPair: config.guides.highlightActiveBracketPair,
      highlightActiveIndentation: config.guides.highlightActiveIndentation,
    },
    
    scrollbar: {
      vertical: config.scrollbar.vertical,
      horizontal: config.scrollbar.horizontal,
      verticalScrollbarSize: config.scrollbar.verticalScrollbarSize,
      horizontalScrollbarSize: config.scrollbar.horizontalScrollbarSize,
      useShadows: config.scrollbar.useShadows,
    },
    
    hover: {
      enabled: config.hover.enabled,
      delay: config.hover.delay,
      sticky: config.hover.sticky,
      above: config.hover.above,
    },
    
    suggest: {
      showKeywords: config.suggest.showKeywords,
      showSnippets: config.suggest.showSnippets,
      preview: config.suggest.preview,
      showInlineDetails: config.suggest.showInlineDetails,
    },
    
    quickSuggestions: {
      other: config.quickSuggestions.other,
      comments: config.quickSuggestions.comments,
      strings: config.quickSuggestions.strings,
    },
    
    inlayHints: {
      enabled: config.inlayHints.enabled,
      fontSize: config.inlayHints.fontSize,
      fontFamily: resolveEditorFontFamily(config.inlayHints.fontFamily || config.fontFamily),
      padding: config.inlayHints.padding,
    },
    
    gotoLocation: {
      multipleDefinitions: 'goto',
      multipleTypeDefinitions: 'goto',
      multipleDeclarations: 'goto',
      multipleImplementations: 'goto',
      multipleReferences: 'goto',
    },
    
    multiCursorModifier: 'alt',
    definitionLinkOpensInPeek: false,
    
    renderControlCharacters: false,
    renderValidationDecorations: 'on',
    renderFinalNewline: 'on',
    
    // Ensure selection background covers all characters
    roundedSelection: false,
    // Force per-character width measurement (fixes high-DPI issues)
    disableMonospaceOptimizations: true,
    fontLigatures: false,
    // Don't truncate long lines
    stopRenderingLineAfter: -1,
  };
  
  return options;
}

export function buildDiffEditorOptions(
  input: EditorOptionsInput = {}
): monaco.editor.IStandaloneDiffEditorConstructionOptions {
  const baseInput: EditorOptionsInput = {
    ...input,
    preset: input.preset || 'diff',
  };
  
  const baseOptions = buildEditorOptions(baseInput);
  
  const diffOptions: monaco.editor.IStandaloneDiffEditorConstructionOptions = {
    ...baseOptions,

    renderSideBySide: true,
    renderOverviewRuler: false,
    renderIndicators: true,
    renderMarginRevertIcon: true,
    renderGutterMenu: true,
    originalEditable: false,
    ignoreTrimWhitespace: false,
    diffWordWrap: baseOptions.wordWrap as any,
    diffAlgorithm: 'advanced',
    enableSplitViewResizing: true,

    // Collapse unchanged regions for large file readability
    hideUnchangedRegions: {
      enabled: true,
      contextLineCount: 3,
      minimumLineCount: 5,
      revealLineCount: 20,
    },
  };
  
  return diffOptions;
}

/** Build partial options for dynamic editor updates. */
export function buildUpdateOptions(
  config: EditorConfigPartial
): monaco.editor.IStandaloneEditorConstructionOptions {
  const options: monaco.editor.IStandaloneEditorConstructionOptions = {};
  
  if (config.fontSize !== undefined) {
    options.fontSize = config.fontSize;
  }
  if (config.fontFamily !== undefined) {
    options.fontFamily = resolveEditorFontFamily(config.fontFamily);
  }
  if (config.lineHeight !== undefined && config.fontSize !== undefined) {
    options.lineHeight = Math.round(config.fontSize * config.lineHeight);
  }
  if (config.tabSize !== undefined) {
    options.tabSize = config.tabSize;
  }
  if (config.insertSpaces !== undefined) {
    options.insertSpaces = config.insertSpaces;
  }
  if (config.detectIndentation !== undefined) {
    options.detectIndentation = config.detectIndentation;
  }
  if (config.wordWrap !== undefined) {
    options.wordWrap = config.wordWrap;
  }
  if (config.lineNumbers !== undefined) {
    options.lineNumbers = config.lineNumbers;
  }
  if (config.minimap !== undefined) {
    options.minimap = config.minimap;
  }
  if (config.renderWhitespace !== undefined) {
    options.renderWhitespace = config.renderWhitespace;
  }
  if (config.renderLineHighlight !== undefined) {
    options.renderLineHighlight = config.renderLineHighlight;
  }
  
  return options;
}
