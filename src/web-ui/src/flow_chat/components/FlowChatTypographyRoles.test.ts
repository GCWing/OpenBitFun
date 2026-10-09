import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  ).replace(/\r\n?/g, '\n');
}

function extractBlock(source: string, selector: string): string {
  const selectorStart = source.indexOf(selector);
  expect(selectorStart, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0);

  const blockStart = source.indexOf('{', selectorStart);
  expect(blockStart, `Missing block for selector: ${selector}`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = blockStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(blockStart + 1, index);
    }
  }

  throw new Error(`Unclosed block for selector: ${selector}`);
}

function expectRole(source: string, selector: string, role: string): void {
  const block = extractBlock(source, selector);
  const declaration = `font-size: var(--openbitfun-type-flow-${role}-font-size);`;
  if (block.includes(declaration)) return;

  // A surface may take its role from a shared mixin instead of restating the
  // size. The contract is the role it renders at, not where it is written, and
  // a surface that names its own size is how a track drifts off the ladder.
  const included = block.match(/@include\s+([\w-]+);/)?.[1];
  expect(included, `Missing ${role} role on: ${selector}`).toBeTruthy();
  expect(
    extractBlock(source, `@mixin ${included} {`),
    `Mixin ${included} does not carry the ${role} role for: ${selector}`,
  ).toContain(declaration);
}

describe('FlowChat semantic typography roles', () => {
  it('keeps answer and reasoning content on theme-owned tones', () => {
    const flowTextBlock = readSource('./FlowTextBlock.scss');
    const reasoning = readSource('../tool-cards/ModelThinkingDisplay.scss');

    expect(extractBlock(flowTextBlock, '.flow-text-block {')).toContain(
      'color: var(--openbitfun-color-content-primary);',
    );
    expect(reasoning).toContain('color: var(--openbitfun-color-content-secondary);');
    expect(flowTextBlock).not.toContain('data-color-scheme');
    expect(flowTextBlock).not.toContain('color-mix(');
  });

  it('consumes public semantic roles without a parallel Sass or Appearance ladder', () => {
    const stylesheets = [
      readSource('./ChatInput.scss'),
      readSource('./ChatInputWorkspaceStrip.scss'),
      readSource('./FlowTextBlock.scss'),
      readSource('./modern/ModelRoundItem.scss'),
      readSource('./modern/UserMessageItem.scss'),
    ].join('\n');

    // typography-audit: negative-test-start -- verifies retired FlowChat typography aliases stay absent
    expect(stylesheets).not.toContain('flow-type.$');
    expect(stylesheets).not.toContain('--openbitfun-appearance-token-flowchat-font');
    // typography-audit: negative-test-end
    for (const role of ['body', 'control', 'support', 'meta', 'micro']) {
      expect(stylesheets).toContain(`--openbitfun-type-flow-${role}-font-size`);
    }
  });

  it('uses public reading roles and the shared code font for code content', () => {
    const markdown = readSource('../../infrastructure/markdown/Markdown.scss');
    for (const [selector, role] of [
      ['.markdown-renderer {', 'flow-body'],
      ...[1, 2, 3, 4, 5, 6].map(level => [`.markdown-renderer h${level}`, 'heading-section']),
      ['.markdown-renderer pre {', 'flow-code'],
      ['.markdown-renderer .code-block-lang {', 'flow-meta'],
      ['.markdown-renderer .code-block-body {', 'flow-code'],
      ['.markdown-renderer summary {', 'heading-card'],
      ['.markdown-renderer .table-wrapper table {', 'flow-body'],
      ['.markdown-renderer .table-wrapper th {', 'label-sm'],
    ]) {
      const block = extractBlock(markdown, selector);
      expect(block).toContain(selector === '.markdown-renderer {'
        ? 'font-family: var(--openbitfun-type-flow-body-font-family);'
        : role === 'flow-code' ? 'font-family: var(--openbitfun-type-flow-code-font-family);'
        : 'font-family: inherit;');
      for (const property of ['font-size', 'font-weight', 'line-height', 'letter-spacing']) {
        expect(block).toContain(`${property}: var(--openbitfun-type-${role}-${property});`);
      }
    }

    for (const source of [markdown, readSource('../../infrastructure/markdown/MermaidBlock.scss')]) {
      const families = Array.from(source.matchAll(/font-family:\s*([^;]+);/g), match => match[1].trim());
      expect(families.every(family => family === 'inherit'
        || family === 'var(--openbitfun-type-flow-code-font-family)'
        || family === 'var(--openbitfun-type-flow-body-font-family)')).toBe(true);
    }

    for (const consumer of [
      './FlowTextBlock.scss',
      './modern/VirtualItemRenderer.scss',
      './usage/SessionUsagePanel.scss',
      './usage/SessionUsageReportCard.scss',
      './voice/ConversationModeSurface.scss',
      '../tool-cards/ModelThinkingDisplay.scss',
    ]) {
      expect(readSource(consumer)).not.toContain('markdownTypography');
    }

    const flowTextBlock = extractBlock(
      readSource('./FlowTextBlock.scss'),
      '.flow-text-block {',
    );
    const thinkingMarkdown = extractBlock(
      readSource('../tool-cards/ModelThinkingDisplay.scss'),
      '.thinking-content .markdown-renderer.thinking-markdown {',
    );

    expect(flowTextBlock).toContain(
      'font-size: var(--openbitfun-type-flow-body-font-size);',
    );
    expect(thinkingMarkdown).not.toContain('font-size:');
  });

  it('keeps composer controls on their flow role and menu labels on the shared action role', () => {
    const chatInput = readSource('./ChatInput.scss');
    const harness = readSource('./HarnessProfileSelector.scss');
    const model = readSource('./ModelSelector.scss');
    const reasoning = readSource('./ReasoningPresetSelector.scss');
    const menu = readSource('../../../../../design-system/packages/ui/src/components/Menu/Menu.tsx');
    const actionItem = readSource('../../../../../design-system/packages/ui/src/components/ActionItem/ActionItem.module.css');

    expectRole(chatInput, '&__target-tab {', 'control');
    expectRole(chatInput, '&__slash-command-name {', 'control');
    expectRole(harness, '.openbitfun-harness-selector__trigger {', 'control');
    expectRole(model, '&__trigger {', 'control');
    // MenuItem now owns the model row's label through ActionItem; the product
    // wrapper must inherit that public role rather than recreate its sizing.
    expect(menu).toContain('<ActionItem');
    expect(extractBlock(model, '&__option-name {')).not.toMatch(/\bfont(?:-[\w-]+)?\s*:/);
    const label = extractBlock(actionItem, '\n  .label {');
    for (const property of ['font-family', 'font-size', 'font-weight', 'letter-spacing']) {
      expect(label).toContain(`${property}: var(--openbitfun-type-label-md-${property});`);
      expect(extractBlock(model, '&__dropdown {')).toContain(
        `${property}: var(--openbitfun-type-label-md-${property});`,
      );
    }
    expect(label).toContain('line-height: var(--openbitfun-type-action-row-line-height);');
    expectRole(reasoning, '&__title {', 'control');
    expectRole(reasoning, '&__option-label {', 'control');
  });

  it('separates readable content, support text, metadata, and micro badges', () => {
    const chatInput = readSource('./ChatInput.scss');
    const modelRound = readSource('./modern/ModelRoundItem.scss');
    const userMessage = readSource('./modern/UserMessageItem.scss');
    const markdown = readSource('../../infrastructure/markdown/Markdown.scss');
    const workspaceStrip = readSource('./ChatInputWorkspaceStrip.scss');

    expectRole(chatInput, '&__placeholder {', 'control');
    expectRole(chatInput, '&__slash-command-label {', 'support');
    expectRole(chatInput, '&__slash-command-status {', 'meta');
    // The context track is a quiet meta line above the composer surface: one
    // step for every label on it, facts and controls alike.
    expectRole(workspaceStrip, '&__permission-trigger {', 'meta');
    expect(modelRound).not.toContain('.model-round-item__retry-toggle {');
    expect(extractBlock(modelRound, '.model-round-item__meta {')).toContain(
      'font-size: var(--openbitfun-type-flow-meta-font-size);',
    );
    expectRole(userMessage, '.user-message-item__content {', 'control');
    expectRole(userMessage, '.user-message-item__steering-tag {', 'micro');
    expect(extractBlock(userMessage, '.user-message-item--failed {')).toContain(
      '--_failed-font-size: var(--openbitfun-type-flow-control-font-size);',
    );
    const inlineCode = extractBlock(markdown, '.markdown-renderer .inline-code {');
    expect(inlineCode).toContain('font-family: var(--openbitfun-type-flow-code-font-family);');
    expect(inlineCode).toContain('font-size: inherit;');
    expect(inlineCode).toContain('font-weight: var(--openbitfun-type-flow-body-font-weight);');
  });

  it('keeps inline duration and shared completion details accessible on public tokens', () => {
    const component = readSource('./modern/ModelRoundItem.tsx');
    const stylesheet = readSource('./modern/ModelRoundItem.scss');
    const meta = extractBlock(stylesheet, '.model-round-item__meta {');
    const metrics = readSource('../../../../../design-system/packages/ui/src/flow-chat/conversation/FlowChatTurnMetrics.tsx');
    const metricStyles = readSource('../../../../../design-system/packages/ui/src/flow-chat/conversation/FlowChatTurnMetrics.module.css');

    expect(component).not.toContain('model-round-item__meta-label');
    expect(component).not.toContain('model-round-item__meta-value');
    expect(component).toContain('description={completionMetaItems.map(item => `${item.label}: ${item.value}`).join(\' · \')}');
    expect(component).toContain('content={<FlowChatMetricDetails rows={completionMetaItems} />}');
    expect(component).toContain('{durationMetaItem.value}');
    expect(metrics).toContain('aria-label={description}');
    expect(extractBlock(metricStyles, '.metric {')).toContain('font: inherit;');
    for (const property of ['font-family', 'font-size', 'font-weight', 'line-height']) {
      expect(extractBlock(metricStyles, '.root {')).toContain(
        `${property}: var(--openbitfun-type-flow-meta-${property});`,
      );
    }
    expect(meta).toContain('gap: var(--openbitfun-space-2);');
    expect(meta).toContain('color: var(--openbitfun-color-content-muted);');
    expect(meta).toContain('font-family: var(--openbitfun-type-flow-meta-font-family);');
    expect(meta).toContain('font-size: var(--openbitfun-type-flow-meta-font-size);');
    expect(meta).toContain('font-weight: var(--openbitfun-type-flow-meta-font-weight);');
    expect(meta).toContain('line-height: var(--openbitfun-type-flow-meta-line-height);');
  });
});
