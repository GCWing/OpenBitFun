import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  ).replace(/\r\n?/g, '\n');
}

describe('Runtime settings information architecture', () => {
  it('keeps concurrency input limits aligned with the host option schema', () => {
    const source = readSource('../ai/ExecutionSettingsPage.tsx');
    const registry = readSource('../../../../../../../../src/crates/contracts/product-domains/src/product_control_owner_registry.rs');
    for (const [option, constant] of [
      ['subagent-max-concurrency', 'SUBAGENT_MAX_CONCURRENCY_LIMIT'],
      ['swarm-max-concurrency', 'SWARM_MAX_CONCURRENCY_LIMIT'],
    ]) {
      const maximum = registry.match(new RegExp(`"${option}",\\s*integer_range\\(1\\.0, (\\d+)\\.0\\)`))?.[1];
      expect(maximum).toBeDefined();
      expect(source).toContain(`const ${constant} = ${maximum};`);
      expect(source).toContain(`max={${constant}}`);
    }
  });

  it('gives permissions and execution independent owners without nested views', () => {
    const execution = readSource('../ai/ExecutionSettingsPage.tsx');
    const permissions = readSource('../ai/PermissionsSettingsPage.tsx');
    const control = readSource('../tools/DeviceControlSettingsPage.tsx');
    expect(execution).not.toContain('permissionPolicy.sectionTitle');
    expect(execution).toContain('toolExecution.sectionTitle');
    expect(permissions).toContain('permissionPolicy.sectionTitle');
    expect(permissions).not.toContain('toolExecution.sectionTitle');
    expect(control.indexOf("title={t('computerUse.sectionTitle')}")).toBeLessThan(control.indexOf("title={t('browserControl.sectionTitle')}"));
    for (const source of [execution, permissions, control]) {
      expect(source).not.toContain('SettingsViewPage');
      expect(source).not.toContain('<Tabs');
    }
  });

  it('keeps the pet gallery inside the shared disclosure with a current appearance summary', () => {
    const source = readSource('../application/PetSettingsSection.tsx');
    const styles = readSource('./RuntimeSettings.scss');

    expect(source).toContain('className="openbitfun-runtime-settings__pet-gallery"');
    expect(source).toContain('data-testid="companion-pet-card"');
    expect(source).toContain('openbitfun-runtime-settings__pet-selected-mark');
    expect(source).toContain('<Disclosure');
    expect(source).toContain('open={isActive && companionPetListExpanded}');
    expect(source).toContain('className="openbitfun-runtime-settings__pet-summary"');
    expect(source).toContain('const hasLoadedPageDataRef = useRef(false);');
    expect(source).toContain('const reloadCompanionPets = useCallback(async () => {');
    expect(source).toContain("if (!isActive) return;");
    expect(source.match(/await reloadCompanionPets\(\);/g)).toHaveLength(2);
    expect(source).not.toContain('handleRefreshCompanionPets');
    expect(source).not.toContain('companionPetsLoading');
    expect(source).not.toContain('features.pet.refresh');
    expect(source).toContain('const [companionPetListExpanded, setCompanionPetListExpanded] = useState(false);');
    expect(source).not.toContain('openbitfun-runtime-settings__pet-expand-button');
    expect(source).not.toContain('openbitfun-runtime-settings__pet-preview-popover');
    expect(styles).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(styles).toContain('&__pet-card-preview');
    expect(styles).toContain('&__pet-selected-mark');
    expect(styles).toContain('border: 1px solid transparent;');
    expect(styles).toContain('&__pet-card:hover,\n  &__pet-card:focus-within {\n    border-color: var(--openbitfun-color-border-default);');
    expect(styles).not.toContain('&__pet-preview-popover');
    expect(styles).toContain(":root[data-openbitfun-appearance-mode='light'] &");
  });

  it('uses the app confirmation owner before deleting an imported pet', () => {
    const source = readSource('../application/PetSettingsSection.tsx');

    expect(source).toContain("const confirmed = await confirmDanger(\n      t('features.pet.deleteConfirmTitle'),\n      t('features.pet.deleteConfirmBody'),");
    expect(source).not.toContain("import { ask, open } from '@tauri-apps/plugin-dialog'");
    expect(source).not.toContain("await ask(t('features.pet.deleteConfirmBody')");
  });

  it('keeps the desktop-control platform note aligned as a distinct card footer', () => {
    const source = readSource('../tools/DeviceControlSettingsPage.tsx');
    const styles = readSource('./RuntimeSettings.scss');

    expect(source).toContain('className="openbitfun-runtime-settings__platform-note-icon"');
    expect(source).toContain('className="openbitfun-runtime-settings__platform-note-copy"');
    expect(source).not.toContain("padding: '8px 0 4px'");
    expect(styles).toContain('padding: var(--openbitfun-space-3) var(--openbitfun-space-5);');
    expect(styles).toContain('border-top: 1px solid var(--openbitfun-component-config-page-divider);');
    expect(styles).toContain('padding-inline: var(--openbitfun-space-4);');
  });
});
