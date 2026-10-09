// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Combobox,
  Input,
  MultiSelect,
  NumberInput,
  SearchField,
  Select,
  Switch,
} from '@openbitfun/ui';
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ConfigPageHeader } from './ConfigPageHeader';
import {
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageRow,
  ConfigPageSection,
  ConfigPageSectionStack,
} from './ConfigPageLayout';

function readStyleFixture(name: string): string {
  return readFileSync(
    resolve(process.cwd(), `src/infrastructure/config/components/common/${name}`),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

describe('ConfigPageLayout', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('preserves the standard section stack inside a shared wrapper', () => {
    act(() => {
      root.render(
        <ConfigPageContent>
          <ConfigPageSectionStack data-testid="section-stack">
            <ConfigPageSection title="First">
              <div>First body</div>
            </ConfigPageSection>
            <ConfigPageSection title="Second">
              <div>Second body</div>
            </ConfigPageSection>
          </ConfigPageSectionStack>
        </ConfigPageContent>,
      );
    });

    const contentInner = container.querySelector('.openbitfun-config-page-content__inner');
    const stack = container.querySelector('[data-testid="section-stack"]');

    expect(contentInner?.children).toHaveLength(1);
    expect(contentInner?.firstElementChild).toBe(stack);
    expect(stack?.classList.contains('openbitfun-config-page-section-stack')).toBe(true);
    expect(stack?.querySelectorAll(':scope > .openbitfun-config-page-section')).toHaveLength(2);
  });

  it('uses the public PageHeader while preserving appearance extension targets', () => {
    act(() => root.render(<ConfigPageHeader title="Models" subtitle="Provider configuration" extra={<button>Import</button>} />));
    const header = container.querySelector('[data-openbitfun-component="page-header"]');
    expect(header?.getAttribute('data-size')).toBe('md');
    expect(header?.querySelector('h2')?.textContent).toBe('Models');
    expect(header?.querySelector('[data-openbitfun-part="pageHeaderTitle"]')?.textContent).toBe('Models');
    expect(header?.querySelector('[data-openbitfun-part="pageHeaderSubtitle"]')?.textContent).toBe('Provider configuration');
    expect(container.querySelector('[data-openbitfun-part="pageHeaderExtra"] button')?.textContent).toBe('Import');
  });

  it('removes sentence periods from standalone copy while preserving ellipses', () => {
    act(() => {
      root.render(
        <>
          <ConfigPageHeader title="Models" subtitle="Configure model providers." />
          <ConfigPageSection title="Appearance" description="选择界面外观。">
            <ConfigPageRow label="Loading state" description="Loading...">
              <div>Control</div>
            </ConfigPageRow>
          </ConfigPageSection>
        </>,
      );
    });

    expect(container.querySelector('[data-openbitfun-part="pageHeaderSubtitle"]')?.textContent)
      .toBe('Configure model providers');
    expect(container.querySelector('[data-openbitfun-part="sectionDescription"]')?.textContent)
      .toBe('选择界面外观');
    expect(container.querySelector('[data-openbitfun-part="rowDescription"]')?.textContent)
      .toBe('Loading...');
  });

  it('keeps the compact 680px settings geometry from the shared layout contract', () => {
    const tokens = readStyleFixture('config-page-layout.tokens.scss');
    const layout = readStyleFixture('ConfigPageLayout.scss');
    const header = readStyleFixture('ConfigPageHeader.scss');

    expect(tokens).toContain('$config-page-content-max-width: 680px;');
    expect(layout).toContain('--config-page-section-gap: 36px;');
    expect(layout).toContain('--row-grid-cols: minmax(0, 1fr) minmax(0, 150px);');
    expect(layout).toContain('gap: 40px;');
    const sectionBodyRule = layout.match(/\.openbitfun-config-page-section__body\s*\{([\s\S]*?)\}/)?.[1];
    expect(sectionBodyRule?.trim()).toBe('min-width: 0;');
    expect(layout).not.toContain('--openbitfun-component-config-page-section-background');
    expect(header).toContain('margin-bottom: 36px;');
  });

  it('keeps intrinsic controls out of the full-width field contract', () => {
    const layout = readStyleFixture('ConfigPageLayout.scss');

    act(() => {
      root.render(
        <>
          <ConfigPageRow label="Automatic updates">
            <Switch aria-label="Automatic updates" />
          </ConfigPageRow>
          <ConfigPageRow label="Workspace name">
            <Input aria-label="Workspace name" />
          </ConfigPageRow>
        </>,
      );
    });

    const controls = container.querySelectorAll('.openbitfun-config-page-row__control');
    const switchRoot = controls[0]?.querySelector('[data-openbitfun-component="switch"]');
    const inputRoot = controls[1]?.querySelector('[data-openbitfun-component="input"]');

    expect(controls[0]?.firstElementChild).toBe(switchRoot);
    expect(controls[1]?.firstElementChild).toBe(inputRoot);
    expect(layout).toContain("[data-openbitfun-component='input']");
    expect(layout).toContain("[data-openbitfun-component='number-input']");
    expect(layout).not.toContain("[data-openbitfun-component='switch']");
    expect(layout).not.toContain('> :where(span, div)');
  });

  it('gives ordinary single-line settings fields one shared responsive width', () => {
    const layout = readStyleFixture('ConfigPageLayout.scss');

    act(() => {
      root.render(
        <>
          <ConfigPageRow label="Language">
            <Select options={[{ label: 'English', value: 'en' }]} value="en" />
          </ConfigPageRow>
          <ConfigPageRow label="Shell" balanced>
            <Combobox options={[{ label: 'PowerShell', value: 'pwsh' }]} value="pwsh" />
          </ConfigPageRow>
          <ConfigPageRow label="Models">
            <MultiSelect options={[{ label: 'Primary', value: 'primary' }]} value={['primary']} />
          </ConfigPageRow>
          <ConfigPageRow label="Workspace name">
            <Input aria-label="Workspace name" />
          </ConfigPageRow>
          <ConfigPageRow label="Search">
            <SearchField aria-label="Search" />
          </ConfigPageRow>
          <ConfigPageRow label="Timeout" balanced>
            <div>
              <NumberInput aria-label="Timeout" value={30} onValueChange={() => undefined} />
            </div>
          </ConfigPageRow>
          <ConfigPageRow label="Provider endpoint" wide>
            <Input aria-label="Provider endpoint" />
          </ConfigPageRow>
        </>,
      );
    });

    const rows = container.querySelectorAll<HTMLElement>('.openbitfun-config-page-row');
    const standardControlRules = layout.match(
      /\/\/ Ordinary single-field rows[\s\S]*?(?=\.openbitfun-config-page-section__extra)/,
    )?.[0] ?? '';

    expect(rows).toHaveLength(7);
    expect(rows[1]?.classList.contains('openbitfun-config-page-row--balanced')).toBe(true);
    expect(rows[5]?.classList.contains('openbitfun-config-page-row--balanced')).toBe(true);
    expect(rows[6]?.classList.contains('openbitfun-config-page-row--wide')).toBe(true);
    expect(rows[1]?.style.gridTemplateColumns).toBe('');
    expect(rows[6]?.style.gridTemplateColumns).toBe('');
    expect(container.querySelector('[data-openbitfun-component="select"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-component="combobox"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-component="multi-select"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-component="input"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-component="search-field"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-component="number-input"]')).not.toBeNull();
    expect(standardControlRules).toContain('.openbitfun-config-page-row--wide');
    expect(standardControlRules).toContain(':only-child');
    expect(standardControlRules).toContain("[data-openbitfun-component='input']");
    expect(standardControlRules).toContain("[data-openbitfun-component='search-field']");
    expect(standardControlRules).toContain("[data-openbitfun-component='number-input']");
    expect(standardControlRules).toContain("[data-openbitfun-component='select']");
    expect(standardControlRules).toContain("[data-openbitfun-component='combobox']");
    expect(standardControlRules).toContain("[data-openbitfun-component='multi-select']");
    expect(standardControlRules).not.toContain("[data-openbitfun-component='textarea']");
    expect(standardControlRules).toContain('var(--openbitfun-overlay-menu-inline-size)');
    expect(layout).toMatch(
      /\.openbitfun-config-page-section__extra > :where\([\s\S]*?max-inline-size:\s*var\(--openbitfun-overlay-menu-inline-size\);/,
    );
    expect(layout).toMatch(
      /@container config-panel \(max-width: 520px\)[\s\S]*?\.openbitfun-config-page-section__extra > :where\([\s\S]*?inline-size:\s*100%;[\s\S]*?max-inline-size:\s*none;/,
    );
  });

  it('renders required state as structured label anatomy with the shared semantic color', () => {
    const layout = readStyleFixture('ConfigPageLayout.scss');

    act(() => {
      root.render(
        <ConfigPageRow label="Provider name" required>
          <Input aria-label="Provider name" required />
        </ConfigPageRow>,
      );
    });

    const row = container.querySelector('.openbitfun-config-page-row');
    const marker = row?.querySelector('[data-openbitfun-part="required"]');
    const input = row?.querySelector('input');

    expect(row?.getAttribute('data-required')).toBe('true');
    expect(marker?.textContent).toBe('*');
    expect(marker?.getAttribute('aria-hidden')).toBe('true');
    expect(marker?.getAttribute('data-openbitfun-component')).toBe('config');
    expect(input?.required).toBe(true);
    expect(layout).toMatch(/\.openbitfun-config-page-row__required\s*\{[\s\S]*?--openbitfun-color-content-required-indicator/);
  });

  it('strips the body surface chrome when the section opts out of the standard surface', () => {
    act(() => {
      root.render(
        <ConfigPageSection title="Managed" bodySurface={false}>
          <div>Body</div>
        </ConfigPageSection>,
      );
    });

    const section = container.querySelector('.openbitfun-config-page-section');
    const body = container.querySelector('.openbitfun-config-page-section__body');

    expect(body?.classList.contains('openbitfun-config-page-section__body--flush')).toBe(true);
    expect(body?.getAttribute('data-appearance')).toBe('plain');
    expect(body?.getAttribute('data-field-surface')).toBe('default');
    // The prop drives styling only; it must never leak onto the DOM node.
    expect(section?.hasAttribute('bodysurface')).toBe(false);
  });

  it('keeps the body surface chrome by default', () => {
    act(() => {
      root.render(
        <ConfigPageSection title="Standard">
          <div>Body</div>
        </ConfigPageSection>,
      );
    });

    const body = container.querySelector('.openbitfun-config-page-section__body');
    expect(body?.classList.contains('openbitfun-config-page-section__body--flush')).toBe(false);
    expect(body?.getAttribute('data-appearance')).toBe('subtle');
    expect(body?.getAttribute('data-openbitfun-component')).toBe('field-group');
    expect(body?.getAttribute('data-field-surface')).toBe('ambient');
  });

  it('lets a surfaced section keep nested fields opaque', () => {
    act(() => {
      root.render(
        <ConfigPageSection title="Provider" fieldSurface="default">
          <Input aria-label="API URL" />
        </ConfigPageSection>,
      );
    });

    const body = container.querySelector('.openbitfun-config-page-section__body');
    const input = container.querySelector('[data-openbitfun-component="input"]');

    expect(body?.getAttribute('data-appearance')).toBe('subtle');
    expect(body?.getAttribute('data-field-surface')).toBe('default');
    expect(input?.getAttribute('data-field-surface')).toBe('default');
  });

  it('supports a header-only section with a title-side action', () => {
    act(() => {
      root.render(
        <ConfigPageSection title="Search provider" extra={<button>Exa</button>}>
          {null}
        </ConfigPageSection>,
      );
    });

    expect(container.querySelector('[data-openbitfun-part="sectionTitle"]')?.textContent).toBe('Search provider');
    expect(container.querySelector('.openbitfun-config-page-section__extra button')?.textContent).toBe('Exa');
    expect(container.querySelector('.openbitfun-config-page-section__body')).toBeNull();
  });

  it('forwards inline summaries without merging descriptions into the heading', () => {
    act(() => {
      root.render(
        <ConfigPageSection title="Memory processing" description="Limit session scope." descriptionLayout="inline" extra={<button>Expand</button>}>
          {null}
        </ConfigPageSection>,
      );
    });

    expect(container.querySelector('[data-openbitfun-component="form-section"]')?.getAttribute('data-description-layout')).toBe('inline');
    expect(container.querySelector('h3')?.textContent).toBe('Memory processing');
    expect(container.querySelector('[data-openbitfun-part="sectionDescription"]')?.textContent).toBe('Limit session scope');
    expect(container.querySelector('.openbitfun-config-page-section__extra button')?.textContent).toBe('Expand');
    expect(container.querySelector('.openbitfun-config-page-section__body')).toBeNull();
  });

  it('lets copy use the full row when there is no control', () => {
    act(() => {
      root.render(
        <ConfigPageRow label="User hook file" description="A long platform-specific path">
          {null}
        </ConfigPageRow>,
      );
    });

    const row = container.querySelector('.openbitfun-config-page-row');
    expect(row?.classList.contains('openbitfun-config-page-row--no-control')).toBe(true);
    expect((row as HTMLElement | null)?.style.gridTemplateColumns).toBe('');
    expect(readStyleFixture('ConfigPageLayout.scss')).toMatch(
      /\.openbitfun-config-page-row--no-control\s*{[\s\S]*?--row-grid-cols:\s*minmax\(0, 1fr\);/,
    );
    expect(row?.querySelector('.openbitfun-config-page-row__control')).toBeNull();
  });

  it('forwards feature-owned layout contracts while preserving nested design-system ownership', () => {
    act(() => {
      root.render(
        <ConfigPageLayout
          data-testid="feature-root"
          data-openbitfun-component="model-settings"
          data-openbitfun-part="root"
        >
          <ConfigPageContent
            data-testid="feature-content"
            data-openbitfun-component="model-settings"
            data-openbitfun-part="providerSelection"
          >
            <ConfigPageSection
              title="Models"
              data-testid="feature-section"
              data-openbitfun-component="model-settings"
              data-openbitfun-part="providerGroup"
            >
              <div>Body</div>
            </ConfigPageSection>
          </ConfigPageContent>
        </ConfigPageLayout>,
      );
    });

    const rootElement = container.querySelector('[data-testid="feature-root"]');
    const contentElement = container.querySelector('[data-testid="feature-content"]');
    const sectionElement = container.querySelector('[data-testid="feature-section"]');

    expect(rootElement?.getAttribute('data-openbitfun-component')).toBe('model-settings');
    expect(rootElement?.getAttribute('data-openbitfun-part')).toBe('root');
    expect(contentElement?.getAttribute('data-openbitfun-component')).toBe('model-settings');
    expect(contentElement?.getAttribute('data-openbitfun-part')).toBe('providerSelection');
    expect(sectionElement?.getAttribute('data-openbitfun-component')).toBe('form-section');
    expect(sectionElement?.getAttribute('data-openbitfun-part')).toBe('providerGroup');
  });
});
