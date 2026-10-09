import { describe, expect, it } from 'vitest';
import type { GroupableTool } from './toolGroups';
import {
  createUserToolGroupsConfig,
  normalizeUserToolGroupsConfig,
  resolveToolGroupSummary,
  resolveToolGroups,
  setToolGroupSelection,
} from './toolGroups';

const t = (key: string, options?: Record<string, unknown>) => (
  options?.provider ? `${key}:${options.provider}` : key
);

const tools: GroupableTool[] = [
  { name: 'LS', description: 'List files', is_readonly: true },
  { name: 'Read', description: 'Read files', is_readonly: true },
  { name: 'Glob', description: 'Find files', is_readonly: true },
  { name: 'Edit', description: 'Edit files', is_readonly: false },
  { name: 'Write', description: 'Write files', is_readonly: false },
  { name: 'AgentSpawn', description: 'Launch an agent', is_readonly: false },
  { name: 'AgentSendInput', description: 'Send input to an agent', is_readonly: false },
  { name: 'AgentControl', description: 'Control an agent', is_readonly: false },
  { name: 'ListModels', description: 'List enabled OpenBitFun models', is_readonly: true },
  { name: 'AgentWait', description: 'Wait for background agent results', is_readonly: true },
  { name: 'Skill', description: 'Load a skill', is_readonly: true },
  { name: 'analyze_image', description: 'Analyze an image', is_readonly: true },
  { name: 'view_image', description: 'View an image', is_readonly: true },
  { name: 'AskUserQuestion', description: 'Ask the user a question', is_readonly: true },
  { name: 'GenerativeUI', description: 'Generate an interface', is_readonly: false },
  { name: 'PatchCanvas', description: 'Patch a canvas', is_readonly: false },
  { name: 'ReadCanvas', description: 'Read a canvas', is_readonly: true },
  { name: 'UpdateCanvas', description: 'Update a canvas', is_readonly: false },
  { name: 'ComputerUse', description: 'Control a computer', is_readonly: false },
  { name: 'ControlHub', description: 'Use a control hub', is_readonly: false },
  { name: 'Playbook', description: 'Run a playbook', is_readonly: false },
  {
    name: 'github_search',
    description: 'Search GitHub',
    is_readonly: true,
    dynamic_info: { providerId: 'github', providerKind: 'mcp' },
  },
];

describe('tool groups', () => {
  it('keeps Read in files and search instead of file editing', () => {
    const groups = resolveToolGroups(tools, [], t as never);
    const files = groups.find((group) => group.id === 'builtin:files-search');
    const editing = groups.find((group) => group.id === 'builtin:file-editing');

    expect(files?.tools.map((tool) => tool.name)).toContain('Read');
    expect(editing?.tools.map((tool) => tool.name)).not.toContain('Read');
  });

  it('groups ListModels with delegation and skills', () => {
    const groups = resolveToolGroups(tools, [], t as never);

    expect(groups.find((group) => group.id === 'builtin:delegation')?.tools.map((tool) => tool.name))
      .toEqual(['AgentControl', 'AgentSendInput', 'AgentSpawn', 'AgentWait', 'ListModels', 'Skill']);
  });

  it('groups image, canvas, and computer automation tools by their user-facing purpose', () => {
    const groups = resolveToolGroups(tools, [], t as never);

    expect(groups.find((group) => group.id === 'builtin:image-understanding')?.tools.map((tool) => tool.name))
      .toEqual(['analyze_image', 'view_image']);
    expect(groups.find((group) => group.id === 'builtin:interaction-canvas')?.tools.map((tool) => tool.name))
      .toEqual([
        'AskUserQuestion',
        'GenerativeUI',
        'PatchCanvas',
        'ReadCanvas',
        'UpdateCanvas',
      ]);
    expect(groups.find((group) => group.id === 'builtin:computer-automation')?.tools.map((tool) => tool.name))
      .toEqual(['ComputerUse', 'ControlHub', 'Playbook']);
  });

  it('places personal groups before built-ins and clears the final selected tool set by group members', () => {
    const groups = resolveToolGroups(tools, [{
      id: 'daily-code',
      name: 'Daily code',
      toolNames: ['Read', 'Edit'],
    }], t as never);
    const custom = groups.find((group) => group.id === 'user:daily-code');

    expect(groups[0]?.id).toBe('user:daily-code');
    expect(custom?.tools.map((tool) => tool.name)).toEqual(['Edit', 'Read']);
    expect(setToolGroupSelection(['Read', 'Edit'], ['Read'], false)).toEqual(['Edit']);
  });

  it('projects dynamic tools into their provider group and uses user groups first in summaries', () => {
    const userGroups = [{
      id: 'github-work',
      name: 'GitHub work',
      toolNames: ['github_search', 'Read'],
    }];
    const groups = resolveToolGroups(tools, userGroups, t as never);
    const summary = resolveToolGroupSummary(tools, userGroups, ['Read', 'github_search'], t as never);

    expect(groups.find((group) => group.id === 'extension:github')).toBeTruthy();
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ id: 'user:github-work', label: 'GitHub work' });
  });

  it('keeps unavailable user tools while normalizing persisted names', () => {
    const config = normalizeUserToolGroupsConfig({
      version: 1,
      groups: [{
        id: 'custom',
        name: 'Custom',
        toolNames: ['Read', 'missing-tool', 'Read', ''],
      }],
    });

    expect(config.groups[0].toolNames).toEqual(['Read', 'missing-tool']);
    expect(createUserToolGroupsConfig(config.groups)).toEqual(config);
  });
});
