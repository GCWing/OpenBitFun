import type { FlowToolItem } from '../types/flow-chat';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';

const shellTools = new Set(['ExecCommand', 'WriteStdin', 'ExecControl', 'Bash']);

export function isShellToolName(toolName: string): boolean {
  return shellTools.has(toolName);
}

// These actions only inspect or navigate an interface. Opening a surface for the
// reader, typing, clicking, changing settings and publishing stay native cards.
const browserObservations = new Set([
  'snapshot', 'get', 'get_text', 'get_url', 'get_title', 'get_html',
  'list_pages', 'tab_query', 'list_sessions', 'hover', 'scroll', 'auto_scroll',
]);
const desktopObservations = new Set([
  'list_apps', 'get_app_state', 'get_app_shortcuts', 'list_displays',
  'describe_screen', 'locate', 'mouse_move', 'pointer_move_rel',
  'move_to_target', 'move_to_text', 'scroll',
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function awaitsApproval(item: FlowToolItem): boolean {
  if (item.status === 'pending_confirmation') return true;
  const settled = ['completed', 'error', 'cancelled', 'rejected'].includes(item.status);
  return !settled && item.userConfirmed !== true
    && (item.requiresConfirmation === true || item.acpPermission !== undefined);
}

/** A Shell run is an adjacent transcript segment, not a process/session id. */
export function isShellActivity(item: FlowToolItem): boolean {
  const effective = projectEffectiveToolItem(item);
  return isShellToolName(effective.toolName)
    && item.status !== 'rejected' && !awaitsApproval(item);
}

/** Fold only known low-level observations; unknown or consequential actions stay visible. */
export function isInterfaceObservation(item: FlowToolItem): boolean {
  if (['error', 'cancelled', 'rejected'].includes(item.status) || item.isParamsStreaming
    || (item.status === 'completed' && item.toolResult?.success !== true)
    || awaitsApproval(item)) return false;
  const effective = projectEffectiveToolItem(item);
  const input = record(effective.toolCall?.input);
  const result = record(effective.toolResult?.result);
  if (result.ok === false || result.success === false || record(result.loop_warning).detected === true) return false;
  if (effective.toolName === 'ControlHub') {
    return (item.status !== 'completed' || result.ok === true) && input.domain === 'browser' && typeof input.action === 'string'
      && browserObservations.has(input.action);
  }
  return effective.toolName === 'ComputerUse' && typeof input.action === 'string'
    && desktopObservations.has(input.action);
}

export interface ShellActivityStats {
  commands: number;
  interactions: number;
  controls: number;
  running: number;
  failed: number;
  stopped: number;
  nonZero: number;
}

function shellResult(item: FlowToolItem): Record<string, unknown> {
  const raw = item.toolResult?.result;
  if (typeof raw === 'string') {
    try { return record(JSON.parse(raw)); } catch { return {}; }
  }
  return record(raw);
}

export function shellActivityStats(items: readonly FlowToolItem[]): ShellActivityStats {
  const stats = { commands: 0, interactions: 0, controls: 0, running: 0, failed: 0, stopped: 0, nonZero: 0 };
  for (const item of items) {
    const name = projectEffectiveToolItem(item).toolName;
    const result = shellResult(item);
    const completion = record(result.completion);
    const failed = item.status === 'error' || item.toolResult?.success === false || result.status === 'session_not_found';
    const stopped = item.status === 'cancelled'
      || ['interrupted', 'killed', 'pruned'].includes(String(completion.status ?? ''));
    if (name === 'ExecCommand' || name === 'Bash') stats.commands++;
    else if (name === 'ExecControl') stats.controls++;
    else stats.interactions++;
    if (failed) stats.failed++;
    else if (stopped) stats.stopped++;
    else if (!['completed', 'rejected'].includes(item.status)) stats.running++;
    if (!failed && typeof result.exit_code === 'number' && result.exit_code !== 0) stats.nonZero++;
  }
  return stats;
}
