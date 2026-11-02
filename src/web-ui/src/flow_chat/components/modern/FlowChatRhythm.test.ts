import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import { getNextVisibleVirtualItemIndexes, isAmbientToolRunContinuationAfter } from './flowChatRhythm';
import { getToolItemCardConfig } from '../../tool-cards/toolCardMetadata';
import type { FlowThinkingItem, FlowToolItem } from '../../types/flow-chat';

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
    items: Array<'text' | 'thinking' | { toolName: string; input?: unknown }>,
  ): Extract<VirtualItem, { type: 'model-round' }> {
    return {
      type: 'model-round',
      turnId,
      data: {
        id: roundId,
        renderHints: { disableExploreGrouping: true },
        items: items.map((item, index) => typeof item === 'string'
          ? {
              id: `${roundId}-${index}`,
              type: item,
              content: item,
              status: 'completed',
              isStreaming: false,
            }
          : {
              id: `${roundId}-${index}`,
              type: 'tool',
              toolName: item.toolName,
              status: 'completed',
              toolCall: { id: `${roundId}-call-${index}`, input: item.input ?? {} },
            }),
      },
      isLastRound: false,
      isTurnComplete: false,
    } as Extract<VirtualItem, { type: 'model-round' }>;
  }

  it('keeps control actions distinct from discovery across model rounds, including deferred calls', () => {
    const read = modelRound('turn-1', 'read', [{ toolName: 'Read' }]);
    const discovery = modelRound('turn-1', 'discovery', [{
      toolName: 'OpenBitFunControl', input: { action: 'get' },
    }]);
    const control = modelRound('turn-1', 'control', [{
      toolName: 'CallDeferredTool', input: { tool_name: 'OpenBitFunControl', args: { action: 'configure' } },
    }]);
    expect(isAmbientToolRunContinuationAfter(read, discovery)).toBe(true);
    expect(isAmbientToolRunContinuationAfter(discovery, control)).toBe(false);
    expect(isAmbientToolRunContinuationAfter(control, read)).toBe(false);
  });

  it('spaces desktop content and tool runs like body paragraphs', () => {
    const toolStyles = readSource('../../_item-rhythm.scss');
    const sharedRhythm = readSource('../../../../../../design-system/packages/ui/src/flow-chat/conversation/FlowItemRhythm.css');

    expect(toolStyles).toContain(
      'margin: 0 0 var(--openbitfun-control-flow-chat-paragraph-gap) 0;',
    );
    expect(toolStyles).not.toContain(
      'margin: 0 0 var(--openbitfun-control-flow-chat-card-gap) 0;',
    );
    expect(sharedRhythm).toMatch(
      /data-openbitfun-attention='ambient'[\s\S]*?data-openbitfun-expanded-shell='false'[\s\S]*?:has\([\s\S]*?\+ \.flowchat-flow-item[\s\S]*?margin-bottom: var\(--openbitfun-control-flow-chat-paragraph-gap\);/,
    );
    expect(toolStyles).not.toContain(
      "> [data-openbitfun-component='flow-chat-tool-card'][data-openbitfun-part='root'][data-openbitfun-expanded-shell='false']",
    );
    expect(toolStyles).not.toContain('+ .task-with-subagent-wrapper');
    expect(sharedRhythm).toContain("[data-thinking-attachment='side']");
    expect(sharedRhythm).toContain('[data-flow-item-stack]');
    expect(sharedRhythm).toContain('.flow-group-content-segment');
    for (const owner of ['./ModelRoundItem.scss', '../subagent/SubagentProjectionView.scss']) {
      expect(readSource(owner)).toContain('@include itemRhythm.apply');
    }
    const sharedExplore = readSource('../../../../../../design-system/packages/ui/src/flow-chat/conversation/ConversationBlocks.css');
    expect(sharedExplore).toContain("@import './FlowItemRhythm.css';");
    expect(sharedExplore).toContain('margin: 0 0 var(--openbitfun-control-flow-chat-flow-item-gap) 0;');
    for (const leaf of ['../FlowToolCard.scss', '../FlowTextBlock.scss', '../../tool-cards/ModelThinkingDisplay.scss']) {
      expect(readSource(leaf)).not.toContain('margin: 0 0 var(--openbitfun-control-flow-chat-flow-item-gap) 0;');
    }
  });

  it('keeps Shell anatomy and cross-round spacing ambient independently of grouping, including deferred calls', () => {
    const first = modelRound('turn', 'first', [{ toolName: 'ExecCommand' }]);
    for (const toolName of ['ExecCommand', 'Bash', 'WriteStdin', 'ExecControl']) {
      const next = modelRound('turn', toolName, [{ toolName }]);
      const tool = next.data.items[0] as FlowToolItem;
      expect(getToolItemCardConfig(tool).attention).toBe('ambient');
      expect(isAmbientToolRunContinuationAfter(first, next)).toBe(true);
    }
    const deferred = modelRound('turn', 'deferred', [{
      toolName: 'CallDeferredTool', input: { tool_name: 'ExecCommand', args: { command: 'pwd' } },
    }]);
    expect(isAmbientToolRunContinuationAfter(first, deferred)).toBe(true);
    expect(isAmbientToolRunContinuationAfter(deferred, first)).toBe(true);
  });

  it('keeps a compact command sequence independent of model-round partitioning', () => {
    const commands = Array.from({ length: 5 }, () => ({ toolName: 'ExecCommand' }));
    for (let split = 1; split < commands.length; split++) {
      const first = modelRound('turn', 'first', commands.slice(0, split));
      const next = modelRound('turn', 'next', commands.slice(split));
      expect(isAmbientToolRunContinuationAfter(first, next)).toBe(true);
    }
  });

  it('looks through only settled side reasoning with an immediate tool successor', () => {
    const first = modelRound('turn', 'first', [{ toolName: 'ExecCommand' }]);
    const next = modelRound('turn', 'next', ['thinking', { toolName: 'ExecCommand' }]);
    const thinking = next.data.items[0] as FlowThinkingItem;
    expect(isAmbientToolRunContinuationAfter(first, next)).toBe(true);
    thinking.isStreaming = true;
    expect(isAmbientToolRunContinuationAfter(first, next)).toBe(false);
    thinking.isStreaming = false;
    next.layoutHints = { expandedThinkingItemIds: [thinking.id] };
    expect(isAmbientToolRunContinuationAfter(first, next)).toBe(false);
    for (const items of [['thinking'], ['thinking', 'thinking', { toolName: 'ExecCommand' }], ['text', { toolName: 'ExecCommand' }]] as const) {
      expect(isAmbientToolRunContinuationAfter(first, modelRound('turn', 'boundary', [...items]))).toBe(false);
    }
  });

  it('uses visible active-attempt contents rather than blank text or hidden failed cards', () => {
    const first = modelRound('turn', 'first', [{ toolName: 'Read' }]);
    const next = modelRound('turn', 'next', [{ toolName: 'Write' }]);
    const active = modelRound('turn', 'active', ['text', { toolName: 'Read' }, { toolName: 'Grep' }]);
    Object.assign(active.data.items[0], { content: '  ' });
    Object.assign(active.data.items[1], { status: 'error' });
    next.data.attempts = [{ id: 'attempt', index: 1, items: active.data.items } as NonNullable<typeof next.data.attempts>[number]];
    expect(isAmbientToolRunContinuationAfter(first, next)).toBe(true);
  });

  it('keeps permissions, significant cards, controls and completed Turn footers as boundaries', () => {
    const first = modelRound('turn', 'first', [{ toolName: 'ExecCommand' }]);
    for (const toolName of ['Write', 'Edit', 'Task']) {
      expect(isAmbientToolRunContinuationAfter(first, modelRound('turn', toolName, [{ toolName }]))).toBe(false);
    }
    expect(isAmbientToolRunContinuationAfter(first, modelRound('turn', 'AgentWait', [{ toolName: 'AgentWait' }]))).toBe(true);
    const next = modelRound('turn', 'next', [{ toolName: 'ExecCommand' }]);
    expect(isAmbientToolRunContinuationAfter(first, next, new Set(['next-call-0']))).toBe(false);
    expect(isAmbientToolRunContinuationAfter(first, next, new Set(['first-call-0']))).toBe(false);
    for (const status of ['pending_confirmation', 'rejected'] as const) {
      Object.assign(next.data.items[0], { status });
      expect(isAmbientToolRunContinuationAfter(first, next)).toBe(false);
    }
    Object.assign(next.data.items[0], { status: 'completed' });
    next.data.renderHints = { ...next.data.renderHints, continuedAfterInterruption: true };
    expect(isAmbientToolRunContinuationAfter(first, next)).toBe(false);
    next.data.renderHints.continuedAfterInterruption = false;
    first.isLastRound = true;
    first.isTurnComplete = true;
    expect(isAmbientToolRunContinuationAfter(first, next)).toBe(false);
  });

  it('skips collected zero-height rows without dropping keys or crossing visible user messages', () => {
    const first = modelRound('turn', 'first', [{ toolName: 'ExecCommand' }]);
    const empty = modelRound('turn', 'collected', [{ toolName: 'Read' }]);
    empty.projectedGroups = [];
    const next = modelRound('turn', 'next', [{ toolName: 'ExecCommand' }]);
    const rows = [first, empty, next];
    const indexes = getNextVisibleVirtualItemIndexes(rows);
    expect(indexes).toEqual([2, 2, -1]);
    expect(rows[1]).toBe(empty);
    expect(isAmbientToolRunContinuationAfter(first, rows[indexes[0]])).toBe(true);
    const user = { type: 'user-message', turnId: 'other' } as VirtualItem;
    const separated = [first, empty, user, next];
    expect(isAmbientToolRunContinuationAfter(first, separated[getNextVisibleVirtualItemIndexes(separated)[0]])).toBe(false);
    empty.data.renderHints = { continuedAfterInterruption: true };
    expect(getNextVisibleVirtualItemIndexes(rows)[0]).toBe(1);
  });

  it('gives no item gap to a tool row whose card hides itself', () => {
    const toolStyles = readSource('../../_item-rhythm.scss');

    // The fallback also covers a lazy card returning no content. Known hidden
    // cards are filtered before composition using the leaf's visibility rule.
    expect(toolStyles).toMatch(
      /&:has\(> \.flow-tool-card-wrapper:empty\) \{\s*margin-bottom: 0;\s*\}/,
    );
    for (const hidingCard of [
      '../../tool-cards/ReadFileDisplay.tsx',
      '../../tool-cards/GrepSearchDisplay.tsx',
      '../../tool-cards/GlobSearchDisplay.tsx',
      '../../tool-cards/LSDisplay.tsx',
      '../../tool-cards/WebSearchCard.tsx',
    ]) {
      expect(readSource(hidingCard)).toMatch(/if \(!isToolCardVisible\(toolItem\)\) \{\s*return null;/);
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
    expect(rendererStyles).not.toContain(
      '> .task-with-subagent-wrapper:is(',
    );
    expect(userMessageStyles).toMatch(
      /margin:\s*var\(--openbitfun-control-flow-chat-user-message-margin-block-start\)\s*0\s*var\(--openbitfun-control-flow-chat-flow-item-gap\)/,
    );
  });

  it('keeps only ambient tool runs compact across model-round virtual rows', () => {
    const rendererStyles = readSource('./VirtualItemRenderer.scss');
    const rendererSource = readSource('./VirtualItemRenderer.tsx');
    const listSource = readSource('./VirtualMessageList.tsx');
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
      'continuesAmbientToolRunAfter={isAmbientToolRunContinuationAfter(item, nextItem, pendingPermissionToolCallIds)}',
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
  });
});
