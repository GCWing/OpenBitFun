#!/usr/bin/env node

/**
 * Prevent the retired product identity from returning to production sources.
 *
 * The normal product is OpenBitFun-only. Legacy exceptions are restricted to
 * the exact data-directory ignore entry and the one-time migration documents,
 * migrator app/service boundary, and fixtures used for in-place upgrades.
 *
 * The retired token also survives inside two external GitHub identifiers that
 * must keep their published spelling: the committed-by attribution email and
 * the organization profile URL. Those are allowed only as whole-line matches
 * where every retired token on the line belongs to one of those identifiers; a
 * line that pairs an identifier with any other retired token still fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');

const retiredProductToken = `${'bit'}${'fun'}`;
const shortPrefix = `${'b'}${'f'}`;
const productIdentityOwner = 'src/crates/contracts/core-types/src/product_identity.rs';
const retiredIdentityDataBoundaryFiles = new Set([
  'OPENBITFUN_LEGACY_DATA_MIGRATION_IMPLEMENTATION_PLAN.md',
  'OPENBITFUN_LEGACY_DATA_MIGRATION_INVENTORY.md',
  'deploy/openbitfun-host/README.md',
  'deploy/openbitfun-host/migrate-market-data-v1.py',
  // Offline recovery must recognize the pre-rename assistant data location.
  'scripts/recovery/repair-session-storage.py',
  'scripts/recovery/repair-session-storage.test.py',
  'scripts/recovery/repair-session-storage.md',
  'src/apps/relay-server/README.md',
  // HarmonyOS must keep its published bundle id and encrypted-storage names
  // for in-place upgrades. Runtime identifiers are centralized in one source;
  // the manifest and backup policy are the only declarative exceptions.
  'src/apps/mobile/harmonyos/AppScope/app.json5',
  'src/apps/mobile/harmonyos/entry/src/main/ets/services/HarmonyUpgradeIdentityContract.ets',
  'src/apps/mobile/harmonyos/entry/src/main/resources/base/profile/backup_config.json',
]);
const retiredIdentityDataBoundaryPrefixes = Object.freeze([
  'src/apps/data-tools/',
  'src/crates/assembly/core/src/legacy_migration/',
  'src/crates/services/legacy-migration/',
  'src/crates/services/legacy-migration-adapters/',
  'src/crates/services/services-core/src/session_recovery/',
  // Pinned legacy updater feeds reproduce the historical 0.2.x manifests
  // (download URLs and file names included) so old clients keep resolving
  // their last real release; they must not be rewritten to the new identity.
  'scripts/fixtures/legacy-update-feeds/',
]);
const noncanonicalIdentityDataBoundaryFiles = new Set([
  'OPENBITFUN_LEGACY_DATA_MIGRATION_INVENTORY.md',
  'deploy/openbitfun-host/migrate-market-data-v1.py',
]);

// Published external GitHub identifiers that embed the retired token. These are
// names GitHub owns, not product identity, so renaming them would break commit
// attribution and the repository link instead of removing a legacy product name.
const attributedExternalIdentities = Object.freeze([
  `318544290+${retiredProductToken}-ai@users.noreply.github.com`,
  `https://github.com/${retiredProductToken}-ai`,
]);

const retiredProductPatternSource = `(?<!open)${retiredProductToken}`;

function isExternalAttributionOnlyLine(lineText) {
  if (typeof lineText !== 'string') {
    return false;
  }

  let remaining = lineText;
  let foundIdentity = false;
  for (const identity of attributedExternalIdentities) {
    if (remaining.includes(identity)) {
      foundIdentity = true;
      remaining = remaining.split(identity).join('');
    }
  }

  if (!foundIdentity) {
    return false;
  }

  // Only the retired tokens that live inside an allowed identifier may remain.
  return !new RegExp(retiredProductPatternSource, 'iu').test(remaining);
}

const identityRules = Object.freeze([
  Object.freeze({
    id: 'noncanonical-openbitfun-casing',
    description: 'non-canonical OpenBitFun casing',
    pattern: /openbitfun/giu,
    isViolation: (value) => !['OpenBitFun', 'openBitFun', 'openbitfun', 'OPENBITFUN'].includes(value),
    allowedFiles: noncanonicalIdentityDataBoundaryFiles,
  }),
  Object.freeze({
    id: 'abbreviated-openbitfun-name',
    description: 'abbreviated OpenBitFun product name',
    pattern: /\bopen[\s_-]*bf\b/giu,
  }),
  Object.freeze({
    id: 'retired-product-name',
    description: 'retired product name',
    pattern: new RegExp(retiredProductPatternSource, 'giu'),
    allowedMatch: ({ location }) => {
      if (location.file === '.gitignore'
        && location.location === 'content'
        && location.lineText?.trim() === `.${retiredProductToken}/`) {
        return true;
      }
      return location.location === 'content'
        && isExternalAttributionOnlyLine(location.lineText);
    },
    allowedFiles: retiredIdentityDataBoundaryFiles,
    allowedFilePrefixes: retiredIdentityDataBoundaryPrefixes,
  }),
  Object.freeze({
    id: 'retired-css-token-prefix',
    description: 'retired CSS custom-property prefix',
    pattern: new RegExp(`--${shortPrefix}-`, 'giu'),
  }),
  Object.freeze({
    id: 'retired-dom-attribute-prefix',
    description: 'retired DOM data-attribute prefix',
    pattern: new RegExp(`data-${shortPrefix}-`, 'giu'),
  }),
  Object.freeze({
    id: 'retired-dataset-property-prefix',
    description: 'retired dataset property prefix',
    pattern: new RegExp(
      `\\bdataset\\s*(?:\\.\\s*${shortPrefix}(?=[A-Z0-9_]|\\b)|\\[\\s*['\"]${shortPrefix}(?=[A-Z0-9_-]|['\"]))`,
      'giu',
    ),
  }),
  Object.freeze({
    id: 'retired-css-layer-prefix',
    description: 'retired CSS layer prefix',
    pattern: new RegExp(`@layer\\s+${shortPrefix}(?=[.\\s,{;]|$)`, 'giu'),
  }),
  Object.freeze({
    id: 'retired-environment-prefix',
    description: 'retired environment-variable prefix',
    pattern: new RegExp(`\\b${shortPrefix.toUpperCase()}_[A-Z0-9_]+\\b`, 'gu'),
  }),
  Object.freeze({
    id: 'parallel-identity-version',
    description: 'parallel product-identity version label',
    pattern: new RegExp(
      `${'product'}[\\s_-]*${'identity'}[\\s_-]*${'v2'}|${'identity'}-${'v2'}`,
      'giu',
    ),
  }),
  Object.freeze({
    id: 'duplicate-product-identity-owner',
    description: 'product identity compile-time environment read outside the canonical owner',
    pattern: /\b(?:option_)?env!\s*\(\s*["']OPENBITFUN_(?:PRODUCT_ID|DATA_NAMESPACE|HIDDEN_DATA_DIRECTORY)["']\s*\)/gu,
    allowedFiles: new Set([productIdentityOwner]),
  }),
  Object.freeze({
    id: 'pre-1.0-openbitfun-minimum-version',
    description: 'minimum OpenBitFun version earlier than 1.0.0',
    pattern: /\b(?:minOpenBitFunVersion|min_openbitfun_version)\b\s*(?::|=)\s*['"]0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?['"]/giu,
  }),
  Object.freeze({
    id: 'pre-1.0-openbitfun-release-asset',
    description: 'OpenBitFun release asset earlier than 1.0.0',
    pattern: /\b(?:openbitfun-cli-|openbitfun[_-])0\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/giu,
  }),
]);

const textExtensions = new Set([
  '.c',
  '.bat',
  '.cjs',
  '.cmd',
  '.conf',
  '.cpp',
  '.csproj',
  '.css',
  '.desktop',
  '.diff',
  '.env',
  '.ets',
  '.fish',
  '.ftl',
  '.gradle',
  '.graphql',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsonc',
  '.json5',
  '.jsx',
  '.kt',
  '.kts',
  '.lock',
  '.md',
  '.mjs',
  '.mm',
  '.nsi',
  '.pbxproj',
  '.patch',
  '.plist',
  '.properties',
  '.proto',
  '.ps1',
  '.py',
  '.rs',
  '.scss',
  '.service',
  '.sh',
  '.sln',
  '.sql',
  '.svelte',
  '.swift',
  '.svg',
  '.timer',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.wxs',
  '.xcconfig',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);

const textBasenames = new Set([
  '.dockerignore',
  '.gitattributes',
  '.gitignore',
  '.gitmodules',
  'codeowners',
  'dockerfile',
  'makefile',
  'procfile',
]);

const ignoredPaths = Object.freeze([
  /(^|\/)node_modules\//,
  /(^|\/)target\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)coverage\//,
  /^docs\/superpowers\//,
  /^src\/web-ui\/public\/monaco-editor\//,
]);

export function normalizeRepositoryPath(file) {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function shouldAuditPath(file) {
  const normalized = normalizeRepositoryPath(file);
  return !ignoredPaths.some((pattern) => pattern.test(normalized));
}

export function shouldAuditContent(file) {
  const normalized = normalizeRepositoryPath(file);
  if (!shouldAuditPath(normalized)) {
    return false;
  }

  const basename = path.posix.basename(normalized).toLowerCase();
  return textExtensions.has(path.posix.extname(basename).toLowerCase())
    || textBasenames.has(basename)
    || basename.startsWith('dockerfile.');
}

function collectMatches(value, location) {
  const violations = [];

  for (const rule of identityRules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of value.matchAll(pattern)) {
      if (rule.allowedMatch?.({ match: match[0], location })) {
        continue;
      }
      if (rule.allowedFiles?.has(location.file)) {
        continue;
      }
      if (rule.allowedFilePrefixes?.some((prefix) => location.file.startsWith(prefix))) {
        continue;
      }
      if (rule.isViolation && !rule.isViolation(match[0])) {
        continue;
      }
      violations.push({
        ...location,
        column: (match.index ?? 0) + 1,
        rule: rule.id,
        description: rule.description,
        match: match[0],
      });
    }
  }

  return violations;
}

export function auditFile({ file, content }) {
  const normalized = normalizeRepositoryPath(file);
  if (!shouldAuditPath(normalized)) {
    return [];
  }

  const violations = collectMatches(normalized, {
    file: normalized,
    location: 'path',
    line: null,
  });

  if (!shouldAuditContent(normalized) || content === undefined) {
    return violations;
  }

  const lines = String(content).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    violations.push(...collectMatches(line, {
      file: normalized,
      location: 'content',
      line: index + 1,
      lineText: line,
    }));
  }

  return violations;
}

export function listRepositoryFiles(root = repositoryRoot) {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  return [...new Set(output.split('\0').filter(Boolean).map(normalizeRepositoryPath))]
    .filter((file) => {
      const absolutePath = path.join(root, file);
      return existsSync(absolutePath) && statSync(absolutePath).isFile();
    })
    .sort((left, right) => left.localeCompare(right, 'en'));
}

export function auditRepository(root = repositoryRoot) {
  const files = listRepositoryFiles(root);
  const violations = [];
  let contentFilesScanned = 0;

  for (const file of files) {
    if (!shouldAuditPath(file)) {
      continue;
    }

    let content;
    if (shouldAuditContent(file)) {
      content = readFileSync(path.join(root, file), 'utf8');
      contentFilesScanned += 1;
    }
    violations.push(...auditFile({ file, content }));
  }

  return {
    filesChecked: files.length,
    contentFilesScanned,
    violations,
  };
}

function formatViolation(violation) {
  const position = violation.location === 'content'
    ? `${violation.file}:${violation.line}:${violation.column}`
    : violation.file;
  return `${position} ${violation.description} (${violation.rule})`;
}

function main() {
  const report = auditRepository(repositoryRoot);

  if (report.violations.length > 0) {
    console.error('OpenBitFun product identity audit failed:');
    for (const violation of report.violations) {
      console.error(`- ${formatViolation(violation)}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `OpenBitFun product identity audit passed (${report.contentFilesScanned} text files scanned, ${report.filesChecked} repository files checked).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main();
}
