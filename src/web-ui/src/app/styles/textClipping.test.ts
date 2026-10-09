import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'sass';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(__dirname, '../../..');
const systemTokens = JSON.parse(readFileSync(
  resolve(webRoot, '../../design-system/packages/design-tokens/src/system.tokens.json'), 'utf8',
));

// Read the bundled non-Apple SC face directly from its SFNT head/hhea tables.
// No font download or platform fallback is involved in this line-box contract.
function bundledFontLineHeight(): number {
  const font = readFileSync(resolve(webRoot,
    'src/assets/fonts/harmonyos-sans/sc/HarmonyOS_Sans_SC.ttf'));
  expect(font.readUInt32BE(0)).toBe(0x00010000);

  const tables = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < font.readUInt16BE(4); index += 1) {
    const recordOffset = 12 + index * 16;
    const tag = font.toString('ascii', recordOffset, recordOffset + 4);
    const offset = font.readUInt32BE(recordOffset + 8);
    const length = font.readUInt32BE(recordOffset + 12);
    expect(offset + length).toBeLessThanOrEqual(font.byteLength);
    tables.set(tag, { offset, length });
  }

  const head = tables.get('head');
  const hhea = tables.get('hhea');
  expect(head).toBeDefined();
  expect(hhea).toBeDefined();
  const unitsPerEm = font.readUInt16BE(head!.offset + 18);
  const ascent = font.readInt16BE(hhea!.offset + 4);
  const descent = font.readInt16BE(hhea!.offset + 6);
  const lineGap = font.readInt16BE(hhea!.offset + 8);
  expect({ unitsPerEm, ascent, descent, lineGap }).toEqual({
    unitsPerEm: 1000,
    ascent: 928,
    descent: -244,
    lineGap: 0,
  });
  return (ascent - descent + lineGap) / unitsPerEm;
}

function compiledRules(filename: string) {
  const css = compile(resolve(webRoot, 'src/app', filename), {
    importers: [{
      findFileUrl(url: string) {
        if (!url.startsWith('@/')) return null;
        const unresolved = resolve(webRoot, 'src', url.slice(2));
        const candidates = extname(unresolved)
          ? [unresolved]
          : [
              `${unresolved}.scss`,
              resolve(dirname(unresolved), `_${basename(unresolved)}.scss`),
              resolve(unresolved, '_index.scss'),
              resolve(unresolved, 'index.scss'),
            ];
        const matched = candidates.find(candidate => existsSync(candidate));
        return matched ? pathToFileURL(matched) : null;
      },
    }],
  }).css;
  return (selector: string) => {
    const declarations: Record<string, string> = {};
    let matched = false;
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!rule[1].split(',').some((entry) => entry.trim() === selector)) continue;
      matched = true;
      for (const declaration of rule[2].split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
    }
    expect(matched, `Missing selector: ${selector}`).toBe(true);
    return declarations;
  };
}

describe('Truncated product text line boxes', () => {
  it('keeps the bundled font metrics inside the existing system line-height scale', () => {
    const required = bundledFontLineHeight();
    expect(required).toBeCloseTo(1.172, 3);
    expect(systemTokens.lineHeight.tight.$value).toBe(1.2);
    expect(systemTokens.lineHeight.tight.$value).toBeGreaterThanOrEqual(required);
    expect(systemTokens.lineHeight.compact.$value).toBeGreaterThanOrEqual(required);
    expect(systemTokens.lineHeight.base.$value).toBeGreaterThanOrEqual(required);
  });

  it.each([
    ['components/NavPanel/NavPanel.scss', '.openbitfun-nav-panel__search-trigger'],
    ['components/NavPanel/NavPanel.scss', '.openbitfun-nav-panel__section-label'],
    ['components/NavPanel/sections/sessions/SessionsSection.scss', '.openbitfun-nav-panel__inline-item'],
    ['components/NavPanel/sections/sessions/SessionsSection.scss', '.openbitfun-nav-panel__inline-item-assistant-name'],
    ['components/NavPanel/sections/sessions/SessionsSection.scss', '.openbitfun-nav-panel__inline-item-workspace-name'],
    ['components/NavPanel/sections/sessions/SessionsSection.scss', '.openbitfun-nav-panel__inline-toggle'],
    ['components/NavPanel/sections/workspaces/WorkspaceListSection.scss', '.openbitfun-nav-panel__workspace-item-label'],
    ['components/NavPanel/sections/workspaces/WorkspaceListSection.scss', '.openbitfun-nav-panel__assistant-item-label'],
    ['scenes/skills/SkillsScene.scss', '.skills-card__name'],
    ['scenes/skills/SkillsScene.scss', '.skills-card__desc'],
  ])('%s gives %s a font-relative, descender-safe line height', (filename, selector) => {
    const lineHeight = selector === '.skills-card__name'
      ? 'var(--openbitfun-type-label-sm-line-height)'
      : selector === '.skills-card__desc'
        ? 'var(--openbitfun-type-meta-line-height)'
        : 'var(--openbitfun-type-body-sm-line-height)';
    expect(compiledRules(filename)(selector)['line-height']).toBe(lineHeight);
  });

  it('delegates single-line overflow while retaining the two-line skills description clamp', () => {
    const skills = compiledRules('scenes/skills/SkillsScene.scss');
    expect(skills('.skills-card__name')['text-overflow']).toBeUndefined();
    expect(skills('.skills-card__desc')['-webkit-line-clamp']).toBe('2');
    const sessions = compiledRules('components/NavPanel/sections/sessions/SessionsSection.scss');
    expect(sessions('.openbitfun-nav-panel__inline-item-label')['text-overflow']).toBeUndefined();
    expect(sessions('.openbitfun-nav-panel__inline-item-label')['line-height']).toBe('inherit');
    expect(sessions('.openbitfun-nav-panel__inline-item').height).toBe('30px');
    expect(sessions('.openbitfun-nav-panel__inline-item.is-assistant-session').height).toBe('auto');
    expect(sessions('.openbitfun-nav-panel__inline-item.is-assistant-session')['min-height']).toBe('42px');
  });
});
