import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const modelSettingsSource = readFileSync(
  fileURLToPath(new URL('../../../app/scenes/settings/pages/ai/ModelSettingsPage.tsx', import.meta.url)),
  'utf8',
).replaceAll('\r\n', '\n');
const defaultModelSource = readFileSync(
  fileURLToPath(new URL('./DefaultModelConfig.tsx', import.meta.url)),
  'utf8',
);
const modelSettingsStyles = readFileSync(
  fileURLToPath(new URL('../../../app/scenes/settings/pages/ai/ModelSettingsPage.scss', import.meta.url)),
  'utf8',
);
const collectionItemStyles = readFileSync(
  fileURLToPath(new URL('./common/ConfigCollectionItem.scss', import.meta.url)),
  'utf8',
);

describe('model service collapsed presentation', () => {
  it('starts provider groups collapsed and exposes an accessible user toggle', () => {
    expect(modelSettingsSource).toContain(
      'const [expandedProviderGroupKeys, setExpandedProviderGroupKeys] = useState<Set<string>>(new Set());',
    );
    expect(modelSettingsSource).toContain('aria-expanded={isExpanded}');
    expect(modelSettingsSource).toContain("name={isExpanded ? 'chevron-down' : 'chevron-right'}");
    expect(modelSettingsSource).toContain('{isExpanded && (');
  });

  it('includes the leading card inset in the provider toggle hit area', () => {
    expect(modelSettingsStyles).toMatch(
      /&__provider-group-header\s*\{[\s\S]*?padding-inline:\s*0 var\(--openbitfun-space-4\)/,
    );
    expect(modelSettingsStyles).toMatch(
      /&__provider-group-toggle\s*\{[\s\S]*?align-self:\s*stretch[\s\S]*?padding-inline-start:\s*var\(--openbitfun-space-4\)/,
    );
  });

  it('matches the subscription group radius without an outer border', () => {
    expect(modelSettingsStyles).toMatch(
      /&__provider-group\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*var\(--openbitfun-layout-field-group-radius\)/,
    );
  });

  it('keeps provider headers and models on one theme-adaptive grouped surface', () => {
    expect(modelSettingsStyles).toMatch(
      /&__provider-group\s*\{[^}]*background:\s*var\(--openbitfun-color-surface-tertiary\)/,
    );
    expect(modelSettingsStyles).toMatch(
      /&__provider-group-header\s*\{[^}]*background:\s*transparent/,
    );
    expect(modelSettingsStyles).toMatch(
      /\.openbitfun-collection-item__details\s*\{[^}]*background:\s*transparent/,
    );
  });

  it('draws one consistent divider between provider headers and model rows', () => {
    expect(modelSettingsStyles).toMatch(
      /&\[data-expanded='true'\]\s*\{[^}]*border-bottom:\s*1px solid var\(--openbitfun-color-border-subtle\)/,
    );
    expect(collectionItemStyles).toMatch(
      /& \+ \.openbitfun-collection-item\s*\{[^}]*border-top:\s*1px solid var\(--openbitfun-color-border-subtle\)/,
    );
    expect(modelSettingsStyles).not.toContain('&:not(:last-child)');
  });

  it('marks the primary model slot as required in both label and control semantics', () => {
    expect(defaultModelSource).toMatch(
      /label=\{renderSlotLabel\(t\('core\.primary\.label'\), t\('core\.primary\.description'\)\)\}[\s\S]*?required[\s\S]*?<Combobox[\s\S]*?aria-required="true"/,
    );
  });

  it('keeps the enable switch at the trailing edge and reveals secondary model actions on interaction', () => {
    expect(modelSettingsSource).toMatch(
      /<span className="openbitfun-model-settings__model-enable">[\s\S]*?<Switch[\s\S]*?<div[\s\S]*?className="openbitfun-model-settings__model-actions"/,
    );
    expect(modelSettingsSource).toContain('data-openbitfun-part="modelActions"');
    expect(modelSettingsSource).toContain('toggleOnRowClick');
  });

  it('keeps model connection test progress and results visible without hover or expansion', () => {
    const badgeStart = modelSettingsSource.indexOf('const badge = (');
    const detailsStart = modelSettingsSource.indexOf('const details = (', badgeStart);
    const badgeSource = modelSettingsSource.slice(badgeStart, detailsStart);

    expect(badgeSource).toContain('{(isTesting || testResult) && (');
    expect(badgeSource).toContain('openbitfun-model-settings__status-dot');
    expect(badgeSource).not.toContain('<StatusPill');
    expect(badgeSource).toContain('role="status"');
    expect(badgeSource).toContain('aria-live="polite"');
    expect(badgeSource).toContain('aria-label={testStatusLabel}');
    expect(badgeSource).toContain("isTesting ? 'is-testing' : testResult?.success ? 'is-success' : 'is-error'");
    expect(modelSettingsSource).toContain(
      "isTesting\n      ? t('messages.testing')\n      : testResult?.message.split('\\n', 1)[0]",
    );
  });

  it('uses the semantic highlight color for each provider model count', () => {
    expect(modelSettingsStyles).toMatch(
      /&__provider-group-count\s*\{[\s\S]*?color:\s*var\(--openbitfun-color-content-required-indicator\)/,
    );
  });
});
