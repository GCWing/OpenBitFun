import type { FlowItem, FlowTextItem, FlowToolItem } from '../types/flow-chat';
import { getEffectiveToolName, projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { awaitsApproval, isShellActivity, shellActivityStats } from './activityClassification';
import { isFlowGroupMemberActive } from './lifecycle';

export type FlowGroupStatusFilter = 'all' | 'active' | 'attention';
export interface FlowGroupBrowseFilter { tool: string; status: FlowGroupStatusFilter; query: string }
export interface FlowGroupToolCount { name: string; count: number }

export function flowGroupItemNeedsAttention(item: FlowItem): boolean {
  if (item.status === 'error' || item.status === 'cancelled' || item.status === 'rejected') return true;
  if (item.type !== 'tool') return false;
  const tool = item as FlowToolItem;
  if (awaitsApproval(tool) || tool.toolResult?.success === false) return true;
  if (!isShellActivity(tool)) return false;
  const stats = shellActivityStats([tool]);
  return stats.failed + stats.stopped + stats.nonZero > 0;
}

export function flowGroupToolCounts(items: readonly FlowItem[]): FlowGroupToolCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.type !== 'tool') continue;
    const name = getEffectiveToolName(item as FlowToolItem);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, count]) => ({ name, count }));
}

/** Search loaded source values directly; never stringify or retain a second copy of large outputs. */
function containsText(value: unknown, pattern: RegExp, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return pattern.test(value);
  if (typeof value === 'number' || typeof value === 'boolean') return pattern.test(String(value));
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(child => containsText(child, pattern, seen));
}

export function filterFlowGroupItems(
  items: readonly FlowItem[], filter: FlowGroupBrowseFilter,
  labels: ReadonlyMap<string, string>, pendingPermissions?: ReadonlySet<string>,
) {
  const query = filter.query.trim();
  const filtering = filter.tool !== 'all' || filter.status !== 'all' || Boolean(query);
  const pattern = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu') : null;
  const visibleIds = new Set<string>();
  const matchingThinkingIds = new Set<string>();
  let matchingCount = 0;
  let pinnedCount = 0;
  for (const item of items) {
    const tool = item.type === 'tool' ? item as FlowToolItem : undefined;
    const name = tool ? getEffectiveToolName(tool) : undefined;
    const matchesTool = filter.tool === 'all' || name === filter.tool;
    const matchesStatus = filter.status === 'all'
      || (filter.status === 'active' ? isFlowGroupMemberActive(item) : flowGroupItemNeedsAttention(item));
    const matchesText = matchesTool && matchesStatus && (!pattern || (tool
      ? pattern.test(name!) || pattern.test(labels.get(name!) ?? '')
        || containsText(projectEffectiveToolItem(tool).toolCall?.input, pattern)
        || containsText(tool.partialParams, pattern)
        || containsText(tool.toolResult?.result, pattern)
        || containsText(tool.toolResult?.resultForAssistant, pattern)
        || containsText(tool.toolResult?.error, pattern)
      : pattern.test((item as FlowTextItem).content ?? '')));
    const matches = matchesTool && matchesStatus && matchesText;
    // A permission mailbox remains answerable even when the reader narrows the list.
    const pinned = tool && (awaitsApproval(tool) || pendingPermissions?.has(tool.toolCall.id));
    if (!filtering || matches || pinned) visibleIds.add(item.id);
    if (matches) {
      matchingCount++;
      if (pattern && item.type === 'thinking') matchingThinkingIds.add(item.id);
    } else if (pinned) pinnedCount++;
  }
  return { filtering, visibleIds, matchingThinkingIds, matchingCount, pinnedCount };
}

/** Literal localized labels keep tool statistics readable while unknown tools retain their identity. */
export function flowGroupToolLabels(t: (key: string) => string): ReadonlyMap<string, string> {
  return new Map(Object.entries({
    Read: t('groupBrowser.tools.read'), LS: t('groupBrowser.tools.list'),
    Glob: t('groupBrowser.tools.glob'), Grep: t('groupBrowser.tools.grep'),
    WebSearch: t('groupBrowser.tools.webSearch'), WebFetch: t('groupBrowser.tools.webFetch'),
    view_image: t('groupBrowser.tools.image'),
    ExecCommand: t('groupBrowser.tools.execute'), Bash: t('groupBrowser.tools.legacyShell'),
    WriteStdin: t('groupBrowser.tools.interact'), ExecControl: t('groupBrowser.tools.control'),
    Skill: t('groupBrowser.tools.skill'), GetToolSpec: t('groupBrowser.tools.toolSpec'),
    OpenBitFunControl: t('groupBrowser.tools.discovery'),
    ControlHub: t('groupBrowser.tools.browser'), ComputerUse: t('groupBrowser.tools.desktop'),
  }));
}
