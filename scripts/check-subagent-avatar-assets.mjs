#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetPath = 'src/web-ui/src/flow_chat/assets/subagent-avatars';
const assetDirectory = path.join(root, assetPath);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const palette = readJson(path.join(assetDirectory, 'palette.json'));
const registry = readJson(path.join(root, 'scripts/frontend-color-surface-registry.json'));
const expectedFiles = Array.from({ length: 20 }, (_, index) => (
  `robot-${String(index + 1).padStart(2, '0')}.svg`
));

assert.equal(palette.version, 1);
assert.ok(palette.owner && palette.reason.length >= 60, 'Artwork needs an explicit palette owner and reason.');
assert.deepEqual(palette.characters.map(character => character.file), expectedFiles);
assert.deepEqual(
  fs.readdirSync(assetDirectory).filter(file => file.endsWith('.svg')).sort(),
  expectedFiles,
  'The authored family must contain exactly the twenty catalogued SVGs.',
);

// The generic theme audit delegates only these exact files to this palette
// contract. A new SVG or a neighboring stylesheet receives no exemption.
const webUi = registry.surfaces.find(surface => surface.id === 'web-ui');
const registeredFiles = (webUi.audit.excludePaths ?? [])
  .filter(file => file.includes('subagent-avatars'));
assert.deepEqual(registeredFiles, expectedFiles.map(file => `src/flow_chat/assets/subagent-avatars/${file}`));

const catalog = fs.readFileSync(path.join(root, palette.consumer), 'utf8');
const importedFiles = [...catalog.matchAll(/from '\.\.\/assets\/subagent-avatars\/([^']+)'/g)]
  .map(match => match[1]);
assert.deepEqual(importedFiles, expectedFiles, 'Runtime imports must match the approved artwork inventory.');

const allowedTags = new Set(['svg', 'title', 'rect', 'path', 'circle', 'g', 'ellipse']);
let bytes = 0;
for (const character of palette.characters) {
  const file = path.join(assetDirectory, character.file);
  const source = fs.readFileSync(file, 'utf8');
  bytes += fs.statSync(file).size;
  const colors = [character.stem, character.body, character.knob, character.face];
  assert.ok(colors.every(color => /^#[0-9A-F]{6}$/.test(color)), `${character.file}: use explicit six-digit colors.`);
  assert.equal(new Set(colors).size, 4, `${character.file}: preserve the four artwork roles.`);
  assert.match(source, /<svg\b[^>]*\bwidth="128"[^>]*\bheight="128"[^>]*\bviewBox="[^"]+"/);
  assert.doesNotMatch(source, /\s(?:style|on\w+|(?:xlink:)?href)\s*=/i, `${character.file}: keep artwork self-contained.`);
  for (const [, tag] of source.matchAll(/<\/?([\w:-]+)\b/g)) {
    assert.ok(allowedTags.has(tag), `${character.file}: unsupported artwork element ${tag}.`);
  }
  const usedColors = new Set();
  for (const [, color] of source.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)) {
    if (color === 'none') continue;
    assert.ok(colors.includes(color), `${character.file}: unregistered artwork color ${color}.`);
    usedColors.add(color);
  }
  assert.deepEqual([...usedColors].sort(), [...colors].sort(), `${character.file}: palette contains stale colors.`);
}

const hatchPath = 'design-system/packages/ui/src/brand/assets';
const hatchPalette = readJson(path.join(root, hatchPath, 'subagent-egg.palette.json'));
assert.equal(hatchPalette.version, 1);
assert.equal(hatchPalette.file, 'subagent-egg.svg');
assert.ok(hatchPalette.owner && hatchPalette.reason.length >= 60);
for (const role of ['stem', 'body', 'knob', 'face']) {
  assert.equal(hatchPalette.colors[role], palette.characters[0][role], `The egg must preserve robot-01's ${role}.`);
}
const hatchSource = fs.readFileSync(path.join(root, hatchPath, hatchPalette.file), 'utf8');
const hatchColors = Object.values(hatchPalette.colors);
assert.ok(hatchColors.every(color => /^#[0-9A-F]{6}$/.test(color)));
const usedHatchColors = [...hatchSource.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)]
  .map(match => match[1]).filter(color => color !== 'none');
assert.deepEqual([...new Set(usedHatchColors)].sort(), [...new Set(hatchColors)].sort());
assert.doesNotMatch(hatchSource, /\s(?:style|on\w+|(?:xlink:)?href)\s*=/i);
for (const [, tag] of hatchSource.matchAll(/<\/?([\w:-]+)\b/g)) assert.ok(allowedTags.has(tag));
for (const part of ['egg', 'peek', 'eyes', 'lid', 'shell-left', 'shell-right']) {
  assert.ok(hatchSource.includes(`data-hatch-part="${part}"`), `The hatch rig needs ${part}.`);
}
const ui = registry.surfaces.find(surface => surface.id === 'design-system-ui');
assert.deepEqual((ui.audit.excludePaths ?? []).filter(file => file.includes('subagent-egg')), ['src/brand/assets/subagent-egg.svg']);
assert.ok(fs.readFileSync(path.join(root, hatchPalette.consumer), 'utf8').includes("../assets/subagent-egg.svg?raw"));

console.log(`[subagent-avatar-assets] ok: ${expectedFiles.length} character SVGs (${bytes} bytes) and the hatch SVG, exact palettes and runtime imports verified.`);
