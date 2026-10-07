import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readBtwSessionPanelStylesheet(): string {
  const stylesheet = readFileSync(
    fileURLToPath(new URL('./BtwSessionPanel.scss', import.meta.url)),
    'utf8',
  );
  return stylesheet.replace(/\r\n/g, '\n');
}

function extractBlock(stylesheet: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[\\s\\S]*?)\\n\\s*\\}`));
  return match?.groups?.body ?? '';
}

describe('BtwSessionPanel layout styles', () => {
  it('preserves the shared virtual row margin containment', () => {
    const stylesheet = readBtwSessionPanelStylesheet();
    const shared = readFileSync(
      fileURLToPath(new URL('../modern/VirtualItemRenderer.scss', import.meta.url)), 'utf8',
    );
    expect(extractBlock(shared, '.virtual-item-wrapper')).toContain('display: flow-root;');
    // A more specific sidebar rule must not undo the measured row boundary.
    expect(extractBlock(stylesheet, '.virtual-item-wrapper')).not.toMatch(/display\s*:/);
  });

  it('keeps the review action bar wrapper bounded inside the panel viewport', () => {
    const stylesheet = readBtwSessionPanelStylesheet();
    const wrapper = extractBlock(stylesheet, '&__action-bar-wrapper');

    expect(wrapper).toContain('position: absolute;');
    expect(wrapper).toContain('inset: 0;');
    expect(wrapper).toContain('padding: 56px 14px 14px;');
    expect(wrapper).toContain('overflow: hidden;');
    expect(stylesheet).toContain('&__action-bar-wrapper > .deep-review-action-bar');
    expect(stylesheet).toContain('max-height: 100%;');
  });
});
