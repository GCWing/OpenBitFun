import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./SessionTitleSection.tsx', import.meta.url)),
  'utf8',
);

describe('SessionTitleSection presentation', () => {
  it('keeps the enable switch in a content row instead of the section heading', () => {
    const sectionStart = source.lastIndexOf('<ConfigPageSection');
    const sectionEnd = source.indexOf('</ConfigPageSection>', sectionStart);
    const section = source.slice(sectionStart, sectionEnd);
    const enableRowStart = section.indexOf("label={t('sessionTitle.enable')}");
    const modelConditionStart = section.indexOf('{settings?.enable_session_title_generation ? (');
    const modelRowStart = section.indexOf("label={t('sessionTitle.model.label')}");
    const enableRowEnd = section.indexOf('</ConfigPageRow>', enableRowStart);
    const enableRow = section.slice(enableRowStart, enableRowEnd);

    expect(section).not.toContain('extra={(');
    expect(enableRowStart).toBeGreaterThan(-1);
    expect(modelConditionStart).toBeGreaterThan(enableRowStart);
    expect(modelRowStart).toBeGreaterThan(modelConditionStart);
    expect(enableRow).toContain('data-openbitfun-part="enableControl"');
    expect(enableRow).toContain('<Switch');
  });
});
