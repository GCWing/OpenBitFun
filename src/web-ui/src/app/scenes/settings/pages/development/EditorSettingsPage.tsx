

import '@/app/scenes/settings/pages/development/EditorSettingsPage.scss';
import {
  ConfigFieldStatus,
  ConfigLoadingState,
  ConfigMessage,
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection,
  ConfigRetryState,
} from '@/infrastructure/config/components/common';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { globalEventBus } from '@/infrastructure/event-bus';
import { useI18n } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import { DEFAULT_EDITOR_CONFIG, type EditorConfigPartial, type EditorConfig as EditorConfigType } from '@/tools/editor/config';
import { resolveEditorFontFamily } from '@/tools/editor/config/defaults';
import { NumberInput, Select, Switch } from '@openbitfun/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';

const log = createLogger('EditorSettingsPage');





const fontFamilyOptions = [
  { label: 'Fira Code', value: 'Fira Code' },
  { label: 'Noto Sans SC', value: 'Noto Sans SC' },
  { label: 'Consolas', value: 'Consolas' },
  { label: 'Courier New', value: 'Courier New' },
];




const cursorStyleOptions = [
  { label: 'line', value: 'line', labelKey: 'appearance.cursorStyles.line' },
  { label: 'line-thin', value: 'line-thin', labelKey: 'appearance.cursorStyles.lineThin' },
  { label: 'block', value: 'block', labelKey: 'appearance.cursorStyles.block' },
  { label: 'block-outline', value: 'block-outline', labelKey: 'appearance.cursorStyles.blockOutline' },
  { label: 'underline', value: 'underline', labelKey: 'appearance.cursorStyles.underline' },
  { label: 'underline-thin', value: 'underline-thin', labelKey: 'appearance.cursorStyles.underlineThin' },
];


const cursorBlinkingOptions = [
  { label: 'blink', value: 'blink', labelKey: 'appearance.cursorBlinkings.blink' },
  { label: 'smooth', value: 'smooth', labelKey: 'appearance.cursorBlinkings.smooth' },
  { label: 'phase', value: 'phase', labelKey: 'appearance.cursorBlinkings.phase' },
  { label: 'expand', value: 'expand', labelKey: 'appearance.cursorBlinkings.expand' },
  { label: 'solid', value: 'solid', labelKey: 'appearance.cursorBlinkings.solid' },
];


const wordWrapOptions = [
  { label: 'off', value: 'off', labelKey: 'behavior.wordWrapOptions.off' },
  { label: 'on', value: 'on', labelKey: 'behavior.wordWrapOptions.on' },
  { label: 'wordWrapColumn', value: 'wordWrapColumn', labelKey: 'behavior.wordWrapOptions.wordWrapColumn' },
  { label: 'bounded', value: 'bounded', labelKey: 'behavior.wordWrapOptions.bounded' },
];


const lineNumbersOptions = [
  { label: 'on', value: 'on', labelKey: 'behavior.lineNumberOptions.on' },
  { label: 'off', value: 'off', labelKey: 'behavior.lineNumberOptions.off' },
  { label: 'relative', value: 'relative', labelKey: 'behavior.lineNumberOptions.relative' },
  { label: 'interval', value: 'interval', labelKey: 'behavior.lineNumberOptions.interval' },
];


const minimapSideOptions = [
  { label: 'left', value: 'left', labelKey: 'display.minimapPositionLeft' },
  { label: 'right', value: 'right', labelKey: 'display.minimapPositionRight' },
];


const minimapSizeOptions = [
  { label: 'proportional', value: 'proportional', labelKey: 'display.minimapSizeAuto' },
  { label: 'fill', value: 'fill', labelKey: 'display.minimapSizeFill' },
  { label: 'fit', value: 'fit', labelKey: 'display.minimapSizeFit' },
];


const renderWhitespaceOptions = [
  { label: 'none', value: 'none', labelKey: 'display.whitespaceOptions.none' },
  { label: 'boundary', value: 'boundary', labelKey: 'display.whitespaceOptions.boundary' },
  { label: 'selection', value: 'selection', labelKey: 'display.whitespaceOptions.selection' },
  { label: 'trailing', value: 'trailing', labelKey: 'display.whitespaceOptions.trailing' },
  { label: 'all', value: 'all', labelKey: 'display.whitespaceOptions.all' },
];


const renderLineHighlightOptions = [
  { label: 'none', value: 'none', labelKey: 'display.lineHighlightOptions.none' },
  { label: 'gutter', value: 'gutter', labelKey: 'display.lineHighlightOptions.gutter' },
  { label: 'line', value: 'line', labelKey: 'display.lineHighlightOptions.line' },
  { label: 'all', value: 'all', labelKey: 'display.lineHighlightOptions.all' },
];


function getPrimaryFont(fontFamily: string): string {

  const fonts = fontFamily.split(',').map(f => f.trim().replace(/^['"]|['"]$/g, ''));

  const primary = fonts[0] || '__design-system__';
  return primary;
}


function buildFontFamily(primaryFont: string): string {
  if (primaryFont === '__design-system__') return '';
  return `${JSON.stringify(primaryFont)}, ${resolveEditorFontFamily()}`;
}


function convertToSnakeCase(config: EditorConfigPartial): Record<string, any> {
  const result: Record<string, any> = {};

  if (config.fontSize !== undefined) result.font_size = config.fontSize;
  if (config.fontFamily !== undefined) result.font_family = config.fontFamily;
  if (config.fontWeight !== undefined) result.font_weight = config.fontWeight;
  if (config.lineHeight !== undefined) result.line_height = config.lineHeight;
  if (config.tabSize !== undefined) result.tab_size = config.tabSize;
  if (config.insertSpaces !== undefined) result.insert_spaces = config.insertSpaces;
  if (config.detectIndentation !== undefined) result.detect_indentation = config.detectIndentation;
  if (config.wordWrap !== undefined) result.word_wrap = config.wordWrap;
  if (config.lineNumbers !== undefined) result.line_numbers = config.lineNumbers;
  if (config.autoSave !== undefined) result.auto_save = config.autoSave;
  if (config.autoSaveDelay !== undefined) result.auto_save_delay = config.autoSaveDelay;
  if (config.formatOnSave !== undefined) result.format_on_save = config.formatOnSave;
  if (config.formatOnPaste !== undefined) result.format_on_paste = config.formatOnPaste;
  if (config.trimAutoWhitespace !== undefined) result.trim_auto_whitespace = config.trimAutoWhitespace;
  if (config.renderWhitespace !== undefined) result.render_whitespace = config.renderWhitespace;
  if (config.renderLineHighlight !== undefined) result.render_line_highlight = config.renderLineHighlight;
  if (config.cursorStyle !== undefined) result.cursor_style = config.cursorStyle;
  if (config.cursorBlinking !== undefined) result.cursor_blinking = config.cursorBlinking;
  if (config.scrollBeyondLastLine !== undefined) result.scroll_beyond_last_line = config.scrollBeyondLastLine;
  if (config.smoothScrolling !== undefined) result.smooth_scrolling = config.smoothScrolling;
  if (config.semanticHighlighting !== undefined) result.semantic_highlighting = config.semanticHighlighting;
  if (config.bracketPairColorization !== undefined) result.bracket_pair_colorization = config.bracketPairColorization;

  if (config.minimap) {
    result.minimap = {
      enabled: config.minimap.enabled,
      side: config.minimap.side,
      size: config.minimap.size,
    };
  }

  return result;
}


function convertToCamelCase(config: Record<string, any>): EditorConfigPartial {
  const result: EditorConfigPartial = {};

  if (config.font_size !== undefined) result.fontSize = config.font_size;
  if (config.font_family !== undefined) result.fontFamily = config.font_family;
  if (config.font_weight !== undefined) result.fontWeight = config.font_weight;
  if (config.line_height !== undefined) result.lineHeight = config.line_height;
  if (config.tab_size !== undefined) result.tabSize = config.tab_size;
  if (config.insert_spaces !== undefined) result.insertSpaces = config.insert_spaces;
  if (config.detect_indentation !== undefined) result.detectIndentation = config.detect_indentation;
  if (config.word_wrap !== undefined) result.wordWrap = config.word_wrap;
  if (config.line_numbers !== undefined) result.lineNumbers = config.line_numbers;
  if (config.auto_save !== undefined) result.autoSave = config.auto_save;
  if (config.auto_save_delay !== undefined) result.autoSaveDelay = config.auto_save_delay;
  if (config.format_on_save !== undefined) result.formatOnSave = config.format_on_save;
  if (config.format_on_paste !== undefined) result.formatOnPaste = config.format_on_paste;
  if (config.trim_auto_whitespace !== undefined) result.trimAutoWhitespace = config.trim_auto_whitespace;
  if (config.render_whitespace !== undefined) result.renderWhitespace = config.render_whitespace;
  if (config.render_line_highlight !== undefined) result.renderLineHighlight = config.render_line_highlight;
  if (config.cursor_style !== undefined) result.cursorStyle = config.cursor_style;
  if (config.cursor_blinking !== undefined) result.cursorBlinking = config.cursor_blinking;
  if (config.scroll_beyond_last_line !== undefined) result.scrollBeyondLastLine = config.scroll_beyond_last_line;
  if (config.smooth_scrolling !== undefined) result.smoothScrolling = config.smooth_scrolling;
  if (config.semantic_highlighting !== undefined) result.semanticHighlighting = config.semantic_highlighting;
  if (config.bracket_pair_colorization !== undefined) result.bracketPairColorization = config.bracket_pair_colorization;

  if (config.minimap) {
    result.minimap = {
      enabled: config.minimap.enabled,
      side: config.minimap.side,
      size: config.minimap.size,
    };
  }

  return result;
}

function reconcileEditorPatch(
  current: EditorConfigType,
  persisted: EditorConfigType,
  attempted: EditorConfigPartial,
): EditorConfigType {
  const next = { ...current } as Record<string, unknown>;
  const currentRecord = current as unknown as Record<string, unknown>;
  const persistedRecord = persisted as unknown as Record<string, unknown>;
  const attemptedRecord = attempted as unknown as Record<string, unknown>;

  for (const key of Object.keys(attemptedRecord)) {
    const attemptedValue = attemptedRecord[key];
    const currentValue = currentRecord[key];
    if (
      attemptedValue !== null
      && typeof attemptedValue === 'object'
      && currentValue !== null
      && typeof currentValue === 'object'
    ) {
      const currentNested = currentValue as Record<string, unknown>;
      const persistedNested = persistedRecord[key] as Record<string, unknown> | undefined;
      const attemptedNested = attemptedValue as Record<string, unknown>;
      const nextNested = { ...currentNested };
      for (const nestedKey of Object.keys(attemptedNested)) {
        if (Object.is(currentNested[nestedKey], attemptedNested[nestedKey])) {
          nextNested[nestedKey] = persistedNested?.[nestedKey];
        }
      }
      next[key] = nextNested;
    } else if (Object.is(currentValue, attemptedValue)) {
      next[key] = persistedRecord[key];
    }
  }

  return next as unknown as EditorConfigType;
}

const EditorSettingsPage: React.FC = () => {
  const { t } = useI18n('settings/editor');


  const fontWeightOptionsTranslated = [
    { label: t('appearance.fontWeightNormal'), value: 'normal' },
    { label: t('appearance.fontWeightBold'), value: 'bold' },
  ];


  const cursorStyleOptionsTranslated = cursorStyleOptions.map(o => ({ ...o, label: t(o.labelKey) }));
  const cursorBlinkingOptionsTranslated = cursorBlinkingOptions.map(o => ({ ...o, label: t(o.labelKey) }));
  const wordWrapOptionsTranslated = wordWrapOptions.map(o => ({ ...o, label: t(o.labelKey) }));
  const lineNumbersOptionsTranslated = lineNumbersOptions.map(o => ({ ...o, label: t(o.labelKey) }));
  const minimapSideOptionsTranslated = minimapSideOptions.map(o => ({ ...o, label: t(o.labelKey) }));
  const minimapSizeOptionsTranslated = minimapSizeOptions.map(o => ({ ...o, label: t(o.labelKey) }));
  const renderWhitespaceOptionsTranslated = renderWhitespaceOptions.map(o => ({ ...o, label: t(o.labelKey) }));
  const renderLineHighlightOptionsTranslated = renderLineHighlightOptions.map(o => ({ ...o, label: t(o.labelKey) }));


  const [config, setConfig] = useState<EditorConfigType>({ ...DEFAULT_EDITOR_CONFIG });
  const [isLoading, setIsLoading] = useState(true);
  const [supportsIndentDetection, setSupportsIndentDetection] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);


  const configRef = useRef<EditorConfigType>(config);
  const persistedConfigRef = useRef<EditorConfigType>(config);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveCountRef = useRef(0);
  const latestSaveRevisionRef = useRef(0);
  const saveBurstFailedRef = useRef(false);


  useEffect(() => {
    configRef.current = config;
  }, [config]);


  const loadConfig = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadFailed(false);
      const backendConfig = await configManager.getConfig<Record<string, any>>('editor');
      if (backendConfig) {
        setSupportsIndentDetection(typeof backendConfig.detect_indentation === 'boolean');
        const camelCaseConfig = convertToCamelCase(backendConfig);
        const nextConfig = { ...DEFAULT_EDITOR_CONFIG, ...camelCaseConfig };
        configRef.current = nextConfig;
        persistedConfigRef.current = nextConfig;
        setConfig(nextConfig);
      }
    } catch (error) {
      log.error('Failed to load config', error);
      setLoadFailed(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);


  const doSave = useCallback((
    patch: EditorConfigPartial,
    successMessage = t('messages.saveSuccess'),
  ): Promise<boolean> => {
    const revision = ++latestSaveRevisionRef.current;
    if (pendingSaveCountRef.current === 0) {
      saveBurstFailedRef.current = false;
      setStatusMessage(null);
    }
    pendingSaveCountRef.current += 1;
    setIsSaving(true);
    setStatusMessage(null);

    const operation = saveQueueRef.current.then(async () => {
      try {
        const snakeCasePatch = convertToSnakeCase(patch);
        const persisted = await configManager.updateConfig<Record<string, any>>(
          'editor',
          current => ({
            ...current,
            ...snakeCasePatch,
            ...(snakeCasePatch.minimap ? {
              minimap: {
                ...(current.minimap && typeof current.minimap === 'object' ? current.minimap : {}),
                ...snakeCasePatch.minimap,
              },
            } : {}),
          }),
        );
        const persistedPatch = convertToCamelCase(persisted);
        const nextPersistedConfig = {
          ...persistedConfigRef.current,
          ...patch,
          ...persistedPatch,
          ...(patch.minimap ? {
            minimap: {
              ...persistedConfigRef.current.minimap,
              ...patch.minimap,
              ...persistedPatch.minimap,
            },
          } : {}),
        };
        persistedConfigRef.current = nextPersistedConfig;
        const reconciled = reconcileEditorPatch(
          configRef.current,
          nextPersistedConfig,
          patch,
        );
        configRef.current = reconciled;
        setConfig(reconciled);
        globalEventBus.emit('editor:config:changed', persisted);
        if (revision === latestSaveRevisionRef.current && !saveBurstFailedRef.current) {
          setStatusMessage({ type: 'success', text: successMessage });
          setTimeout(() => setStatusMessage(current => (
            current?.type === 'success' ? null : current
          )), 3000);
        }
        return true;
      } catch (error) {
        log.error('Failed to save config', error);
        saveBurstFailedRef.current = true;
        const reconciled = reconcileEditorPatch(
          configRef.current,
          persistedConfigRef.current,
          patch,
        );
        configRef.current = reconciled;
        setConfig(reconciled);
        setStatusMessage({
          type: 'error',
          text: `${t('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error)),
        });
        return false;
      } finally {
        pendingSaveCountRef.current -= 1;
        if (pendingSaveCountRef.current === 0) setIsSaving(false);
      }
    });
    saveQueueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [t]);

  const updateConfig = useCallback(<K extends keyof EditorConfigType>(
    key: K,
    value: EditorConfigType[K]
  ) => {
    if (Object.is(configRef.current[key], value)) return;
    const next = { ...configRef.current, [key]: value };
    configRef.current = next;
    setConfig(next);
    void doSave({ [key]: value } as EditorConfigPartial);
    if (statusMessage?.type === 'success') {
      setStatusMessage(null);
    }
  }, [doSave, statusMessage]);

  const updateMinimapConfig = useCallback((key: keyof EditorConfigType['minimap'], value: any) => {
    const next = {
      ...configRef.current,
      minimap: {
        ...configRef.current.minimap,
        [key]: value
      }
    };
    configRef.current = next;
    setConfig(next);
    void doSave({ minimap: next.minimap });
  }, [doSave]);

  if (isLoading || loadFailed) {
    return (
      <ConfigPageLayout className="openbitfun-editor-config" data-openbitfun-component="editor-config" data-openbitfun-part="root" data-openbitfun-state="loading">
        <ConfigPageHeader
          title={t('title')}
          subtitle={t('subtitle')}
        />
        <ConfigPageContent>
          {isLoading ? (
            <ConfigLoadingState label={t('messages.loading')} />
          ) : (
            <ConfigRetryState
              message={t('messages.loadFailedLocked')}
              retryLabel={t('messages.retry')}
              onRetry={() => void loadConfig()}
            />
          )}
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  return (
    <ConfigPageLayout className="openbitfun-editor-config" data-openbitfun-component="editor-config" data-openbitfun-part="root">
      <ConfigPageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        extra={isSaving || statusMessage ? (
          <ConfigFieldStatus
            status={isSaving
              ? 'saving'
              : statusMessage?.type === 'error'
                ? 'error'
                : 'saved'}
            message={statusMessage?.text}
          />
        ) : undefined}
      />

      <ConfigPageContent className="openbitfun-editor-config__content" data-openbitfun-component="editor-config" data-openbitfun-part="content">
        <ConfigPageSection
          title={t('sections.appearance.title')}
          description={t('sections.appearance.description')}
        >
          <ConfigPageRow label={t('appearance.font')} align="center">
            <Select
              options={[{ label: t('appearance.fontDefault'), value: '__design-system__' }, ...fontFamilyOptions]}
              value={getPrimaryFont(config.fontFamily)}
              onValueChange={(v) => updateConfig('fontFamily', buildFontFamily(v as string))}
              placeholder={t('appearance.font')}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('appearance.fontWeight')} align="center">
            <Select
              options={fontWeightOptionsTranslated}
              value={config.fontWeight}
              onValueChange={(v) => updateConfig('fontWeight', v as typeof config.fontWeight)}
              placeholder={t('appearance.fontWeight')}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('appearance.fontSize')} align="center">
            <NumberInput
              value={config.fontSize}
              onValueChange={(v) => updateConfig('fontSize', Math.round(v))}
              min={10}
              max={32}
              step={1}
              unit="px"
              aria-label={t('appearance.fontSize')}
              disableWheel
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('appearance.lineHeight')} description={t('appearance.lineHeightDesc')} align="center">
            <NumberInput
              value={config.lineHeight}
              onValueChange={(v) => updateConfig('lineHeight', Math.round(v * 10) / 10)}
              min={1.0}
              max={3.0}
              step={0.1}
              precision={1}
              unit="em"
              aria-label={t('appearance.lineHeight')}
              disableWheel
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('appearance.cursorStyle')} align="center">
            <Select
              options={cursorStyleOptionsTranslated}
              value={config.cursorStyle}
              onValueChange={(v) => updateConfig('cursorStyle', v as typeof config.cursorStyle)}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('appearance.cursorBlinking')} align="center">
            <Select
              options={cursorBlinkingOptionsTranslated}
              value={config.cursorBlinking}
              onValueChange={(v) => updateConfig('cursorBlinking', v as typeof config.cursorBlinking)}
              size="sm"
            />
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('sections.behavior.title')}
          description={t('sections.behavior.description')}
        >
          <ConfigPageRow label={t('behavior.tabSize')} description={t('behavior.tabSizeDesc')} align="center">
            <NumberInput
              value={config.tabSize}
              onValueChange={(v) => updateConfig('tabSize', Math.round(v))}
              min={1}
              max={8}
              step={1}
              unit="ch"
              aria-label={t('behavior.tabSize')}
              disableWheel
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('behavior.insertSpaces')} description={t('behavior.insertSpacesDesc')} align="center">
            <Switch
              aria-label={t('behavior.insertSpaces')}
              checked={config.insertSpaces}
              onChange={(e) => updateConfig('insertSpaces', e.target.checked)}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('behavior.detectIndentation')}
            description={t(supportsIndentDetection ? 'behavior.detectIndentationDesc' : 'behavior.detectIndentationUnsupported')}
            align="center"
          >
            <Switch
              aria-label={t('behavior.detectIndentation')}
              checked={supportsIndentDetection && config.detectIndentation}
              disabled={!supportsIndentDetection}
              onChange={(e) => updateConfig('detectIndentation', e.target.checked)}
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('behavior.wordWrap')} align="center">
            <Select
              options={wordWrapOptionsTranslated}
              value={config.wordWrap}
              onValueChange={(v) => updateConfig('wordWrap', v as typeof config.wordWrap)}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('behavior.lineNumbers')} align="center">
            <Select
              options={lineNumbersOptionsTranslated}
              value={config.lineNumbers}
              onValueChange={(v) => updateConfig('lineNumbers', v as typeof config.lineNumbers)}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('behavior.smoothScrolling')} align="center">
            <Switch
              checked={config.smoothScrolling}
              onChange={(e) => updateConfig('smoothScrolling', e.target.checked)}
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('behavior.scrollBeyondLastLine')} description={t('behavior.scrollBeyondLastLineDesc')} align="center">
            <Switch
              checked={config.scrollBeyondLastLine}
              onChange={(e) => updateConfig('scrollBeyondLastLine', e.target.checked)}
            />
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('sections.display.title')}
          description={t('sections.display.description')}
        >
          <ConfigPageRow label={t('display.minimap')} description={t('display.minimapDesc')} align="center">
            <Switch
              checked={config.minimap.enabled}
              onChange={(e) => updateMinimapConfig('enabled', e.target.checked)}
            />
          </ConfigPageRow>
          {config.minimap.enabled && (
            <>
              <ConfigPageRow label={t('display.minimapPosition')} align="center">
                <Select
                  options={minimapSideOptionsTranslated}
                  value={config.minimap.side}
                  onValueChange={(v) => updateMinimapConfig('side', v as string)}
                  size="sm"
                />
              </ConfigPageRow>
              <ConfigPageRow label={t('display.minimapSize')} align="center">
                <Select
                  options={minimapSizeOptionsTranslated}
                  value={config.minimap.size}
                  onValueChange={(v) => updateMinimapConfig('size', v as string)}
                  size="sm"
                />
              </ConfigPageRow>
            </>
          )}
          <ConfigPageRow label={t('display.whitespace')} align="center">
            <Select
              options={renderWhitespaceOptionsTranslated}
              value={config.renderWhitespace}
              onValueChange={(v) => updateConfig('renderWhitespace', v as typeof config.renderWhitespace)}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('display.lineHighlight')} align="center">
            <Select
              options={renderLineHighlightOptionsTranslated}
              value={config.renderLineHighlight}
              onValueChange={(v) => updateConfig('renderLineHighlight', v as typeof config.renderLineHighlight)}
              size="sm"
            />
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('sections.advanced.title')}
          description={t('sections.advanced.description')}
        >
          <ConfigPageRow label={t('advanced.semanticHighlighting')} description={t('advanced.semanticHighlightingDesc')} align="center">
            <Switch
              checked={config.semanticHighlighting}
              onChange={(e) => updateConfig('semanticHighlighting', e.target.checked)}
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('advanced.bracketPairColorization')} description={t('advanced.bracketPairColorizationDesc')} align="center">
            <Switch
              checked={config.bracketPairColorization}
              onChange={(e) => updateConfig('bracketPairColorization', e.target.checked)}
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('advanced.formatOnSave')} align="center">
            <Switch
              checked={config.formatOnSave}
              onChange={(e) => updateConfig('formatOnSave', e.target.checked)}
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('advanced.formatOnPaste')} align="center">
            <Switch
              checked={config.formatOnPaste}
              onChange={(e) => updateConfig('formatOnPaste', e.target.checked)}
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('advanced.trimAutoWhitespace')} description={t('advanced.trimAutoWhitespaceDesc')} align="center">
            <Switch
              checked={config.trimAutoWhitespace}
              onChange={(e) => updateConfig('trimAutoWhitespace', e.target.checked)}
            />
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigMessage message={statusMessage} />
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default EditorSettingsPage;
