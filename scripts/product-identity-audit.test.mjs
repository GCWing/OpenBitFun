import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  auditFile,
  auditRepository,
  listRepositoryFiles,
  normalizeRepositoryPath,
  shouldAuditContent,
  shouldAuditPath,
} from './product-identity-audit.mjs';

const retiredName = `${'Bit'}${'Fun'}`;
const retiredLowerName = retiredName.toLowerCase();
const shortPrefix = `${'b'}${'f'}`;

function violationsFor(content, file = 'src/example.ts') {
  return auditFile({ file, content });
}

test('accepts the canonical product identity in supported casing and contracts', () => {
  const source = [
    'OpenBitFun',
    'openBitFunTheme',
    'openbitfun',
    'OPENBITFUN_USER_ROOT',
    '@openbitfun/ui',
    '.openbitfun/config',
    'openbitfun://runtime/',
    '--openbitfun-color-surface',
    'data-openbitfun-component',
    'node.dataset.openbitfunPart',
    '@layer openbitfun.components',
    'minOpenBitFunVersion: "1.0.0"',
    'min_openbitfun_version: "1.2.0"',
    'openbitfun-cli-1.0.0-aarch64-unknown-linux-gnu.tar.gz',
    'OpenBitFun_1.0.0_windows-x86_64-setup.exe',
  ].join('\n');

  assert.deepEqual(violationsFor(source), []);
});

test('rejects non-canonical casing and abbreviated OpenBitFun names', () => {
  const nonCanonicalPascal = ['Open', 'Bit', 'fun'].join('');
  const nonCanonicalCamel = ['open', 'Bit', 'fun'].join('');
  const abbreviatedPascal = ['Open', 'B', 'F'].join('');
  const abbreviatedCli = `${['open', 'b', 'f'].join('')}-cli`;
  const source = [
    nonCanonicalPascal,
    nonCanonicalCamel,
    abbreviatedPascal,
    abbreviatedCli,
  ].join('\n');

  assert.deepEqual(
    violationsFor(source).map((violation) => violation.rule),
    [
      'noncanonical-openbitfun-casing',
      'noncanonical-openbitfun-casing',
      'abbreviated-openbitfun-name',
      'abbreviated-openbitfun-name',
    ],
  );
});

test('rejects retired names in copy, packages, paths, protocols, and environment variables', () => {
  const source = [
    retiredName,
    retiredLowerName,
    `@${retiredLowerName}/ui`,
    `.${retiredLowerName}/config`,
    `${retiredLowerName}://runtime/`,
    `com.${retiredLowerName}.desktop`,
    `${retiredName.toUpperCase()}_USER_ROOT`,
  ].join('\n');

  const violations = violationsFor(source);
  assert.equal(violations.length, 7);
  assert.ok(violations.every((violation) => violation.rule === 'retired-product-name'));
});

test('allows only the exact legacy data-directory ignore entry', () => {
  const legacyDataDirectoryPrefix = `.${retiredLowerName}`;
  const legacyDataDirectoryIgnore = `${legacyDataDirectoryPrefix}/`;

  assert.deepEqual(
    auditFile({ file: '.gitignore', content: `${legacyDataDirectoryIgnore}\n` }),
    [],
  );

  const violations = auditFile({
    file: '.gitignore',
    content: `${legacyDataDirectoryPrefix}-cache/\n  ${legacyDataDirectoryIgnore} # comment\n`,
  });
  assert.equal(violations.length, 2);
  assert.ok(violations.every((violation) => violation.rule === 'retired-product-name'));
});

test('allows the published attribution identifiers only when they carry every retired token on the line', () => {
  const attributedEmail = `318544290+${retiredLowerName}-ai@users.noreply.github.com`;
  const attributedProfileUrl = `https://github.com/${retiredLowerName}-ai`;

  for (const line of [
    attributedEmail,
    attributedProfileUrl,
    `  Co-authored-by: OpenBitFun <${attributedEmail}>`,
    `Co-authored-by: OpenBitFun <${attributedEmail}>`,
    `  Generated with [OpenBitFun](${attributedProfileUrl})`,
    `Generated with [OpenBitFun](${attributedProfileUrl})`,
    `        assert!(skill.contains("Generated with [OpenBitFun](${attributedProfileUrl})"));`,
    `            .contains("Co-authored-by: OpenBitFun <${attributedEmail}>"));`,
  ]) {
    assert.deepEqual(violationsFor(line), [], line);
  }

  for (const line of [
    `const attribution = "${attributedEmail}"; // ${retiredLowerName}`,
    `// ${retiredLowerName} repository ${attributedProfileUrl}`,
    `Co-authored-by: ${retiredName} <${attributedEmail}>`,
  ]) {
    assert.ok(
      violationsFor(line).some((violation) => violation.rule === 'retired-product-name'),
      line,
    );
  }
});

test('limits retired identity data to the one-time production migration boundary', () => {
  for (const file of [
  ]) {
    assert.deepEqual(violationsFor(retiredName, file), []);
  }
  for (const file of [
    'src/apps/desktop/src/lib.rs',
    'src/web-ui/src/locales/en-US/settings.json',
    'src/shared/interactive-capabilities/catalog.json',
  ]) {
    assert.equal(violationsFor(retiredName, file).length, 1);
  }
  const retiredField = ['min', 'Bit', 'fun', 'Version'].join('');
  assert.deepEqual(
    violationsFor(
      `RETIRED_VERSION_FIELDS = ("${retiredField}",)`,
      'deploy/openbitfun-host/migrate-market-data-v1.py',
    ),
    [],
  );
  assert.equal(
    violationsFor(`const field = "${retiredField}";`, 'src/example.ts').length,
    1,
  );
  assert.deepEqual(
    violationsFor(
      `const SOURCE_PRODUCT: &str = "${retiredLowerName}";`,
      'src/crates/services/legacy-migration/src/source.rs',
    ),
    [],
  );
  assert.deepEqual(
    violationsFor(
      `const SOURCE_PRODUCT: &str = "${retiredLowerName}";`,
      'src/crates/assembly/core/src/legacy_migration/source.rs',
    ),
    [],
  );
  assert.deepEqual(
    violationsFor(
      `const sourceLabel = "${retiredName}";`,
      'src/apps/data-tools/ui/app.js',
    ),
    [],
  );
  for (const filename of [
    'scripts/recovery/repair-session-storage.py',
    'src/crates/services/services-core/src/session_recovery/identity.rs',
  ]) {
    assert.deepEqual(violationsFor(`const oldDataRoot = ".${retiredLowerName}";`, filename), []);
  }
  assert.equal(violationsFor(`const label = "${retiredName}";`, 'scripts/recovery/other.py').length, 1);
  assert.deepEqual(
    violationsFor(
      `{"url": "https://github.com/example/${retiredLowerName}/releases/download/v0.2.19/${retiredLowerName}_0.2.19_windows-x86_64-setup.exe"}`,
      'scripts/fixtures/legacy-update-feeds/latest.json',
    ),
    [],
  );
  assert.equal(
    violationsFor(
      `const sourceLabel = "${retiredName}";`,
      'scripts/fixtures/example.json',
    ).length,
    1,
  );
  assert.equal(
    violationsFor(
      `const SOURCE_PRODUCT: &str = "${retiredLowerName}";`,
      'src/crates/services/example/src/source.rs',
    ).length,
    1,
  );
  assert.equal(
    violationsFor(
      `const sourceLabel = "${retiredName}";`,
      'src/apps/desktop/src/example.rs',
    ).length,
    1,
  );
});

test('allows retired Harmony identifiers only at the upgrade identity boundary', () => {
  const legacyBundle = `com.${retiredLowerName}.app`;
  assert.deepEqual(
    violationsFor(
      `static readonly APP_BUNDLE: string = '${legacyBundle}';`,
      'src/apps/mobile/harmonyos/entry/src/main/ets/services/HarmonyUpgradeIdentityContract.ets',
    ),
    [],
  );
  assert.equal(
    violationsFor(`const bundle = '${legacyBundle}';`, 'src/apps/mobile/harmonyos/entry/src/main/ets/services/example.ets').length,
    1,
  );
});

test('rejects retired short CSS, DOM, dataset, layer, and environment prefixes', () => {
  const source = [
    `--${shortPrefix}-surface: white;`,
    `data-${shortPrefix}-component="button"`,
    `element.dataset.${shortPrefix}Part = 'root';`,
    `element.dataset['${shortPrefix}State'] = 'active';`,
    `@layer ${shortPrefix}.components;`,
    `${shortPrefix.toUpperCase()}_E2E_HOME=/tmp/example`,
  ].join('\n');

  const rules = violationsFor(source).map((violation) => violation.rule);
  assert.deepEqual(rules, [
    'retired-css-token-prefix',
    'retired-dom-attribute-prefix',
    'retired-dataset-property-prefix',
    'retired-dataset-property-prefix',
    'retired-css-layer-prefix',
    'retired-environment-prefix',
  ]);
});

test('checks a retired identity when it appears in a repository path', () => {
  const file = `products/${retiredLowerName}/product.jsonc`;
  const violations = auditFile({ file });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].location, 'path');
  assert.equal(violations[0].rule, 'retired-product-name');
});

test('scans untracked files while ignoring tracked files deleted by a rename', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'openbitfun-identity-audit-'));
  const retiredDirectory = path.join(root, retiredLowerName);
  const retiredFile = path.join(retiredDirectory, 'config.json');
  const canonicalFile = path.join(root, 'openbitfun', 'config.json');
  mkdirSync(retiredDirectory, { recursive: true });
  mkdirSync(path.dirname(canonicalFile), { recursive: true });
  writeFileSync(retiredFile, '{}\n');
  writeFileSync(canonicalFile, '{"product":"OpenBitFun"}\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  rmSync(retiredFile);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(listRepositoryFiles(root), ['openbitfun/config.json']);
  assert.deepEqual(auditRepository(root).violations, []);

  mkdirSync(retiredDirectory, { recursive: true });
  writeFileSync(retiredFile, '{}\n');
  const violations = auditRepository(root).violations;
  assert.equal(violations.length, 1);
  assert.equal(violations[0].location, 'path');
  assert.equal(violations[0].rule, 'retired-product-name');
});

test('does not confuse unrelated abbreviations, issue ids, or hashes with product identity', () => {
  const source = [
    'BFF',
    'BFS',
    'BF-123',
    'sha256:46bf68c6409f',
    'buffer.slice(0, 2)',
    'const bf = bestFit;',
  ].join('\n');

  assert.deepEqual(violationsFor(source), []);
});

test('rejects a parallel identity-version label while keeping schema version one valid', () => {
  const parallelLabel = ['Product', 'Identity', 'v2'].join(' ');
  const violations = violationsFor(`${parallelLabel}\nschemaVersion: 1`);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'parallel-identity-version');
});

test('keeps compile-time product identity reads in the canonical contract owner', () => {
  const source = [
    'const PRODUCT_ID: &str = option_',
    'en',
    'v!("OPENBITFUN_PRODUCT_ID").unwrap_or("openbitfun");',
  ].join('');
  const violations = violationsFor(source, 'src/example.rs');

  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'duplicate-product-identity-owner');
  assert.deepEqual(
    violationsFor(source, 'src/crates/contracts/core-types/src/product_identity.rs'),
    [],
  );
});

test('rejects pre-1.0 minimum versions and OpenBitFun release assets', () => {
  const preOneVersion = [0, 9, 0].join('.');
  const source = [
    `minOpenBitFunVersion: '${preOneVersion}'`,
    `min_openbitfun_version: "${preOneVersion}"`,
    `openbitfun-cli-${preOneVersion}-aarch64-unknown-linux-gnu.tar.gz`,
    `OpenBitFun_${preOneVersion}_windows-x86_64-setup.exe`,
  ].join('\n');

  assert.deepEqual(
    violationsFor(source).map((violation) => violation.rule),
    [
      'pre-1.0-openbitfun-minimum-version',
      'pre-1.0-openbitfun-minimum-version',
      'pre-1.0-openbitfun-release-asset',
      'pre-1.0-openbitfun-release-asset',
    ],
  );
});

test('normalizes Windows separators and skips dependency and generated output roots', () => {
  assert.equal(normalizeRepositoryPath('src\\web-ui\\index.ts'), 'src/web-ui/index.ts');
  assert.equal(shouldAuditPath('packages/ui/src/index.ts'), true);
  assert.equal(shouldAuditContent('packages/ui/src/index.ts'), true);

  for (const file of [
    'node_modules/example/index.js',
    'target/debug/generated.rs',
    'src/web-ui/dist/index.js',
    'docs/superpowers/archive.md',
    'src/web-ui/public/monaco-editor/vs/loader.js',
  ]) {
    assert.equal(shouldAuditPath(file), false, file);
    assert.equal(shouldAuditContent(file), false, file);
  }
});
