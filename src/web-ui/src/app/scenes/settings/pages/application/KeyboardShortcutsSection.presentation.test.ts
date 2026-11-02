import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSibling(filename: string): string {
  return readFileSync(
    fileURLToPath(new URL(filename, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

describe('Keyboard shortcuts design-system composition', () => {
  it('shows one continuous list without scope subcategories', () => {
    const source = readSibling('./KeyboardShortcutsSection.tsx');
    expect(source).not.toContain('SCOPE_DISPLAY_ORDER');
    expect(source).not.toContain('SCOPE_LABEL_KEYS');
    expect(source).not.toContain('scopeDescriptions');
    expect(source.match(/<ConfigPageSection\b/g)).toHaveLength(1);
    expect(source.match(/className="kb-shortcuts__list"/g)).toHaveLength(1);
    expect(source).toContain('<FieldGroup appearance="subtle" fieldSurface="ambient" dividers={false}>');
  });
  it('uses shared controls for shortcut badges and revert actions', () => {
    const source = readSibling('./KeyboardShortcutsSection.tsx');
    const stylesheet = readSibling('./KeyboardShortcutsSection.scss');
    const appearance = readSibling('./KeyboardShortcutsSection.appearance.ts');

    expect(source).toContain('IconButton');
    expect(source).toContain("variant={isRecording ? 'primary' : 'outline'}");
    expect(source).not.toContain('NON_USER_CUSTOMIZABLE_SHORTCUT_IDS');
    expect(source).not.toContain('KeyHint');
    expect(source).not.toMatch(/<(?:button|kbd)\b/);
    expect(stylesheet).not.toContain('kb-shortcuts__keybadge');
    expect(stylesheet).not.toContain('kb-shortcuts__revert-btn');
    expect(appearance).not.toMatch(/\{ id: '(?:keyBadge|revert)' \}/);
    expect(appearance).not.toContain("{ id: 'readonly'");
  });
});
