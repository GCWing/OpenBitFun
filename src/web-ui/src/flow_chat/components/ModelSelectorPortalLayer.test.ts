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

  it('uses one shared overlay surface for summary, model and reasoning views', () => {
    const component = readSource('./ModelSelector.tsx');

    expect(component).toContain('data-testid="chat-model-selector-options"');
    expect(component.match(/getAppearanceOverlayHost\(\)/g)).toHaveLength(1);
    expect(component).not.toContain('chat-model-selector-submenu');
  });
});
