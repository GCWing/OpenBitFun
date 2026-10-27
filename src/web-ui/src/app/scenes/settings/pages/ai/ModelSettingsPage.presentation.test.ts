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
  it('does not render Unicode replacement characters', () => {
    expect(source).not.toContain('\uFFFD');
  });

  it('declares required model fields structurally instead of embedding asterisks in label copy', () => {
    expect(source).not.toMatch(/label=\{`[^`]*\*[^`]*`\}/);
    expect(source.match(/<ConfigPageRow label=\{t\('form\.configName'\)\} required=\{!providerIdentityLocked\}/g)).toHaveLength(1);
    expect(source.match(/<ConfigPageRow label=\{t\('form\.modelSelection'\)\} required/g)).toHaveLength(1);
    // Template and custom-provider editors share the required API URL row.
    expect(source.match(/<ConfigPageRow label=\{t\('form\.baseUrl'\)\} required/g)).toHaveLength(1);
    expect(source).toContain('const apiKeyRequired = !isOpenCodeZenApiKeyConfig(editingConfig);');
    expect(source).toContain('<ConfigPageRow label={label} required={apiKeyRequired} align="center" wide>');
    expect(source.match(/required=\{apiKeyRequired\}/g)).toHaveLength(2);
  });

  it('does not add a second background around the editor account selection and quota', () => {
    const start = source.indexOf('data-testid="settings-model-account-pool"');
    const accountPool = source.slice(start, source.indexOf('</FieldGroup>', start));

    expect(start).toBeGreaterThan(-1);
    expect(accountPool).toContain('<FieldGroup appearance="plain">');
    expect(accountPool).toContain('settings-model-account-pool-item');
    expect(accountPool).toContain('<SubscriptionQuotaPanel');
    expect(accountPool).toContain('<Checkbox');
    expect(accountPool).not.toContain('<input');
    expect(accountPool).toContain('account-pool-entry');
    expect(accountPool).toContain('accountLabel={accountLabel} headerLeading={accountSelection} headerActions={orderActions}');
    expect(accountPool).toContain("state !== 'connected'");
    expect(styles).not.toMatch(/&__account-pool-entry\s*{\s*display: grid;/);
    expect(styles).toMatch(/&__account-pool-choice\s*{\s*flex: none;\s*align-self: center;/);
    const poolRow = source.slice(start, source.indexOf('const renderSubscriptionAccountRow', start));
    expect(poolRow).not.toContain('variant="text"');
    expect(poolRow).not.toContain('subscriptionAuth.pool.singleHint');
    expect(poolRow).toContain('{selectedAccounts.length > 1 && (');
  });

  it('keeps inline quota values on the label baseline without nested card surfaces', () => {
    const quotaStyles = readFileSync(fileURLToPath(new URL('./SubscriptionQuotaPanel.module.scss', import.meta.url)), 'utf8');
    const compact = quotaStyles.slice(quotaStyles.indexOf('.compact {'), quotaStyles.indexOf('@container'));
    expect(compact).toContain('align-items: baseline');
    expect(compact).toContain('background: transparent');
    expect(compact).toContain('border: 0');
    expect(compact).toContain('grid-column: 1 / -1');
    expect(compact).toContain('var(--openbitfun-type-label-md-font-size)');
    expect(styles).toMatch(/&__account-pool-item\s*{[\s\S]*?flex-wrap: wrap;[\s\S]*?align-items: center;/);
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

  it('keeps the per-request image limit inside advanced settings', () => {
    const advancedStart = source.indexOf('const renderAdvancedSettings = () =>');
    const imageLimit = source.indexOf('data-testid="settings-model-image-limit"');

    expect(advancedStart).toBeGreaterThan(-1);
    expect(imageLimit).toBeGreaterThan(advancedStart);
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
