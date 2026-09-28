import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import en from '@/locales/en-US/flow-chat.json';
import shared from '../../../../shared/i18n/resources/shared/en-US/terms.json';
import { isCollapsibleItem, isCollapsibleTool, isToolCapsule } from './toolCardMetadata';
import { getToolCapsuleSummary, toolCapsuleStateKey } from './toolCapsuleModel';
import type { FlowToolItem } from '../types/flow-chat';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: en, shared } } });
const tool = (toolName: string, input: unknown = {}): FlowToolItem => ({
  id: 'call', type: 'tool', toolName, status: 'completed', timestamp: 1,
  toolCall: { id: 'call', input },
});

describe('capsule and exploration policy', () => {
  it.each(['Write', 'Edit', 'Delete', 'GetFileDiff', 'ExecCommand', 'ExecControl', 'Bash', 'RunCode', 'Task', 'AgentSpawn', 'AgentSendInput', 'TodoWrite', 'AskUserQuestion', 'CreatePlan', 'ReviewSessionSummary', 'ReadCanvas', 'SessionControl', 'Cron', 'unknown', 'mcp__files__delete'])('%s preserves its card outside read-only exploration eligibility', name => {
    expect(isToolCapsule(name)).toBe(false);
    expect(isCollapsibleTool(name)).toBe(false);
  });
  it.each(['Skill', 'GetToolSpec'])('%s keeps its native card outside exploration', name => {
    expect(isToolCapsule(name)).toBe(false);
    expect(isCollapsibleTool(name)).toBe(false);
  });
  it('preserves the subagent wait card outside exploration', () => {
    expect(isToolCapsule('AgentWait')).toBe(false);
    expect(isCollapsibleTool('AgentWait')).toBe(false);
  });
  it.each(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'view_image'])('%s keeps its native card while successful settled calls still fold', name => {
    expect(isToolCapsule(name)).toBe(false);
    expect(isCollapsibleItem(tool(name))).toBe(true);
    for (const status of ['running', 'queued', 'error', 'cancelled', 'rejected', 'pending_confirmation'] as const) {
      expect(isCollapsibleItem({ ...tool(name), status })).toBe(false);
    }
    expect(isCollapsibleItem({ ...tool(name), toolResult: { success: false, result: null } })).toBe(false);
  });
});

describe('capsule summaries', () => {
  it('distinguishes a known empty result from an unknown result count', () => {
    expect(getToolCapsuleSummary(tool('Grep', { pattern: 'a' }), i18n.t).resultCount).toBeUndefined();
    expect(getToolCapsuleSummary({ ...tool('Grep', { pattern: 'a' }), toolResult: { success: true, result: { total_matches: 0 } } }, i18n.t).resultCount).toBe(0);
  });
  it('shows a filename while retaining the full Windows path in the accessible description', () => {
    const summary = getToolCapsuleSummary(tool('Read', { file_path: 'C:\\work\\src\\index.ts' }), i18n.t);
    expect(summary.label).toBe('index.ts');
    expect(summary.description).toContain('C:\\work\\src\\index.ts');
    expect(summary.description).toContain('Read file');
  });
  it('projects deferred identity and legacy arguments', () => {
    const summary = getToolCapsuleSummary(tool('CallDeferredTool', { tool_name: 'Skill', args: { command: 'design' } }), i18n.t);
    expect(summary.label).toBe('design');
    expect(summary.description).toContain('Skill');
  });
  it('keeps the attempted target and error instead of replacing the icon meaning with failure', () => {
    const summary = getToolCapsuleSummary({ ...tool('Grep', { pattern: 'handler', path: '/work/src' }), status: 'error', toolResult: { success: false, result: null, error: 'Access denied' } }, i18n.t);
    expect(summary.label).toBe('handler');
    expect(summary.description).toContain('/work/src');
    expect(summary.description).toContain('Access denied');
    expect(summary.statusLabel).toBe('Failed');
  });
  it('does not turn a wait deadline into completion of all background agents', () => {
    const summary = getToolCapsuleSummary({ ...tool('AgentWait'), toolResult: { success: true, result: { status: 'timed_out', pending_bg_task_ids: ['a', 'b'] } } }, i18n.t);
    expect(summary.label).toBe('2 still running');
  });
  it('separates the same tool id in different sessions and turns', () => {
    expect(toolCapsuleStateKey('a', 'turn', 'call')).not.toBe(toolCapsuleStateKey('b', 'turn', 'call'));
    expect(toolCapsuleStateKey('a', 'turn', 'call')).not.toBe(toolCapsuleStateKey('a', 'another', 'call'));
  });
});
