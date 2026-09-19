import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

describe('ModelSelector portal layer', () => {
  it('keeps the shared menu above overlay-hosted chat surfaces', () => {
    const component = readSource('./ModelSelector.tsx');
    const stylesheet = readSource('./ModelSelector.scss');
    const dropdownBlock = stylesheet.match(
      /&__dropdown\s*\{(?<body>[\s\S]*?)\n\s*\}/,
    )?.groups?.body;

    expect(component).toContain('createOverlayPortal(');
    expect(component).not.toContain('document.body');
    expect(dropdownBlock).toContain('z-index: var(--openbitfun-layer-popover);');
    expect(dropdownBlock).not.toContain('z-index: var(--openbitfun-layer-dropdown);');
  });

  it('keeps every model and reasoning menu in the shared overlay host', () => {
    const component = readSource('./ModelSelector.tsx');

    expect(component).toContain("'chat-model-selector-submenu'");
    expect(component.match(/getAppearanceOverlayHost\(\)/g)).toHaveLength(2);
  });
});
