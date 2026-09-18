import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import { isAmbientToolRunContinuationAfter } from './flowChatRhythm';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  ).replace(/\r\n?/g, '\n');
}

describe('FlowChat transcript rhythm', () => {
  it('contains descendant spacing within the measured virtual row without clipping controls', () => {
    const styles = readSource('./VirtualItemRenderer.scss');
    const wrapper = styles.slice(styles.indexOf('.virtual-item-wrapper {'), styles.indexOf("&[data-item-type='user-message']"));

    // This is a stylesheet contract; browser margin geometry needs real layout.
    expect(wrapper).toContain('display: flow-root;');
    expect(wrapper).not.toMatch(/overflow(?:-x|-y)?:\s*(?:hidden|clip|auto|scroll)\s*;/);
  });

  function modelRound(
    turnId: string,
    roundId: string,
    items: Array<'text' | 'thinking' | { toolName: string }>,
  ): VirtualItem {
    return {
      type: 'model-round',
      turnId,
      data: {
        id: roundId,
        items: items.map((item, index) => typeof item === 'string'
          ? {
              id: `${roundId}-${index}`,
              type: item,
            }
          : {
              id: `${roundId}-${index}`,
              type: 'tool',
              toolName: item.toolName,
              toolCall: { id: `${roundId}-call-${index}`, input: {} },
            }),
      },
      isLastRound: false,
      isTurnComplete: false,
    } as unknown as VirtualItem;
  }

  it('treats collapsed ambient tool runs as text-like rows', () => {
    const toolStyles = readSource('../../_item-rhythm.scss');

    expect(toolStyles).toContain(
      'margin: 0 0 var(--openbitfun-control-flow-chat-flow-item-gap) 0;',
    );
    expect(toolStyles).not.toContain(
      'margin: 0 0 var(--openbitfun-control-flow-chat-card-gap) 0;',
    );
    expect(toolStyles).toMatch(
      /data-openbitfun-attention='ambient'[\s\S]*?data-openbitfun-expanded-shell='false'[\s\S]*?:has\([\s\S]*?\+ \.flowchat-flow-item[\s\S]*?margin-bottom: 0;/,
    );
    expect(toolStyles).not.toContain(
      "> [data-openbitfun-component='flow-chat-tool-card'][data-openbitfun-part='root'][data-openbitfun-expanded-shell='false']",
    );
    expect(toolStyles).not.toContain('+ .task-with-subagent-wrapper');
    for (const owner of ['./ModelRoundItem.scss', './ExploreRegion.scss', '../subagent/SubagentProjectionView.scss']) {
      expect(readSource(owner)).toContain('@include itemRhythm.apply');
    }
    for (const leaf of ['../FlowToolCard.scss', '../FlowTextBlock.scss', '../../tool-cards/ModelThinkingDisplay.scss']) {
      expect(readSource(leaf)).not.toContain('margin: 0 0 var(--openbitfun-control-flow-chat-flow-item-gap) 0;');
    }
  });

  it('gives every new user Turn one token-owned boundary gap', () => {
    const rendererStyles = readSource('./VirtualItemRenderer.scss');
    const userMessageStyles = readSource('./UserMessageItem.scss');

    expect(rendererStyles).toMatch(
      /\[data-item-type='user-message'\]:not\(\[data-virtual-index='0'\]\)\s*\{\s*padding-top: calc\(var\(--openbitfun-control-flow-chat-turn-gap\) \+ var\(--openbitfun-space-4\)\);/,
    );
    expect(rendererStyles).toContain(
      "&[data-turn-boundary-after='true']",
    );
    expect(rendererStyles).not.toContain(
      "&:has(+ .virtual-item-wrapper[data-item-type='user-message'])",
    );
    expect(rendererStyles).toContain('> .turn-completion-notice,');
    expect(rendererStyles).toContain('> .turn-failure-notice,');
    expect(rendererStyles).toContain(':has(+ .model-round-item__footer)');
    expect(rendererStyles).toContain(
      '> .task-with-subagent-wrapper:is(',
    );
    expect(userMessageStyles).toMatch(
      /margin:\s*0\.06rem\s*0\s*var\(--openbitfun-control-flow-chat-flow-item-gap\)/,
    );
  });

  it('keeps only ambient tool runs compact across model-round virtual rows', () => {
    const rendererStyles = readSource('./VirtualItemRenderer.scss');
    const rendererSource = readSource('./VirtualItemRenderer.tsx');
    const listSource = readSource('./VirtualMessageList.tsx');
    const taskStyles = readSource('../../tool-cards/TaskToolDisplay.scss');
    const firstAmbientRound = modelRound('turn-1', 'round-1', ['text', { toolName: 'Read' }]);
    const secondAmbientRound = modelRound('turn-1', 'round-2', [{ toolName: 'Grep' }]);
    const firstTaskRound = modelRound('turn-1', 'round-task-1', [{ toolName: 'Task' }]);
    const secondTaskRound = modelRound('turn-1', 'round-task-2', [{ toolName: 'Task' }]);

    expect(isAmbientToolRunContinuationAfter(firstAmbientRound, secondAmbientRound)).toBe(true);
    expect(isAmbientToolRunContinuationAfter(firstAmbientRound, firstTaskRound)).toBe(false);
    expect(isAmbientToolRunContinuationAfter(firstTaskRound, secondTaskRound)).toBe(false);
    expect(isAmbientToolRunContinuationAfter(
      firstAmbientRound,
      modelRound('turn-1', 'round-2', ['thinking']),
    )).toBe(false);
    expect(isAmbientToolRunContinuationAfter(
      firstAmbientRound,
      modelRound('turn-2', 'round-2', [{ toolName: 'Grep' }]),
    )).toBe(false);

    expect(listSource).toContain(
      'continuesAmbientToolRunAfter={isAmbientToolRunContinuationAfter(item, nextItem)}',
    );
    expect(rendererSource).toContain(
      "data-ambient-tool-run-continuation-after={continuesAmbientToolRunAfter ? 'true' : undefined}",
    );
    expect(rendererStyles).toContain(
      "&[data-ambient-tool-run-continuation-after='true']",
    );
    expect(rendererStyles).not.toContain(
      "> [data-openbitfun-component='flow-chat-tool-card'][data-openbitfun-part='root'][data-openbitfun-expanded-shell='false']",
    );
    expect(rendererStyles).not.toContain(
      '.task-with-subagent-wrapper:last-child:not(.task-with-subagent-wrapper--expanded)',
    );
    expect(taskStyles).toContain('margin-block: 0;');
    expect(taskStyles).not.toMatch(/&\.task-with-subagent-wrapper--expanded\s*\{\s*margin-block:/);
  });
});
