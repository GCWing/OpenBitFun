import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(): string {
  return readFileSync(
    fileURLToPath(new URL('./MemorySettingsSection.tsx', import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

describe('Memory settings presentation', () => {
  it('uses the shared settings section for advanced controls', () => {
    const source = readSource();
    const advancedStart = source.indexOf("title={t('sections.advanced.title')}");
    const advancedEnd = source.indexOf('</ConfigPageSection>', advancedStart);
    const advancedSection = source.slice(advancedStart, advancedEnd);

    expect(advancedStart).toBeGreaterThan(-1);
    expect(advancedEnd).toBeGreaterThan(advancedStart);
    expect(source).not.toContain("import '@/infrastructure/config/components/MemoriesConfig.scss';");
    expect(source).not.toContain('<details');
    expect(advancedSection).toContain("description={t('sections.advanced.description')}");
    expect(advancedSection).toContain('aria-expanded={advancedOpen}');
    expect(advancedSection).toContain('{advancedOpen && (');
  });

  it('places memory actions in Basics instead of the page header', () => {
    const source = readSource();
    const contentStart = source.indexOf('<ConfigPageSectionStack>', source.indexOf('const memoryEnabled'));
    const headerStart = source.lastIndexOf('<ConfigPageHeader', contentStart);
    const header = source.slice(headerStart, contentStart);
    const basicStart = source.indexOf("title={t('sections.basic.title')}", contentStart);
    const basicEnd = source.indexOf('</ConfigPageSection>', basicStart);
    const basicSection = source.slice(basicStart, basicEnd);

    expect(contentStart).toBeGreaterThan(-1);
    expect(headerStart).toBe(-1);
    expect(basicStart).toBeGreaterThan(contentStart);
    expect(basicEnd).toBeGreaterThan(basicStart);
    expect(header).not.toContain('extra=');
    expect(header).not.toContain('<MenuPopover');
    expect(basicSection).toContain("label={t('fields.memoryActions.label')}");
    expect(basicSection).toContain("description={t('fields.memoryActions.description')}");
    expect(basicSection).toContain('<MenuPopover');
    expect(basicSection).toContain("{t('actions.manage')}");
    expect(source).toContain("id: 'open-directory'");
    expect(source).toContain("id: 'reset-settings'");
    expect(source).toContain("id: 'clear-memory'");
    expect(source).toContain("tone: 'danger'");
  });
});
