import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  ).replace(/\r\n?/g, '\n');
}

describe('FlowChat transcript edge fade', () => {
  it('keeps the changing mask stop local to the scroller', () => {
    const stylesheet = readSource('./VirtualMessageList.scss');
    const registration = stylesheet.match(/@property\s+--_flow-chat-top-mask-start\s*\{([^}]+)\}/)?.[1];

    expect(registration).toBeDefined();
    expect(registration).toMatch(/syntax:\s*['"]\*['"]/);
    expect(registration).toMatch(/inherits:\s*false\s*;/);
    expect(registration).toMatch(/initial-value:\s*transparent 0\s*;/);
  });

  it('fades the transcript at the top and before the live ChatInput edge', () => {
    const component = readSource('./VirtualMessageList.tsx');
    const stylesheet = readSource('./VirtualMessageList.scss');

    expect(component).toContain(
      'const inputOverlayInsetPx = computeFlowChatInputOverlayInsetPx(inputHeight);',
    );
    expect(component).toContain(
      "'--_flow-chat-input-overlay-inset': `${inputOverlayInsetPx}px`",
    );
    expect(component).toContain('scroller.dataset.scrollAtStart = nextAttribute;');
    expect(component).not.toContain('const [isAtScrollStart, setIsAtScrollStart]');
    expect(component).toContain(
      'const FLOWCHAT_SCROLL_START_THRESHOLD_PX = 1;',
    );
    expect(stylesheet).toContain('-webkit-mask-image: linear-gradient(');
    expect(stylesheet).toContain('mask-image: linear-gradient(');
    const maskGradients = [
      ...stylesheet.matchAll(
        /(?:^|\n)\s*(?:-webkit-)?mask-image:\s*linear-gradient\(([\s\S]*?)\n\s*\);/g,
      ),
    ].map((match) => match[1]);

    expect(maskGradients).toHaveLength(2);
    for (const gradient of maskGradients) {
      expect(gradient).toContain('var(--_flow-chat-top-mask-start),');
      expect(gradient).toContain(
        'var(--openbitfun-color-content-on-light) var(--openbitfun-space-12),',
      );
    }
    expect(stylesheet).toContain(
      '100% - var(--_flow-chat-input-overlay-inset) - var(--openbitfun-space-12)',
    );
    expect(stylesheet).toContain(
      'transparent calc(100% - var(--_flow-chat-input-overlay-inset))',
    );
    expect(stylesheet).toContain(
      "&__scroller[data-scroll-at-start='true']",
    );
    expect(stylesheet).toContain(
      "--_flow-chat-top-mask-start: var(--openbitfun-color-content-on-light) 0;",
    );
    expect(stylesheet).toContain(
      '--_flow-chat-top-mask-start: transparent 0;',
    );
    expect(stylesheet).not.toContain('backdrop-filter');
  });

  it('removes the mask in forced-colors mode', () => {
    const stylesheet = readSource('./VirtualMessageList.scss');
    const forcedColors = stylesheet.slice(stylesheet.indexOf('@media (forced-colors: active)'));

    expect(forcedColors).toContain('.virtual-message-list__scroller');
    expect(forcedColors).toContain('-webkit-mask-image: none;');
    expect(forcedColors).toContain('mask-image: none;');
  });
});
