import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  ).replace(/\r\n?/g, '\n');
}

function boxShadowValues(source: string): string[] {
  return Array.from(source.matchAll(/box-shadow\s*:\s*([^;]+);/g), match => match[1].trim());
}

describe('FlowChat flat content surfaces', () => {
  it('flattens every Markdown block surface through one shared policy', () => {
    const policy = readSource('../_flat-markdown-surfaces.scss');

    for (const selector of [
      'pre',
      '.code-block-wrapper',
      '.table-wrapper',
      '.mermaid-block',
      'blockquote',
      '.custom-blockquote',
      'details',
    ]) {
      expect(policy).toContain(selector);
    }
    expect(policy).toContain('box-shadow: none;');

    for (const consumer of [
      './FlowTextBlock.scss',
      './modern/VirtualItemRenderer.scss',
      './usage/SessionUsagePanel.scss',
      './usage/SessionUsageReportCard.scss',
    ]) {
      expect(readSource(consumer)).toContain('@include flatMarkdownSurfaces.apply;');
    }
  });

  it('keeps product-owned transcript cards free of elevation shadows', () => {
    const sources = [
      readSource('../tool-cards/CreatePlanDisplay.scss'),
      readSource('../../../../../design-system/packages/ui/src/flow-chat/tool-cards/AgentControlToolCard.module.css'),
      readSource('./usage/SessionUsageReportCard.scss'),
    ];

    for (const source of sources) {
      expect(boxShadowValues(source).every(value => value === 'none')).toBe(true);
    }
    expect(sources[0]).not.toContain('translateY(-1px)');
  });
});
