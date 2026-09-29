import type { FlowItem, FlowToolItem } from '../types/flow-chat';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { readInteractionInput, readToolRecord, toolString } from '../tool-cards/toolInteractionModel';

// Six is divisible by every supported column count (1, 2, 3). Batch boundaries
// therefore never leave a hole mid-row, and resizing never reparents a card.
export const AGENT_CARD_BATCH_SIZE = 6;

/** Launch identity cards share layout; send/wait/interrupt actions keep their rows. */
export function isAgentLaunchCard(item: FlowItem): boolean {
  if (item.type !== 'tool') return false;
  const tool = projectEffectiveToolItem(item as FlowToolItem);
  if (tool.toolName === 'AgentSpawn') return true;
  if (tool.toolName !== 'Task' && tool.toolName !== 'LaunchReviewAgent') return false;
  const action = (toolString(readInteractionInput(tool).action)
    || toolString(readToolRecord(tool.toolResult?.result).action)).toLowerCase();
  return action !== 'send_input' && action !== 'cancel';
}

/** A leading thought remains a sibling of its first successor for handoff. */
export function isAgentCardRun(items: readonly FlowItem[]): boolean {
  return items.some(isAgentLaunchCard)
    && items.every(item => item.type === 'thinking' || isAgentLaunchCard(item));
}

// Estimates use the default public transcript geometry. CSS and DOM measurement
// remain authoritative for Appearance overrides and each viewport's rail/insets.
export function estimateAgentCardColumns(availableWidthPx = 900): number {
  const contentWidth = Math.max(0, Math.min(900, availableWidthPx) - 24);
  const gap = 12;
  const cardWidth = (900 - 24 - 2 * gap) / 3;
  return Math.max(1, Math.min(3, Math.floor((contentWidth + gap) / (cardWidth + gap))));
}
