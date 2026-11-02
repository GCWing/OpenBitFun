import { getToolCardStatus } from './toolCardStatus';
import type { FlowToolItem } from '../types/flow-chat';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';

function text(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? '';
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

/** Identity comes from the effective tool; model rounds and timing imply no concurrency. */
export function getToolCapsuleSummary(item: FlowToolItem, t: (key: string, options?: Record<string, unknown>) => string) {
  const effective = projectEffectiveToolItem(item);
  const status = getToolCardStatus(effective);
  const input = effective.toolCall.input ?? {};
  const result = effective.toolResult?.result ?? {};
  let kind = effective.toolName;
  let target = '';
  let label = '';
  let resultCount: number | undefined;
  switch (effective.toolName) {
    case 'Read':
      kind = t('toolCards.readFile.readFile');
      target = text(input.file_path, input.target_file, input.path);
      label = basename(target);
      break;
    case 'LS':
      kind = t('toolCards.ls.listDirectory');
      target = text(input.path, input.directory, '.');
      label = basename(target);
      resultCount = Array.isArray(result.entries) ? result.entries.length : undefined;
      break;
    case 'Grep':
      kind = t('toolCards.grepSearch.searchText');
      label = text(input.pattern, input.query);
      target = [label, text(input.path)].filter(Boolean).join(' · ');
      resultCount = typeof result.total_matches === 'number' && Number.isFinite(result.total_matches) && result.total_matches >= 0 ? result.total_matches : undefined;
      break;
    case 'Glob':
      kind = t('toolCards.globSearch.searchFile');
      label = text(input.glob_pattern, input.pattern);
      target = [label, text(input.path, input.target_directory)].filter(Boolean).join(' · ');
      resultCount = [result, result.files, result.matches].find(Array.isArray)?.length;
      break;
    case 'WebSearch':
      kind = t('toolCards.webSearch.action');
      target = label = text(input.search_term, input.query);
      resultCount = Array.isArray(result.results) ? result.results.length : undefined;
      break;
    case 'WebFetch': {
      kind = t('toolCapsule.webpage');
      target = text(input.url, result.url);
      let host = target;
      try { host = new URL(target).hostname; } catch { /* Incomplete streaming URL. */ }
      label = text(result.title, host);
      break;
    }
    case 'view_image':
      kind = t('toolCapsule.image');
      target = text(input.path, result.path);
      label = basename(target);
      break;
    case 'Skill':
      kind = t('toolCapsule.skill');
      target = label = text(result.skill_name, result.name, input.command, input.skill_name);
      break;
    case 'GetToolSpec':
      kind = t('toolCards.getToolSpec.title');
      target = label = text(result.tool_name, input.tool_name);
      break;
    case 'AgentWait':
      kind = t('toolCapsule.agents');
      label = status === 'error'
        ? t('toolCards.agentWait.failed')
        : effective.status === 'cancelled' ? t('toolCards.default.cancelled')
          : effective.status === 'rejected' ? t('toolCards.default.rejected')
            : result.status === 'timed_out' && Array.isArray(result.pending_bg_task_ids)
              ? t('toolCapsule.agentsPending', { count: result.pending_bg_task_ids.length })
              : result.status === 'steered' ? t('toolCards.agentWait.steered')
                : effective.status === 'completed' ? Array.isArray(result.results)
                  ? t('toolCards.agentWait.completed', { count: result.results.length })
                  : t('toolCards.agentWait.completedUnknown')
                  : t('toolCards.agentWait.title');
      target = label;
      break;
  }

  let statusLabel: string;
  switch (status) {
    case 'completed': case 'confirmed': statusLabel = t('toolCards.default.completed'); break;
    case 'error': statusLabel = t('toolCapsule.failed'); break;
    case 'cancelled': statusLabel = t('toolCards.default.cancelled'); break;
    case 'rejected': statusLabel = t('toolCards.default.rejected'); break;
    case 'pending_confirmation': statusLabel = t('toolCards.default.waitingConfirm'); break;
    case 'queued': statusLabel = t('toolCards.default.queued'); break;
    case 'waiting': statusLabel = t('toolCards.default.waiting'); break;
    case 'pending': case 'preparing': statusLabel = t('toolCards.default.preparing'); break;
    default: statusLabel = t('toolCards.default.executing');
  }
  return {
    label: label || kind,
    description: [kind, target, statusLabel, effective.toolResult?.error].filter(Boolean).join(' · '),
    statusLabel,
    resultCount: effective.status === 'completed' && effective.toolResult?.success !== false ? resultCount : undefined,
  };
}

/** Scoped to the recorded item so virtualization and cross-round folding retain selection. */
export function toolCapsuleStateKey(sessionId: string | undefined, turnId: string | undefined, itemId: string): string {
  return JSON.stringify([sessionId ?? '', turnId ?? '', itemId]);
}
