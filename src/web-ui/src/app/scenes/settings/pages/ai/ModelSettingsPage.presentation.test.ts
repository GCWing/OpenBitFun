import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./ModelSettingsPage.tsx', import.meta.url)),
  'utf8',
);
const styles = readFileSync(
  fileURLToPath(new URL('./ModelSettingsPage.scss', import.meta.url)),
  'utf8',
);

describe('ModelSettingsPage presentation', () => {
  it('uses intentional separators instead of Unicode replacement characters', () => {
    expect(source).not.toContain('\uFFFD');
    expect(source.match(/\{' · '\}/g)).toHaveLength(2);
  });

  it('declares required model fields structurally instead of embedding asterisks in label copy', () => {
    expect(source).not.toMatch(/label=\{`[^`]*\*[^`]*`\}/);
    expect(source.match(/<ConfigPageRow label=\{t\('form\.configName'\)\} required/g)).toHaveLength(2);
    expect(source.match(/<ConfigPageRow label=\{t\('form\.modelSelection'\)\} required/g)).toHaveLength(2);
    // Template and custom-provider editors both require an API URL.
    expect(source.match(/<ConfigPageRow label=\{t\('form\.baseUrl'\)\} required/g)).toHaveLength(2);
    expect(source).toContain('<ConfigPageRow label={label} required align="center" wide>');
  });

  it('preserves the intrinsic width of design-system switches in edit rows', () => {
    expect(styles.match(/> :not\(\[data-openbitfun-component='switch'\]\)/g)).toHaveLength(2);
    expect(styles).not.toMatch(/> \* \{\s*min-width: 0;\s*width: 100%/);
    expect(styles).not.toMatch(/> \* \{\s*width: auto;\s*max-width: none;/);
  });

  it('lets advanced mode actions align to the right edge of their rows', () => {
    expect(styles).toMatch(
      /&__custom-headers-row,\s*&__custom-request-body-row\s*\{\s*> \.openbitfun-config-page-row__meta\s*\{\s*width: 100%;\s*max-width: none;/,
    );
    expect(styles).toMatch(/&__inline-header-actions\s*\{[\s\S]*?margin-left: auto;/);
  });

  it('keeps subscription actions right-aligned through the shared compact breakpoint', () => {
    expect(styles).toMatch(
      /@container config-panel \(max-width: 520px\)\s*\{\s*&__cli-account\.openbitfun-config-page-row\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*?gap: var\(--openbitfun-space-4\);[\s\S]*?justify-content: flex-end;/,
    );
    expect(styles).toMatch(
      /@container config-panel \(max-width: 360px\)\s*\{\s*&__cli-account\.openbitfun-config-page-row\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?gap: var\(--openbitfun-space-2\);[\s\S]*?justify-content: flex-start;/,
    );
  });
});
