#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { matchingItems, scoreTextMatch, searchCapabilities } from '../src/search.js';

const execFileAsync = promisify(execFile);
const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(websiteRoot, '..');
const sourceRoot = path.join(websiteRoot, 'src');

await execFileAsync(process.execPath, [path.join(websiteRoot, 'scripts/build.mjs')], {
  cwd: repositoryRoot,
});

const [appSource, searchSource, stylesSource, templateSource, builtIndex, builtApp, releaseSource, catalogSource] = await Promise.all([
  readFile(path.join(sourceRoot, 'app.js'), 'utf8'),
  readFile(path.join(sourceRoot, 'search.js'), 'utf8'),
  readFile(path.join(sourceRoot, 'styles.css'), 'utf8'),
  readFile(path.join(sourceRoot, 'index.html'), 'utf8'),
  readFile(path.join(websiteRoot, 'dist/index.html'), 'utf8'),
  readFile(path.join(websiteRoot, 'dist/assets/app.js'), 'utf8'),
  readFile(path.join(websiteRoot, 'dist/release.json'), 'utf8'),
  readFile(path.join(websiteRoot, 'dist/data/capabilities.json'), 'utf8'),
]);
const catalog = JSON.parse(catalogSource);

function cssBlock(selector) {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = stylesSource.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u'));
  assert.ok(match, `missing CSS block: ${selector}`);
  return match[1];
}

test('theme contract defaults to system and exposes all three choices', () => {
  assert.match(templateSource, /localStorage\.getItem\('openbitfun-playbook-theme'\)/u);
  assert.match(templateSource, /let theme = 'system'/u);
  assert.match(templateSource, /prefers-color-scheme: dark/u);
  assert.match(appSource, /const THEME_CHOICES = \['system', 'light', 'dark'\]/u);
  assert.match(appSource, /data-theme-choice="\$\{theme\}"/u);
  assert.match(appSource, /addEventListener\('change'/u);
  assert.match(templateSource, /data-openbitfun-design-system-root/u);
  assert.match(templateSource, /root\.dataset\.colorScheme/u);
  assert.match(templateSource, /\/assets\/design-tokens\.css/u);
  assert.match(templateSource, /\/assets\/theme\.css/u);
  assert.match(appSource, /--openbitfun-color-surface-canvas/u);
  assert.match(appSource, /documentElement\.dataset\.colorScheme = resolvedTheme\(\)/u);
});

test('hero title, search, and statistics remain in layout flow', () => {
  assert.match(appSource, /<h1>\$\{text\([\s\S]*?<span>[\s\S]*?<em>/u);
  assert.match(appSource, /<div class="hero-actions">[\s\S]*?<form class="search-box"[\s\S]*?<div class="hero-stat"/u);

  const title = cssBlock('.hero h1');
  const actions = cssBlock('.hero-actions');
  const statistics = cssBlock('.hero-stat');
  assert.match(title, /display:\s*grid/u);
  assert.match(title, /gap:/u);
  assert.match(actions, /display:\s*grid/u);
  assert.match(actions, /grid-template-columns:\s*minmax\(0, 1fr\) auto/u);
  assert.doesNotMatch(actions, /position:\s*absolute/u);
  assert.doesNotMatch(statistics, /position:\s*absolute/u);
  assert.match(
    stylesSource,
    /@media \(max-width: 1360px\)[\s\S]*?\.hero-actions\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/u,
  );
});

test('live search preserves the input node and supports IME composition', () => {
  assert.match(appSource, /function updateIndexResults\(\)/u);
  assert.match(appSource, /addEventListener\('compositionstart'/u);
  assert.match(appSource, /addEventListener\('compositionend'/u);
  assert.match(appSource, /event\.isComposing/u);

  const inputBinding = appSource.match(
    /const searchInput = document\.querySelector\('#capability-search'\);([\s\S]*?)document\.querySelectorAll\('\[data-kind\]'/u,
  );
  assert.ok(inputBinding, 'missing index search input binding');
  assert.match(inputBinding[1], /updateIndexResults\(\)/u);
  assert.doesNotMatch(inputBinding[1], /renderIndex\(\)/u);
});

test('catalog search accepts bilingual synonym bundles and exposes honest control classes', () => {
  assert.match(searchSource, /function scoreTextMatch\(query, fields\)/u);
  assert.doesNotMatch(appSource, /tokens\.every\(\(token\) => terms\.includes\(token\)\)/u);
  assert.match(appSource, /data-control-kind="\$\{escapeHtml\(item\.control\.kind\)\}"/u);
  assert.match(appSource, /Direct Agent control/u);
  assert.match(appSource, /capability\.operations\.length \|\| capability\.agentControl/u);
  assert.match(stylesSource, /\.control-direct/u);
});

test('search accepts consecutive initials without assembling acronyms from scattered prose', () => {
  assert.ok(scoreTextMatch('gs', ['Global Search']) > 0);
  assert.equal(scoreTextMatch('pet', ['Publish the example after completing checks and tests']), 0);
  assert.equal(scoreTextMatch('mascot', ['Move an app; select controls only when observed, then operate them']), 0);
});

test('Playbook search satisfies the shared cross-surface acceptance corpus', () => {
  for (const acceptance of catalog.searchAcceptance) {
    const results = searchCapabilities(catalog, acceptance.query);
    assert.equal(
      results[0]?.capability.id,
      acceptance.expectedFirstCapabilityId,
      acceptance.id,
    );
    const resultIds = new Set(results.map(({ capability }) => capability.id));
    for (const capabilityId of acceptance.expectedCapabilityIds) {
      assert.ok(resultIds.has(capabilityId), `${acceptance.id} missed ${capabilityId}`);
    }
    if (acceptance.expectedItem) {
      const capability = catalog.capabilities.find(({ id }) =>
        id === acceptance.expectedItem.capabilityId);
      assert.equal(
        matchingItems(capability, acceptance.query)[0]?.id,
        acceptance.expectedItem.itemId,
        `${acceptance.id} item route`,
      );
    }
  }
});

test('sidebar navigation preserves its scroll position across page loads', () => {
  assert.match(appSource, /SIDEBAR_SCROLL_STORAGE_KEY/u);
  assert.match(appSource, /sessionStorage\.setItem/u);
  assert.match(appSource, /data-sidebar-scroll/u);
  assert.match(appSource, /addEventListener\('scroll', saveSidebarScroll/u);
  assert.match(appSource, /link\.addEventListener\('click', saveSidebarScroll\)/u);
  assert.match(appSource, /sidebarNav\.scrollTop = savedScrollTop/u);
  assert.match(appSource, /sidebarNav\.querySelector\('\[aria-current="page"\]'\)/u);
});

test('callouts and ordinary UI consume canonical semantic color tokens only', () => {
  assert.match(cssBlock('.detail-aside'), /background:\s*var\(--openbitfun-color-status-success-surface\)/u);
  assert.match(cssBlock('.detail-aside'), /color:\s*var\(--openbitfun-color-status-success-content\)/u);
  assert.match(cssBlock('.control-unsupported'), /color:\s*var\(--openbitfun-color-status-danger-content\)/u);
  assert.doesNotMatch(stylesSource, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
  assert.doesNotMatch(stylesSource, /var\(--(?:paper|ink|muted|line|panel|accent|danger|shadow)\)/u);
});

test('build emits a source-sensitive immutable release id', () => {
  const release = JSON.parse(releaseSource);
  assert.match(release.releaseId, /^[0-9a-f]{12}$/u);
  assert.equal(release.releaseId, release.assetVersion);
  assert.match(release.catalogDigest, /^[0-9a-f]{64}$/u);
  assert.match(builtIndex, new RegExp(`/assets/styles\\.css\\?v=${release.releaseId}`, 'u'));
  assert.match(builtIndex, new RegExp(`/assets/design-tokens\\.css\\?v=${release.releaseId}`, 'u'));
  assert.match(builtIndex, new RegExp(`/assets/theme\\.css\\?v=${release.releaseId}`, 'u'));
  assert.match(builtIndex, new RegExp(`/assets/app\\.js\\?v=${release.releaseId}`, 'u'));
  assert.match(builtApp, new RegExp(`\\./search\\.js\\?v=${release.releaseId}`, 'u'));
});
