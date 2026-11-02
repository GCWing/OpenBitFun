import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildDesktopCardSrcDoc, DESKTOP_CARD_WIDGET_CSS } from './DesktopCardCustomFrame';

const TOOL_SOURCE = readFileSync(
  new URL('../../../../../../src/crates/assembly/core/src/agentic/tools/implementations/desktop_card_tool.rs', import.meta.url),
  'utf8',
);

function rustConst(name: string): string {
  const raw = new RegExp(`const ${name}: &str =\\s*r(#+)"([\\s\\S]*?)"\\1;`).exec(TOOL_SOURCE);
  if (raw) return raw[2];
  const plain = new RegExp(`const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\.)*)";`).exec(TOOL_SOURCE);
  if (!plain) throw new Error(`Missing ${name} in desktop_card_tool.rs`);
  return plain[1];
}

function namesIn(text: string, pattern: RegExp): string[] {
  return [...new Set(text.match(pattern) ?? [])].sort();
}

describe('DesktopCardCustomFrame', () => {
  it('matches the card window color scheme so Chromium keeps the widget transparent', () => {
    const dark = buildDesktopCardSrcDoc('<p>hi</p>', { mode: 'dark', vars: {} });
    expect(dark).toContain('<html data-openbitfun-appearance-mode="dark">');
    expect(dark).toContain('color-scheme: dark;');
    expect(dark).toContain('<body><p>hi</p></body>');

    expect(buildDesktopCardSrcDoc('', { mode: 'light', vars: {} })).toContain('color-scheme: light;');

    const unknown = buildDesktopCardSrcDoc('', { mode: 'sepia', vars: {} });
    expect(unknown).toContain('<html>');
    expect(unknown).toContain('color-scheme: light dark;');
  });

  it('projects safe theme variables only', () => {
    const doc = buildDesktopCardSrcDoc('', {
      mode: 'dark',
      vars: { '--openbitfun-color-content-primary': '#fff', '--bad name': 'x', '--openbitfun-x': 'red; } body {' },
    });
    expect(doc).toContain('--openbitfun-color-content-primary: #fff;');
    expect(doc).not.toContain('--bad name');
    expect(doc).not.toContain('red; } body {');
  });

  it('defines every class and variable the DesktopCard tool tells the model to use', () => {
    const guidance = rustConst('CUSTOM_WIDGET_STYLE_GUIDANCE');
    const presetHtml = rustConst('PULL_REQUEST_LIST_HTML');
    const doc = buildDesktopCardSrcDoc('', { mode: 'dark', vars: {} });

    const classes = namesIn(`${guidance} ${presetHtml}`, /openbitfun-card-[a-z-]+/g);
    expect(classes.length).toBeGreaterThan(8);
    for (const className of classes) {
      expect(DESKTOP_CARD_WIDGET_CSS, className).toContain(`.${className}`);
    }

    const variables = namesIn(guidance, /--openbitfun-[a-z0-9-]+/g);
    expect(variables.length).toBeGreaterThan(10);
    for (const variable of variables) {
      expect(doc, variable).toMatch(new RegExp(`${variable}:`));
    }
  });
});
