import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readLocalFile(fileName: string): string {
  return readFileSync(
    fileURLToPath(new URL(fileName, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

describe('CreateAgentPage presentation contract', () => {
  it('shares the same ordered form sections between the page and dialog', () => {
    const source = readLocalFile('./CreateAgentPage.tsx');

    expect(source).not.toMatch(/openbitfun-(?:mark|app-icon)/);
    expect(source).toContain('th-create-page__panel--definition');
    expect(source).toContain('th-create-page__panel--capabilities');
    expect(source.match(/data-openbitfun-part="column"/g)).toHaveLength(2);
    expect(source).toContain("t('agentsOverview.form.basicInformation')");
    expect(source).toContain("t('agentsOverview.form.contextPolicy')");
    expect(source).toContain("t('agentsOverview.form.prompt')");
    expect(source).not.toContain('th-create-page__divider');
  });

  it('keeps the primary creation path keyboard- and state-aware', () => {
    const source = readLocalFile('./CreateAgentPage.tsx');

    expect(source).toContain('id={formId}');
    expect(source).toContain('form={formId}');
    expect(source).toContain('onSubmit={(event) => {');
    expect(source).toContain('aria-pressed={kind === candidateKind}');
    expect(source).toContain('aria-pressed={level === candidateLevel}');
    expect(source).toContain('aria-pressed={isSelected}');
  });

  it('keeps context injection controls with the prompt without changing authored text', () => {
    const source = readLocalFile('./CreateAgentPage.tsx');

    expect(source).toContain('data-openbitfun-part="contextPreview"');
    expect(source).toContain('onClick={() => toggleContextSection(section)}');
    expect(source).toContain("aria-describedby={`${fieldId('runtime-context-preview')}");
    expect(source).toContain('value={prompt}');
  });

  it('keeps the page content frame and delegates guided layout to the design system', () => {
    const stylesheet = readLocalFile('./CreateAgentPage.scss');
    const source = readLocalFile('./CreateAgentPage.tsx');

    expect(stylesheet).toContain(
      'grid-template-columns: minmax(0, 1fr);',
    );
    expect(stylesheet).toMatch(
      /\.th-create-page__inner \{\s*@include configLayout.content-frame;/,
    );
    expect(stylesheet).toMatch(
      /\.th-create-page__footer-inner \{\s*@include configLayout.content-frame;/,
    );
    expect(stylesheet).not.toContain(
      'var(--openbitfun-color-action-neutral-surface) 84%',
    );
    expect(stylesheet).toMatch(
      /\.th-create-panel__context-options \{[\s\S]*display: flex;[\s\S]*flex-wrap: wrap;/,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.th-create-panel__identity-fields[\s\S]*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(source).toContain('<SetupWizard');
    expect(source).toContain("contentMode={step === 1 ? 'contained' : 'scroll'}");
    expect(stylesheet).not.toContain('th-create-page__guide');
    expect(stylesheet).not.toContain('th-create-dialog__header');
  });
});
