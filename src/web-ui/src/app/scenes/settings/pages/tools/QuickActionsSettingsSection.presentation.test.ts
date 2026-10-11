import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./QuickActionsSettingsSection.tsx', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

describe('QuickActionsConfig draft lifecycle', () => {
  it('delegates editor save, discard, and unload protection to the shared Settings owner', () => {
    expect(source).toContain('useSettingsDraft({');
    expect(source).toContain("id: 'quick-action-editor'");
    expect(source).toContain("pageId: 'tools.automation'");
    expect(source).not.toContain("viewId: 'quick-actions'");
    expect(source).toContain("requestSettingsDraftExit(['quick-action-editor'], onClose)");
    expect(source).toContain('onSubmit: (label: string, prompt: string) => Promise<boolean>');
    expect(source).toContain('return saved;');
    expect(source).not.toContain("addEventListener('beforeunload'");
    expect(source).not.toContain('discardConfirmOpen');
  });

  it('keeps the add action without an empty-state prompt', () => {
    expect(source).toContain('customActions.length > 0 && (');
    expect(source).toContain("{t('add.button')}");
    expect(source).not.toContain('<Empty');
    expect(source).not.toContain('sections.custom.empty');
    expect(source).not.toContain('quick-actions-config__empty');
  });
});
