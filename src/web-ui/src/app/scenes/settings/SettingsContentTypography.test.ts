import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

const headerComponent = readSource('../../../infrastructure/config/components/common/ConfigPageHeader.tsx');
const headerStyles = readSource('../../../infrastructure/config/components/common/ConfigPageHeader.scss');
const pageHeaderStyles = readSource('../../../../../../design-system/packages/ui/src/components/PageHeader/PageHeader.module.css');
const layoutStyles = readSource('../../../infrastructure/config/components/common/ConfigPageLayout.scss');
const formStyles = readSource('../../../infrastructure/config/components/ConfigForm.scss');
const appearanceStyles = readSource('./pages/application/AppearanceSettingsPage.scss');
const shortcutStyles = readSource('./pages/application/KeyboardShortcutsSection.scss');

describe('Settings content typography', () => {
  it('maps the shared settings hierarchy to canonical semantic type roles', () => {
    expect(headerComponent).toContain("import { PageHeader } from '@openbitfun/ui'");
    expect(headerComponent).toContain('<PageHeader');
    expect(headerComponent).toContain('size="md"');

    expect(headerStyles).not.toMatch(/(?:^|[;{])\s*(?:font(?:-[\w-]+)?|line-height|letter-spacing)\s*:/m);
    expect(pageHeaderStyles).toContain('font-size: var(--openbitfun-type-heading-page-font-size);');
    expect(pageHeaderStyles).toContain('font-weight: var(--openbitfun-type-heading-page-font-weight);');
    expect(pageHeaderStyles).toContain('font-size: var(--openbitfun-type-body-lg-font-size);');
    expect(pageHeaderStyles).toContain('font-weight: var(--openbitfun-type-body-lg-font-weight);');

    expect(layoutStyles).toContain('font-size: var(--openbitfun-type-heading-section-font-size);');
    expect(layoutStyles).toContain('font-weight: var(--openbitfun-type-heading-section-font-weight);');
    expect(layoutStyles).toContain('font-size: var(--openbitfun-type-body-sm-font-size);');
    expect(layoutStyles).toContain('font-weight: var(--openbitfun-type-body-sm-font-weight);');
    expect(layoutStyles).toContain('font-size: var(--openbitfun-type-label-selected-font-size);');
    expect(layoutStyles).toContain('font-weight: var(--openbitfun-type-label-selected-font-weight);');
    expect(layoutStyles).toContain('font-size: var(--openbitfun-type-support-font-size);');
    expect(layoutStyles).toContain('line-height: var(--openbitfun-type-modifier-leading-support-line-height);');
  });

  it('keeps legacy config form labels and helper copy on the same hierarchy', () => {
    expect(formStyles).toContain('font-size: var(--openbitfun-type-label-selected-font-size);');
    expect(formStyles).toContain('font-weight: var(--openbitfun-type-label-selected-font-weight);');
    expect(formStyles).toContain('font-size: var(--openbitfun-type-support-font-size);');
    expect(formStyles).toContain('line-height: var(--openbitfun-type-modifier-leading-support-line-height);');
    expect(formStyles).toContain('color: var(--openbitfun-color-content-required-indicator);');
  });

  it('does not let individual settings pages shrink shared headings or subtitles', () => {
    expect(appearanceStyles).not.toContain('.openbitfun-config-page-section__title');
    expect(appearanceStyles).not.toContain('.openbitfun-config-page-section__description');
    expect(shortcutStyles).not.toContain('.openbitfun-config-page-header__subtitle');
  });
});
