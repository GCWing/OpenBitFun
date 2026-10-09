import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const stylesheet = readFileSync(
  resolve(repositoryRoot, 'design-system/packages/ui/src/styles/scrollbars.css'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('shared native scrollbar presentation', () => {
  it('keeps every non-thumb WebKit surface transparent', () => {
    expect(stylesheet).toMatch(/::-webkit-scrollbar\s*\{[^}]*background:\s*transparent;/s);

    for (const part of ['track', 'track-piece', 'corner', 'button']) {
      expect(stylesheet).toContain(`::-webkit-scrollbar-${part}`);
    }
    expect(stylesheet).toMatch(/::-webkit-resizer\s*\{\s*background:\s*transparent;/s);
    expect(stylesheet).toMatch(
      /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--openbitfun-color-scrollbar-thumb\);/s,
    );
    expect(stylesheet).toMatch(
      /::-webkit-scrollbar-thumb:hover,[^{}]+::-webkit-scrollbar-thumb:active\s*\{[^}]*background:\s*var\(--openbitfun-color-scrollbar-thumb-hover\);/s,
    );
  });

  it('preserves automatic track geometry and only releases explicitly opted-in hover tracks', () => {
    const interactionRules = stylesheet.slice(
      stylesheet.indexOf('@media (hover: hover)'),
      stylesheet.indexOf('/* Opt-in hover viewports'),
    );
    const hoverRules = stylesheet.slice(
      stylesheet.indexOf('/* Opt-in hover viewports'),
      stylesheet.indexOf('/* Explicit hidden viewports'),
    );

    expect(interactionRules).toContain('(pointer: fine) and (forced-colors: none)');
    expect(interactionRules).toContain(
      ':not(:hover, :focus-visible, :has(:focus-visible), [data-openbitfun-scrollbar-visibility="always"])',
    );
    expect(interactionRules).toContain('background: transparent;');
    expect(interactionRules).toContain('scrollbar-color: transparent transparent;');
    expect(interactionRules).not.toMatch(/(?:overflow|width|height|display|scrollbar-gutter)\s*:/);
    expect(hoverRules).toContain('@media (hover: hover) and (pointer: fine) and (forced-colors: none)');
    expect(hoverRules).toMatch(
      /\[data-openbitfun-scrollbar-visibility="hover"\]:not\(:hover, :focus-visible, :has\(:focus-visible\)\)\s*\{\s*scrollbar-width:\s*none;/,
    );
    expect(hoverRules).toMatch(
      /\[data-openbitfun-scrollbar-visibility="hover"\]:not\(:hover, :focus-visible, :has\(:focus-visible\)\)::-webkit-scrollbar\s*\{\s*display:\s*none;/,
    );
    expect(hoverRules).not.toMatch(/(?:overflow(?:-[xy])?|scrollbar-gutter)\s*:/);
    expect(stylesheet).not.toMatch(/\.is-scrolling|:focus-within|!important/);
  });

  it('guards standard width and color together so Safari 18 keeps the WebKit path', () => {
    expect(stylesheet).toMatch(
      /@supports \(scrollbar-color: transparent transparent\)\s*\{[^{}]+\{\s*scrollbar-width:\s*thin;\s*scrollbar-color:\s*var\(--openbitfun-color-scrollbar-thumb\) transparent;/,
    );
    expect(stylesheet.match(/scrollbar-width:\s*thin/g)).toHaveLength(1);
    expect(stylesheet).toMatch(
      /@media \(forced-colors: active\)[\s\S]*scrollbar-color:\s*auto;[\s\S]*background:\s*CanvasText;/,
    );
  });

  it('keeps native scrollbar paint in one owner across product and component styles', () => {
    const roots = [
      'src/web-ui/src',
      'design-system/packages/ui/src/components',
      'design-system/packages/ui/src/flow-chat',
    ];
    const overrides: string[] = [];

    for (const root of roots) {
      const directory = resolve(repositoryRoot, root);
      for (const relative of readdirSync(directory, { recursive: true })) {
        if (typeof relative !== 'string' || !/\.(css|scss)$/.test(relative)) continue;
        const content = readFileSync(resolve(directory, relative), 'utf8');
        if (/scrollbar-color\s*:|scrollbar-width\s*:\s*thin|::-webkit-scrollbar-thumb\b/.test(content)) {
          overrides.push(`${root}/${relative}`);
        }
      }
    }

    expect(overrides).toEqual([]);
  });
});
