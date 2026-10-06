// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  DEDICATED_TOOL_CARD_NAMES,
  getToolCardComponent,
  isCollapsibleTool,
  PRODUCT_OWNED_TOOL_CARD_COMPONENTS,
  STANDARD_TOOL_CARD_ADAPTERS,
  TOOL_CARD_COMPONENTS,
  usesDefaultToolCard,
} from './index';
import { TaskToolDisplay } from './TaskToolDisplay';
import { AgentControlToolCard } from './AgentControlToolCard';
import { AgentInteractionToolCard } from './AgentInteractionToolCard';
import { OpenBitFunControlToolCard } from './OpenBitFunControlToolCard';

// These cards remain available for rendering historical or explicitly
// configured tool calls, but are no longer part of the current presentation
// registry: AgentControl replaced the AgentInterrupt/AgentDelete tools, and
// Task remains only as a compatibility tool.
const COMPATIBILITY_ONLY_TOOL_CARD_NAMES = new Set([
  'AgentInterrupt',
  'AgentDelete',
  'Task',
]);

describe('tool card registry', () => {
  it('keeps OpenBitFun controls visible through their dedicated product card', () => {
    expect(getToolCardComponent('OpenBitFunControl')).toBe(OpenBitFunControlToolCard);
    expect(usesDefaultToolCard('OpenBitFunControl')).toBe(false);
    expect(isCollapsibleTool('OpenBitFunControl')).toBe(false);
  });
  it('projects managed Review workers through the unified coverage card', () => {
    expect(getToolCardComponent('LaunchReviewAgent')).toBe(TaskToolDisplay);
  });

  it('renders AgentSpawn and AgentSendInput with the shared agent control card', () => {
    expect(getToolCardComponent('AgentSpawn')).toBe(AgentControlToolCard);
    expect(getToolCardComponent('AgentSendInput')).toBe(AgentControlToolCard);
    expect(getToolCardComponent('AgentInterrupt')).toBe(AgentInteractionToolCard);
  });

  it('keeps current lightweight dedicated-card classification aligned with the component registry', () => {
    expect([...DEDICATED_TOOL_CARD_NAMES].sort()).toEqual(
      Object.keys(TOOL_CARD_COMPONENTS)
        .filter((toolName) => !COMPATIBILITY_ONLY_TOOL_CARD_NAMES.has(toolName))
        .sort(),
    );
  });

  it('keeps standard design-system adapters separate from bespoke product cards', () => {
    const standardNames = Object.keys(STANDARD_TOOL_CARD_ADAPTERS);
    const productOwnedNames = Object.keys(PRODUCT_OWNED_TOOL_CARD_COMPONENTS);

    expect(standardNames).toEqual([
      'Read',
      'Write',
      'Edit',
      'Delete',
      'Grep',
      'Glob',
      'LS',
      'WebSearch',
      'WebFetch',
      'ListModels',
      'ControlHub',
      'AgentSpawn',
      'AgentSendInput',
      'AgentInterrupt',
      'AgentWait',
      'TodoWrite',
      'ContextCompression',
      'GetToolSpec',
      'Skill',
      'ReviewSessionSummary',
      'GetFileDiff',
      'SessionControl',
      'SessionMessage',
      'Cron',
      'RunCode',
      'ExecCommand',
      'WriteStdin',
      'ExecControl',
      'PageDeploy',
      'PagePublish',
      'view_image',
      'get_goal',
      'create_goal',
      'update_goal',
      'AgentList',
      'AgentDelete',
      'SessionHistory',
      'analyze_image',
      'GetTime',
      'ListMCPResources',
      'ReadMCPResource',
      'ListMCPPrompts',
      'GetMCPPrompt',
      'Worktree',
      'PortForward',
      'ReviewPlatform',
      'FrontendWorkbench',
      'FinalizeMiniApp',
      'PublishMiniApp',
      'PublishAppearance',
      'Playbook',
    ]);
    expect(productOwnedNames).toEqual([
      'Task',
      'LaunchReviewAgent',
      'submit_code_review',
      'AskUserQuestion',
      'CreatePlan',
      'InitMiniApp',
      'GenerativeUI',
      'ComputerUse',
      'OpenBitFunControl',
      'CreateCanvas',
      'ReadCanvas',
      'UpdateCanvas',
      'PatchCanvas',
    ]);
    expect(standardNames.some((toolName) => productOwnedNames.includes(toolName))).toBe(false);
    expect([...standardNames, ...productOwnedNames].sort()).toEqual(
      Object.keys(TOOL_CARD_COMPONENTS).sort(),
    );
  });

  it.each(['Bash', 'TerminalControl', 'Git'])(
    'does not register a dedicated %s card after the legacy tool is removed',
    (toolName) => {
      expect(TOOL_CARD_COMPONENTS).not.toHaveProperty(toolName);
      expect(DEDICATED_TOOL_CARD_NAMES).not.toContain(toolName);
    },
  );

  it.each(['FinalizeMiniApp', 'PublishMiniApp', 'PublishAppearance'])(
    'keeps consequential %s dedicated cards outside exploration',
    (toolName) => {
      expect(usesDefaultToolCard(toolName)).toBe(false);
      expect(isCollapsibleTool(toolName)).toBe(false);
    },
  );

  it('does not classify MCP tools as default-card explore tools', () => {
    expect(usesDefaultToolCard('mcp__server__tool')).toBe(false);
    expect(isCollapsibleTool('mcp__server__tool')).toBe(false);
  });
});
