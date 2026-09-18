import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

describe('UserMessageItem metadata visibility', () => {
  it('keeps image editing vertically ordered and compact', () => {
    const stylesheet = readFileSync(
      fileURLToPath(new URL('./UserMessageItem.scss', import.meta.url)),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    const editLayout = extractBlock(stylesheet, '\n.user-message-item__edit-layout {');
    const composer = extractBlock(stylesheet, '\n.user-message-edit-composer {');
    const textarea = extractBlock(stylesheet, '\n.user-message-edit-composer__textarea {');
    const richInput = extractBlock(stylesheet, '\n.user-message-edit-composer__rich-input {');
    const bubble = extractBlock(stylesheet, '\n.user-message-item {');
    const main = extractBlock(stylesheet, '\n.user-message-item__main {');
    const content = extractBlock(stylesheet, '\n.user-message-item__content {');
    const editingBubble = extractBlock(stylesheet, '\n.user-message-item--editing {');

    expect(editLayout).toContain('flex-direction: column;');
    expect(editLayout).toContain('gap: var(--openbitfun-control-flow-chat-inline-gap);');
    expect(composer).toContain('min-block-size: 0;');
    expect(composer).toContain('padding: 0;');
    expect(textarea).toContain('min-height: var(--openbitfun-control-height-sm);');
    expect(richInput).toContain('min-height: var(--openbitfun-control-height-sm);');
    expect(bubble).toContain('width: fit-content;');
    expect(bubble).toContain('min-width: min(8rem, 72%);');
    expect(bubble).toContain('max-width: min(72%, 48rem);');
    expect(bubble).toContain('border: none;');
    expect(main).toContain('justify-content: center;');
    expect(content).toContain('flex: 0 1 auto;');
    expect(content).toContain('width: fit-content;');
    expect(content).toContain('max-width: 100%;');
    expect(editingBubble).toContain('width: auto;');
    expect(editingBubble).toContain('max-width: none;');
    expect(stylesheet).not.toContain('.user-message-item__images--editing');
    expect(stylesheet).not.toContain('min-height: 5.5rem;');
  });

  it('reveals the copy, edit, and rollback actions as one hover or focus cluster', () => {
    const stylesheet = readFileSync(
      fileURLToPath(new URL('./UserMessageItem.scss', import.meta.url)),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    const actions = extractBlock(stylesheet, '\n.user-message-item__actions {');
    const shell = extractBlock(stylesheet, '.user-message-item-shell {');

    expect(actions).toContain('opacity: 0;');
    expect(actions).toContain('pointer-events: none;');
    expect(actions).not.toContain('visibility: hidden;');
    expect(shell).not.toContain('.user-message-item__actions');
    expect(stylesheet).toContain('.user-message-item-shell:hover .user-message-item__actions,');
    expect(stylesheet).toContain('.user-message-item-shell:focus-within .user-message-item__actions {\n  opacity: 1;\n  pointer-events: auto;');

    expect(stylesheet).toContain([
      '.user-message-item__copy-btn,',
      '.user-message-item__edit-btn,',
      '.user-message-item__rollback-btn {',
    ].join('\n'));
    expect(stylesheet).not.toContain('.user-message-item__edit-btn {\n  opacity: 1;');
  });

  it('reveals the timestamp beside the actions without shifting the action cluster', () => {
    const stylesheet = readFileSync(
      fileURLToPath(new URL('./UserMessageItem.scss', import.meta.url)),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    const shell = extractBlock(stylesheet, '.user-message-item-shell {');
    const timestamp = extractBlock(stylesheet, '\n.user-message-item__timestamp {');
    const sharedLayout = readFileSync(
      fileURLToPath(new URL('../../_transcript-layout.scss', import.meta.url)),
      'utf8',
    );
    const metaLayout = extractBlock(sharedLayout, '@mixin metadata-row {');

    expect(timestamp).toContain('opacity: 0;');
    expect(timestamp).toContain('visibility: hidden;');
    expect(timestamp).toContain('pointer-events: none;');
    expect(timestamp).not.toContain('margin-inline-end: auto;');
    expect(stylesheet).toContain('.user-message-item-shell:hover .user-message-item__timestamp,');
    expect(stylesheet).toContain('.user-message-item-shell:focus-within .user-message-item__timestamp {\n  opacity: 1;\n  visibility: visible;');
    const meta = extractBlock(stylesheet, '\n.user-message-item__meta {');
    expect(metaLayout).toContain('display: flex;');
    expect(meta + metaLayout).not.toMatch(/position:\s*(absolute|fixed);/);
    expect(meta + metaLayout).not.toMatch(/(?:^|\n)\s*(?:max-)?height:/);
    expect(metaLayout).toContain('justify-content: flex-end;');
    const bubble = extractBlock(stylesheet, '\n.user-message-item {');
    expect(bubble).toContain('padding: 0.46rem var(--_user-message-padding-inline);');
    expect(shell).toContain('--_user-message-padding-inline: var(--_user-message-radius);');
    expect(bubble).toContain('margin-inline: auto calc(-1 * var(--_user-message-radius));');
    expect(meta).toContain('padding-inline: 0;');
    expect(meta).toContain('padding-block: calc(var(--openbitfun-space-1) / 2) 0;');
    expect(meta).toContain('pointer-events: auto;');
    expect(shell).not.toContain('.user-message-item__timestamp');
    expect(shell).not.toContain('&--with-timestamp');
  });
});
