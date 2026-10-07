import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

describe('VoiceSettingsSection status presentation', () => {
  it('renders setup and ready states as compact body copy', () => {
    const source = readSource('./VoiceSettingsSection.tsx');
    const styles = readSource('../../../../../infrastructure/config/components/VoiceInputConfig.scss');
    const plainStateRule = styles.match(/&--setup,\s*&--ready\s*{([^}]*)}/)?.[1] ?? '';
    const summaryRule = styles.match(/&__status-summary\s*{([^}]*)}/)?.[1] ?? '';
    const warningRule = styles.match(/&__status-warning\s*{([^}]*)}/)?.[1] ?? '';
    const modelRule = styles.match(/&__status-model\s*{([^}]*)}/)?.[1] ?? '';

    expect(source).toMatch(/status === 'ready' \|\| status === 'setup'\s*\? null/);
    expect(source).toContain('i18nKey="status.setup.summary"');
    expect(source).toContain('i18nKey="status.ready.summary"');
    expect(source).toContain('className="voice-input-config__status-model"');
    expect(source).not.toContain('check-circle');
    expect(source).not.toContain('leadingIcon={<HardDrive');
    expect(source).not.toContain('handleDownload');
    expect(source).not.toContain('status.downloadAndEnable');
    expect(source).toContain("variant={status === 'setup' ? 'primary' : 'outline'}");
    expect(source).toMatch(/case 'setup':\s*return 'status\.downloadModel'/);
    expect(plainStateRule).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(plainStateRule).toContain('padding: 0');
    expect(summaryRule).toContain('font-family: var(--openbitfun-type-body-sm-font-family)');
    expect(summaryRule).toContain('font-size: var(--openbitfun-type-body-sm-font-size)');
    expect(summaryRule).toContain('line-height: var(--openbitfun-type-body-sm-line-height)');
    expect(summaryRule).toContain('text-align: start');
    expect(warningRule).toContain('color: var(--openbitfun-color-status-warning-emphasis)');
    expect(modelRule).toContain('color: var(--openbitfun-color-content-primary)');
    expect(modelRule).toContain('font-weight: var(--openbitfun-type-label-selected-font-weight)');
  });

  it('reveals language and diagnostic controls only after the local model is ready', () => {
    const source = readSource('./VoiceSettingsSection.tsx');
    const styles = readSource('../../../../../infrastructure/config/components/VoiceInputConfig.scss');
    const readyControls = source.match(
      /\{status === 'ready' \? \(\s*<>([\s\S]*?)<\/>(?:\s*)\) : null\}/,
    )?.[1] ?? '';
    const languageRow = readyControls.match(
      /<ConfigPageRow[\s\S]*?label=\{t\('composer\.language\.label'\)\}[\s\S]*?>/,
    )?.[0] ?? '';
    expect(readyControls).toContain("label={t('composer.language.label')}");
    expect(languageRow).not.toContain('voice-input-config__balanced-row');
    expect(readyControls).toContain('<VoiceInputDiagnostics');
    expect(source).not.toContain('voice-input-config__credential-input');
    expect(styles).not.toContain('&__credential-input');
    expect(source).not.toContain('modelInstalled=');
    expect(source).not.toContain('unavailableReason=');
  });

  it('uses precise lifecycle states and state-specific model actions', () => {
    const source = readSource('./VoiceSettingsSection.tsx');
    const actionKeyFunction = source.match(
      /function statusActionKey\([\s\S]*?\n}/,
    )?.[0] ?? '';

    expect(source).toMatch(/case 'verifying':\s*status = 'verifying'/);
    expect(source).toMatch(/case 'deleting':\s*status = 'deleting'/);
    expect(actionKeyFunction).toMatch(
      /case 'downloading':\s*case 'verifying':\s*case 'deleting':\s*return 'status\.viewDetails'/,
    );
    expect(actionKeyFunction).toMatch(/case 'error':\s*return 'status\.repair'/);
    expect(source).toContain('{t(statusActionKey(status))}');
    expect(source).toContain("{status === 'downloading' && selectedModel ? (");
  });

  it('uses concise, action-oriented setup copy in every supported locale', () => {
    const locales = [
      JSON.parse(readSource('../../../../../locales/en-US/settings/voice-input.json')),
      JSON.parse(readSource('../../../../../locales/zh-CN/settings/voice-input.json')),
      JSON.parse(readSource('../../../../../locales/zh-TW/settings/voice-input.json')),
    ];

    for (const locale of locales) {
      expect(locale.status.setup.summary).not.toContain('SenseVoice');
      expect(locale.status.setup.summary).not.toContain('{{model}}');
      expect(locale.status.setup.summary).toContain('<warning>');
      expect(locale.status.setup.summary).not.toContain('{{size}}');
      expect(locale.status.ready.summary).toContain('<model>{{model}}</model>');
      expect(locale.status.downloadModel).toBeTruthy();
      expect(locale.status.viewDetails).toBeTruthy();
      expect(locale.status.manageModels).toBeTruthy();
      expect(locale.status.repair).toBeTruthy();
      for (const state of ['ready', 'downloading', 'verifying', 'deleting', 'unavailable', 'error']) {
        expect(locale.status[state].badge).toBeTruthy();
        expect(locale.status[state].title).toBeTruthy();
        expect(locale.status[state].description).toBeTruthy();
      }
      expect(locale.diagnostics.recognition).not.toHaveProperty('modelRequired');
      expect(locale.diagnostics.recognition).not.toHaveProperty('cloudUnavailable');
    }

    expect(locales[1].status.manageModels).toBe('管理模型');
    expect(locales[1].status.viewDetails).toBe('查看详情');
    expect(locales[1].status.ready.summary).toBe('已下载模型：<model>{{model}}</model>');
    expect(locales[1].status.downloading.title).toBe('正在下载语音模型');
    expect(locales[1].status.downloading.description).not.toContain('校验');
  });
});
