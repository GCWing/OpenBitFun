import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  ).replace(/\r\n?/g, '\n');
}

describe('FlowChat transcript column axis', () => {
  it('reserves the transcript scrollbar gutter on both edges of the scroller', () => {
    const stylesheet = readSource('./VirtualMessageList.scss');

    // Both edges, because the reading column is centred inside the scroller's
    // content box while the composer is centred on the panel itself. A
    // trailing-edge gutter alone sets the column half a scrollbar to the leading
    // side of the composer card, which is the offset that made the two disagree.
    expect(stylesheet).toContain('scrollbar-gutter: stable both-edges;');
    expect(stylesheet).not.toMatch(/scrollbar-gutter: stable;/);
  });

  it('centres the composer card on the panel and sizes it as the reading column', () => {
    const chatInput = readSource('../ChatInput.scss');
    const transcriptLayout = readSource('../../_transcript-layout.scss');

    expect(chatInput).toMatch(
      /\.openbitfun-context-drop-zone\.openbitfun-chat-input-drop-zone \{[\s\S]*?left: 50%;[\s\S]*?transform: translateX\(-50%\);[\s\S]*?max-width: var\(--openbitfun-control-flow-chat-transcript-max-width\);/,
    );
    expect(transcriptLayout).toMatch(
      /@mixin reading-column \{[\s\S]*?max-width: var\(--openbitfun-control-flow-chat-transcript-max-width\);/,
    );
  });

  it('keeps both reading-column insets equal so the column stays on the panel axis', () => {
    const transcriptLayout = readSource('../../_transcript-layout.scss');
    const readingColumn = transcriptLayout.slice(
      transcriptLayout.indexOf('@mixin reading-column {'),
      transcriptLayout.indexOf('// Transcript containers own the reading column'),
    );

    // A lane that rides on the rail side only (rail lane plus a small opposite
    // inset) centres the column just while the centring slack covers the lane.
    // Below that panel width the lane wins and moves the column up to 10px off
    // the axis the composer, the header, and the welcome surface stay on.
    expect(readingColumn).toContain('margin-inline: auto;');
    expect(readingColumn).not.toContain('margin-inline-start: max(');
    expect(readingColumn).toMatch(
      /width: calc\(100% - #\{\$turn-rail-offset\} - #\{\$turn-rail-width\} - var\(--openbitfun-space-1\) - var\(--openbitfun-space-2\)\);/,
    );
  });

  it('ends the sent-message bubble on the same column content edge as the cards', () => {
    const stylesheet = readSource('./UserMessageItem.scss');

    // The bubble is the one row whose painted surface, not its text, reads as
    // the message edge, so its radius must not lift it off the column the tool
    // cards and the composer card end on. The attachment gallery is a sibling of
    // the bubble and shares that edge.
    expect(stylesheet).toContain('margin-inline: auto 0;');
    expect(stylesheet).not.toContain('margin-inline: auto calc(-1 * var(--_user-message-radius));');
    expect(stylesheet).not.toContain('margin-inline-end: calc(-1 * var(--_user-message-radius));');
  });
});
