import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(): string {
  return readFileSync(
    fileURLToPath(new URL('./WebSearchSettingsPage.tsx', import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

describe('WebSearch settings presentation', () => {
  it('keeps secrets out of generic config writes and preserves the settings draft lifecycle', () => {
    const source = readSource();

    expect(source).toContain("configAPI.setConfig('ai.web_search', config)");
    expect(source).toContain('configAPI.saveWebSearchCredential');
    expect(source).toContain('configAPI.clearWebSearchCredential');
    expect(source).toContain('useNotification()');
    expect(source).toContain("notifySuccess(t('messages.saved'))");
    expect(source).not.toContain("setMessage({ type: 'success'");
    expect(source).not.toContain('web-search-settings__provider-select');
    expect(source).toContain('<ConfigActionBar');
    expect(source).toContain('<ConfigMessage message={operationMessage} />');
    expect(source).not.toContain('<ConfigMessage message={draftMessage} />');
    expect(source).toContain('useSettingsDraft({');
    expect(source).toContain("id: 'web-search-settings'");
    expect(source).toContain('<ConfigRetryState');
    expect(source).not.toContain('icon={<Save />}');
    expect(source).toContain('setSavedConfig(config)');
    expect(source).toContain("title={t('sections.protocol.title')}");
    expect(source).toContain("aria-label={t('actions.copyProtocol')}");
    expect(source).toContain('icon={<Icon name="duplicate" size="sm" />}');
    expect(source).not.toMatch(/import\s*\{[^}]*\bCopy\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(source).toContain('copyTextToClipboard([');
    expect(source.indexOf("title={t('sections.protocol.title')}")).toBeGreaterThan(
      source.indexOf("title={t('sections.credential.title')}"),
    );
    expect(source).toContain('OPENBITFUN_PROTOCOL_REQUEST_EXAMPLE');
    expect(source).toContain('OPENBITFUN_PROTOCOL_SUCCESS_EXAMPLE');
    expect(source).toContain('OPENBITFUN_PROTOCOL_ERROR_EXAMPLE');
    expect(source).toContain('OPENBITFUN_PROTOCOL_ERROR_CODES');
    expect(source).not.toContain('<code>{OPENBITFUN_PROTOCOL_ERROR_CODES}</code>');
    expect(source).not.toContain("t('fields.fallback.");
    expect(source).not.toContain("t('fields.apply.");
    expect(source).not.toContain("t('sections.apply.");
    expect(source).not.toContain("t('fields.credentialActions.");
    expect(source).not.toContain("t('fields.trust.");
    expect(source).toContain('className="web-search-settings__credential-status"');
    expect(source).not.toContain('web-search-settings__credential-field');
    expect(source).toContain("saveLabel={credential.trim() ? t('actions.saveCredential') : t('actions.saveConfiguration')}");
    expect(source).not.toContain('onClick={() => void handleSaveCredential()}');
    expect(source.match(/ balanced>/g)).toHaveLength(2);
    expect(source).not.toContain("setConfig('ai.web_search', credential");
    expect(source).not.toContain('fallbackProvider');
    expect(source).not.toContain('@tauri-apps/api');
  });
});
