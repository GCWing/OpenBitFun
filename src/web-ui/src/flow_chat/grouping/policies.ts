import { buildContextLoadSummary } from '@openbitfun/flow-chat-presentation/context-load';
import type { FlowItem, FlowToolItem } from '../types/flow-chat';
import { getContextLoadKind, isSettledContextLoad } from '../tool-cards/contextLoadClassification';
import { computeExploreStats, isCollapsibleTool } from '../tool-cards/toolCardMetadata';
import { DEFERRED_TOOL_GATEWAY_NAME, getEffectiveToolName } from '../utils/toolInvocationIdentity';
import { awaitsApproval, isInterfaceObservation, isShellActivity, shellActivityStats } from './activityClassification';
import type { FlowGroupBase, FlowGroupCategory, FlowGroupDataByCategory } from './types';

type Translate = Parameters<typeof buildContextLoadSummary>[1];
type Summary = ReturnType<typeof buildContextLoadSummary>;

function toolItems(items: readonly FlowItem[]): FlowToolItem[] {
  return items.filter((item): item is FlowToolItem => item.type === 'tool');
}

function shellItems(items: readonly FlowItem[]): FlowToolItem[] {
  return toolItems(items).filter(isShellActivity);
}

function shellSummaryParts(items: readonly FlowItem[], t: Translate, formatNumber: (count: number) => string): string[] {
  const { commands, interactions, controls, running, failed, stopped } = shellActivityStats(shellItems(items));
  return [
    commands > 0 && t('shellGroup.commands', { count: formatNumber(commands) }),
    interactions > 0 && t('shellGroup.interactions', { count: formatNumber(interactions) }),
    controls > 0 && t('shellGroup.controls', { count: formatNumber(controls) }),
    running > 0 && t('shellGroup.running', { count: formatNumber(running) }),
    failed > 0 && t('shellGroup.failed', { count: formatNumber(failed) }),
    stopped > 0 && t('shellGroup.stopped', { count: formatNumber(stopped) }),
  ].filter((part): part is string => typeof part === 'string');
}

function withShellAttention(summary: string, stats: ReturnType<typeof shellActivityStats>, t: Translate, formatNumber: (count: number) => string): string {
  const attention = [
    stats.failed > 0 && t('shellGroup.failed', { count: formatNumber(stats.failed) }),
    stats.stopped > 0 && t('shellGroup.stopped', { count: formatNumber(stats.stopped) }),
  ].filter(Boolean);
  return [summary, ...attention].join(' · ');
}

/** One work collection, including runs that contain only exploration or only execution. */
function summarizeWork(items: readonly FlowItem[], t: Translate, formatNumber: (count: number) => string): Summary {
  const { readCount, searchCount } = computeExploreStats(items);
  const parts = [
    readCount > 0 && `${t('exploreRegion.readLabel')} ${formatNumber(readCount)}`,
    searchCount > 0 && `${t('exploreRegion.searchLabel')} ${formatNumber(searchCount)}`,
    ...shellSummaryParts(items, t, formatNumber),
  ].filter((part): part is string => typeof part === 'string');
  const shell = shellActivityStats(shellItems(items));
  const summary = t('workspaceGroup.summary', { count: formatNumber(toolItems(items).length) });
  return { summary: withShellAttention(summary, shell, t, formatNumber), summaryDescription: t('workspaceGroup.description', { summary: parts.join(' · ') }) };
}

/** Read/search and Shell calls share one run when they are adjacent. */
export function joinedFlowGroupCategory(current: FlowGroupCategory | undefined, next: FlowGroupCategory): FlowGroupCategory | undefined {
  if (current === undefined || current === next) return next;
  return undefined;
}

export interface FlowGroupPolicy<K extends FlowGroupCategory> {
  minimumItems: number;
  matches: (item: FlowToolItem, exploreEligibility: (toolName: string) => boolean) => boolean;
  create: (base: FlowGroupBase) => FlowGroupDataByCategory[K];
  component: string;
  summarize: (items: readonly FlowItem[], t: Translate, formatNumber: (count: number) => string) => Summary;
  attributes: (items: readonly FlowItem[]) => Record<`data-${string}`, string>;
}

/** Ordered, explicit product policies. Card density never implies membership. */
export const flowGroupPolicies = {
  context: {
    minimumItems: 2,
    matches: item => !awaitsApproval(item)
      && (item.status === 'completed' ? isSettledContextLoad(item)
        : !['error', 'cancelled', 'rejected'].includes(item.status) && getContextLoadKind(item) !== undefined),
    create: base => ({ ...base, category: 'context' }),
    component: 'context-load-group',
    attributes: () => ({ 'data-group-kind': 'context' }),
    summarize: (items, t, formatNumber) => buildContextLoadSummary(items.filter(item => item.type === 'tool').length, t, formatNumber),
  },
  explore: {
    minimumItems: 1,
    matches: (item, eligible) => isShellActivity(item) || (!['error', 'cancelled', 'rejected'].includes(item.status)
      && !awaitsApproval(item)
      && item.toolResult?.success !== false && eligible(getEffectiveToolName(item))),
    create: base => ({ ...base, category: 'explore', stats: computeExploreStats(base.allItems) }),
    component: 'explore-group',
    attributes: items => {
      const stats = computeExploreStats(items);
      const shell = shellActivityStats(shellItems(items));
      const kinds = [stats.readCount > 0 ? 'read' : null, stats.searchCount > 0 ? 'search' : null,
        stats.commandCount > 0 || shell.interactions > 0 || shell.controls > 0 ? 'command' : null].filter(Boolean);
      return { 'data-group-kind': kinds.length === 1 ? kinds[0]! : kinds.length > 1 ? 'mixed' : 'other',
        'data-read-count': String(stats.readCount), 'data-search-count': String(stats.searchCount),
        'data-command-count': String(stats.commandCount),
        ...(shell.commands + shell.interactions + shell.controls > 0 ? {
          'data-group-status': shell.failed > 0 ? 'failed' : shell.running > 0 ? 'running'
            : shell.stopped > 0 ? 'stopped' : shell.nonZero > 0 ? 'non-zero' : 'completed',
        } : {}) };
    },
    summarize: summarizeWork,
  },
  interface: {
    minimumItems: 2,
    matches: isInterfaceObservation,
    create: base => ({ ...base, category: 'interface' }),
    component: 'interface-observation-group',
    attributes: () => ({ 'data-group-kind': 'interface' }),
    summarize: (items, t, formatNumber) => {
      const count = formatNumber(toolItems(items).length);
      return { summary: t('interfaceGroup.summary', { count }), summaryDescription: t('interfaceGroup.description', { count }) };
    },
  },
} satisfies { [K in FlowGroupCategory]: FlowGroupPolicy<K> };

export interface FlowGroupPolicyOptions {
  exploreEligibility?: (toolName: string) => boolean;
}

export function classifyFlowGroupItem(item: FlowItem, {
  exploreEligibility = isCollapsibleTool,
}: FlowGroupPolicyOptions = {}): FlowGroupCategory | undefined {
  if (item.type !== 'tool') return undefined;
  if (hasPendingFlowGroupClassification(item)) return undefined;
  return (Object.keys(flowGroupPolicies) as FlowGroupCategory[])
    .find(category => flowGroupPolicies[category].matches(item as FlowToolItem, exploreEligibility));
}

/** Partial action/target strings cannot prove either membership or a hard boundary. */
export function hasPendingFlowGroupClassification(item: FlowItem): boolean {
  if (item.type !== 'tool') return false;
  const tool = item as FlowToolItem;
  if (!tool.isParamsStreaming || awaitsApproval(tool)
    || ['completed', 'error', 'cancelled', 'rejected'].includes(item.status)) return false;
  return tool.toolName === DEFERRED_TOOL_GATEWAY_NAME
    || ['OpenBitFunControl', 'ControlHub', 'ComputerUse'].includes(getEffectiveToolName(tool));
}

export function meetsFlowGroupThreshold(category: FlowGroupCategory, items: readonly FlowItem[]): boolean {
  // Reasoning and prose accompany calls, but never count as collected operations.
  return toolItems(items).length >= flowGroupPolicies[category].minimumItems;
}
