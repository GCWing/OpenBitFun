import { describe, expect, it } from 'vitest';
import type { FlowToolItem } from '../types/flow-chat';
import { importedToolCardName, importedToolOutput } from './importedToolPresentation';
import { getEffectiveToolName, projectEffectiveToolItem } from './toolInvocationIdentity';
import { isToolCardVisible } from './flowItemVisibility';
import { isShellActivity, shellActivityStats } from '../grouping/activityClassification';
import { fileEditTarget } from '../grouping/fileEdits';
import { getToolItemCardConfig } from '../tool-cards/toolCardMetadata';

function item(toolName: string, input: unknown, result: unknown, importedSource: FlowToolItem['importedSource'] = 'codex'): FlowToolItem {
  return {
    id: 'call', type: 'tool', toolName, importedSource, status: 'completed', timestamp: 1,
    toolCall: { id: 'call', input }, toolResult: { success: true, result },
  };
}

describe('imported tool projection to native cards', () => {
  it.each([
    ['exec', 'RunCode'], ['functions.exec', 'RunCode'], ['exec_command', 'ExecCommand'],
    ['functions.shell_command', 'ExecCommand'], ['shell', 'ExecCommand'], ['write_stdin', 'WriteStdin'],
    ['Read', 'Read'], ['Write', 'Write'], ['Edit', 'Edit'], ['Grep', 'Grep'], ['Glob', 'Glob'],
    ['LS', 'LS'], ['WebSearch', 'WebSearch'], ['WebFetch', 'WebFetch'], ['view_image', 'view_image'],
    ['update_plan', 'TodoWrite'],
  ])('matches Codex %s to the native %s contract', (name, native) => {
    expect(importedToolCardName(item(name, {}, null))).toBe(native);
  });

  it.each(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite'])('matches the Zcode %s contract', name => {
    expect(importedToolCardName(item(name, {}, null, 'zcode'))).toBe(name === 'Bash' ? 'ExecCommand' : name);
  });

  it('projects freeform code and every result block without rewriting the stored record', () => {
    const tool = item('exec', 'const x = await tools.exec_command({cmd: "pwd"});\ntext(x);', [
      { type: 'input_text', text: 'Script completed\nWall time: 1.2 seconds\nOutput:\n/workspace' },
      { type: 'input_text', text: 'second output' },
      { type: 'resource', uri: 'source://output' },
    ]);
    const original = JSON.stringify(tool);
    const projected = projectEffectiveToolItem(tool);
    expect(projected).toMatchObject({ toolName: 'RunCode', toolCall: { input: { code: tool.toolCall.input, language: 'javascript' } } });
    expect(projected.toolResult?.result.output).toContain('second output');
    expect(projected.toolResult?.result.output).toContain('source://output');
    expect(projected.toolResult?.result.output).not.toContain('Script completed');
    expect(projectEffectiveToolItem(tool)).toBe(projected);
    expect(projectEffectiveToolItem(projected)).toBe(projected);
    expect(JSON.stringify(tool)).toBe(original);
    expect(projectEffectiveToolItem({ ...tool, toolCall: { ...tool.toolCall, input: 'text(2)' } }).toolCall.input.code).toBe('text(2)');
  });

  it.each(['clock.sleep', 'functions.wait', 'apply_patch', 'mcp__example__exec', '__proto__', 'constructor', 'CallDeferredTool', 'AskUserQuestion'])('uses a generic card for unmatched %s instead of a superficially similar workflow', name => {
    expect(importedToolCardName(item(name, { tool_name: 'Write', args: {} }, null))).toBeUndefined();
    expect(getToolItemCardConfig(item(name, {}, null))).toMatchObject({ toolName: name, requiresConfirmation: false, presentation: 'standard' });
  });

  it('does not change native tools or unwrap a foreign deferred gateway', () => {
    const native = { ...item('exec', 'text(1)', null), importedSource: undefined };
    expect(getEffectiveToolName(native)).toBe('exec');
    expect(projectEffectiveToolItem(native)).toBe(native);
    expect(getEffectiveToolName(item('CallDeferredTool', { tool_name: 'Write', args: {} }, null))).toBe('CallDeferredTool');
  });

  it('uses native shell summaries, including recorded failure and elapsed time', () => {
    const tool = item('functions.exec_command', { cmd: 'cargo check', workdir: '/remote/project' },
      'Chunk ID: test\nWall time: 0.42 seconds\nProcess exited with code 1\nFinal output:\ncompile failed');
    expect(projectEffectiveToolItem(tool)).toMatchObject({
      toolName: 'ExecCommand', status: 'error',
      toolResult: { success: false, result: { exit_code: 1, wall_time_seconds: 0.42, output: 'compile failed' } },
    });
    expect(isShellActivity(tool)).toBe(true);
    expect(shellActivityStats([tool])).toMatchObject({ commands: 1, failed: 1, running: 0 });
  });

  it('adapts Zcode Bash and legacy JSON arguments without inventing process metadata', () => {
    const bash = projectEffectiveToolItem(item('Bash', { command: 'git status', description: 'Check changes' }, 'working tree clean', 'zcode'));
    expect(bash.toolCall.input).toMatchObject({ cmd: 'git status', description: 'Check changes' });
    expect(bash.toolResult?.result).toEqual({ output: 'working tree clean', exit_code: undefined, wall_time_seconds: undefined });
    const shell = projectEffectiveToolItem(item('shell_command', '{"command":"pwd"}', JSON.stringify({ output: '/remote', exit_code: 0, wall_time_seconds: 0.2 })));
    expect(shell.toolCall.input.cmd).toBe('pwd');
    expect(shell.toolResult?.result).toMatchObject({ output: '/remote', exit_code: 0, wall_time_seconds: 0.2 });
    const poll = item('write_stdin', { session_id: 19, chars: '' }, { output: 'done', exit_code: 0 });
    expect(getToolItemCardConfig(poll).presentation).toBe('relation');
    expect(shellActivityStats([poll])).toMatchObject({ commands: 0, interactions: 1 });
  });

  it('honors failed script envelopes without guessing from arbitrary output or file contents', () => {
    expect(projectEffectiveToolItem(item('exec', 'bad()', [
      { type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\nReferenceError' },
    ])).status).toBe('error');
    expect(projectEffectiveToolItem(item('exec', 'store(x)', [
      { type: 'input_text', text: 'Script error:\nOnly plain serializable objects can be stored.' },
    ])).status).toBe('error');
    expect(projectEffectiveToolItem(item('exec', 'text(sample)', 'A sample says:\nScript failed\nOutput:\nexample')).status).toBe('completed');
    expect(projectEffectiveToolItem(item('exec', 'text(sample)', 'Script completed\nWall time: 1 seconds\nOutput:\nScript failed')).status).toBe('completed');
    expect(projectEffectiveToolItem(item('exec', 'text(sample)', 'Script completed\nWall time: 1 seconds\nOutput:\nScript error:\nexample')).status).toBe('completed');
    expect(projectEffectiveToolItem(item('Read', { file_path: '/remote/result.json' },
      '{"exit_code":1,"wall_time_seconds":2,"is_error":true}', 'zcode')).status).toBe('completed');
  });

  it('retains empty replacements and remote paths without entering native snapshot groups', () => {
    const edit = item('Edit', { file_path: '/remote/src/a.ts', old_string: 'remove me', new_string: '' }, 'File updated', 'zcode');
    expect(projectEffectiveToolItem(edit).toolCall.input).toEqual(edit.toolCall.input);
    expect(fileEditTarget(edit)).toBeUndefined();
    expect(getToolItemCardConfig(edit)).toMatchObject({ attention: 'prominent', presentation: 'standard', requiresConfirmation: false });
    expect(fileEditTarget({ ...edit, importedSource: undefined })).toBeDefined();
  });

  it('maps web searches and todo plans only when their operation is equivalent', () => {
    const search = item('web.run', { search_query: [{ q: 'Rust ownership' }] }, 'results');
    expect(importedToolCardName(search)).toBe('WebSearch');
    expect(projectEffectiveToolItem(search)).toMatchObject({ toolCall: { input: { query: 'Rust ownership' } }, toolResult: { result: { content: 'results' } } });
    expect(importedToolCardName(item('web.run', { finance: [{ ticker: 'BTC' }] }, 'quote'))).toBeUndefined();
    expect(importedToolCardName(item('web.run', { search_query: [{ q: 'Rust' }], open: [{ ref_id: 'url' }] }, 'mixed'))).toBeUndefined();
    const todos = [{ content: 'Check code', status: 'in_progress' }];
    expect(projectEffectiveToolItem(item('update_plan', { plan: [{ step: 'Check code', status: 'in_progress' }] }, 'Plan updated')).toolResult?.result.todos).toEqual(todos);
    expect(projectEffectiveToolItem(item('TodoWrite', { todos }, 'Done', 'zcode')).toolResult?.result.todos).toEqual(todos);
  });

  it.each(['Read', 'WebSearch', 'WebFetch'])('keeps imported %s failures visible', toolName => {
    const tool = { ...item(toolName, {}, 'partial result', 'zcode'), status: 'error' as const };
    expect(isToolCardVisible(projectEffectiveToolItem(tool))).toBe(true);
    expect(isToolCardVisible({ ...tool, importedSource: undefined })).toBe(false);
  });

  it('keeps raw generic fields and text output available, with no source approval', () => {
    const tool = { ...item('unknown', { _source: 'value' }, [{ type: 'text', text: 'A' }, { type: 'output_text', text: 'B' }]), requiresConfirmation: true };
    expect(projectEffectiveToolItem(tool)).toMatchObject({ requiresConfirmation: false, toolCall: { input: { _source: 'value' } }, toolResult: { result: 'A\n\nB' } });
    expect(importedToolOutput({ future_shape: [1, false] })).toContain('future_shape');
  });
});
