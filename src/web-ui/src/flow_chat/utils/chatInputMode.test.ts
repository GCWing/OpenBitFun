import { describe, expect, it } from 'vitest';

import {
  agentExecutionTier,
  canSwitchSessionMainAgent,
  hasCompleteThreadGoalTools,
  isChatInputActionVisibleForTarget,
  isPrimarySlashActionVisible,
  normalizeUserDefaultChatInputModeId,
  resolveAvailableChatInputMode,
  resolveChatInputCanUseSkills,
  resolveChatInputCanUseMcp,
  resolveChatInputSendAgentType,
  resolveChatInputModePolicy,
  resolveChatInputMainAgentModes,
  resolveSessionAssistantWorkspace,
  resolveWorkspaceChatInputMode,
} from './chatInputMode';
import { WorkspaceKind, type WorkspaceInfo, WorkspaceType } from '@/shared/types';

function createWorkspace(overrides: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: overrides.id ?? 'workspace-1',
    name: overrides.name ?? 'Workspace',
    rootPath: overrides.rootPath ?? 'D:/workspace/project',
    workspaceType: overrides.workspaceType ?? WorkspaceType.SingleProject,
    workspaceKind: overrides.workspaceKind ?? WorkspaceKind.Normal,
    languages: overrides.languages ?? [],
    openedAt: overrides.openedAt ?? new Date(0).toISOString(),
    lastAccessed: overrides.lastAccessed ?? new Date(0).toISOString(),
    tags: overrides.tags ?? [],
    ...overrides,
  };
}

describe('MCP picker availability', () => {
  it.each(['Minimal', 'minimal', ' MINIMAL '])('hides MCP in %s mode', targetAgentType => {
    expect(resolveChatInputCanUseMcp({ targetAgentType, isAcpTargetSession: false, isDispatchTransport: false })).toBe(false);
  });
  it.each(['Standard', 'Ultimate', 'Creative', 'agentic', 'DocsAgent'])('allows native %s discovery', targetAgentType => {
    expect(resolveChatInputCanUseMcp({ targetAgentType, isAcpTargetSession: false, isDispatchTransport: false })).toBe(true);
  });
  it('keeps ACP and detached dispatch discovery unavailable', () => {
    expect(resolveChatInputCanUseMcp({ targetAgentType: 'Standard', isAcpTargetSession: true, isDispatchTransport: false })).toBe(false);
    expect(resolveChatInputCanUseMcp({ targetAgentType: 'Standard', isAcpTargetSession: false, isDispatchTransport: true })).toBe(false);
  });
});

describe('normalizeUserDefaultChatInputModeId', () => {
  it('normalizes non-empty strings and rejects blank values', () => {
    expect(normalizeUserDefaultChatInputModeId(' PlannerPlus ')).toBe('PlannerPlus');
    expect(normalizeUserDefaultChatInputModeId(' ultra ')).toBe('Ultimate');
    expect(normalizeUserDefaultChatInputModeId('CREATIVE')).toBe('Creative');
    expect(normalizeUserDefaultChatInputModeId('   ')).toBeNull();
    expect(normalizeUserDefaultChatInputModeId(null)).toBeNull();
  });
});

describe('hasCompleteThreadGoalTools', () => {
  it('requires all three goal lifecycle tools', () => {
    expect(hasCompleteThreadGoalTools(['get_goal', 'create_goal', 'update_goal'])).toBe(true);
    expect(hasCompleteThreadGoalTools(['get_goal', 'create_goal'])).toBe(false);
    expect(hasCompleteThreadGoalTools(['GET_GOAL', 'Create_Goal', ' update_goal '])).toBe(true);
  });
});

describe('resolveWorkspaceChatInputMode', () => {
  it('forces Claw inside assistant workspaces', () => {
    expect(
      resolveWorkspaceChatInputMode({
        currentMode: 'Standard',
        isAssistantWorkspace: true,
        sessionMode: 'Standard',
      })
    ).toBe('Claw');
  });

  it('keeps non-Claw project modes unchanged', () => {
    expect(
      resolveWorkspaceChatInputMode({
        currentMode: 'Plan',
        isAssistantWorkspace: false,
        sessionMode: 'Plan',
      })
    ).toBeNull();
  });

  it('syncs when switching between project sessions with different modes', () => {
    expect(
      resolveWorkspaceChatInputMode({
        currentMode: 'Plan',
        isAssistantWorkspace: false,
        sessionMode: 'Standard',
      })
    ).toBe('Standard');
  });

  it('restores a project session mode after a transient assistant workspace state', () => {
    expect(
      resolveWorkspaceChatInputMode({
        currentMode: 'Claw',
        isAssistantWorkspace: false,
        sessionMode: 'Standard',
      })
    ).toBe('Standard');
  });

  it('restores Cowork when a project Cowork session inherited the Claw UI mode', () => {
    expect(
      resolveWorkspaceChatInputMode({
        currentMode: 'Claw',
        isAssistantWorkspace: false,
        sessionMode: 'Cowork',
      })
    ).toBe('Cowork');
  });

  it('falls back to agentic if a project session has no mode yet', () => {
    expect(
      resolveWorkspaceChatInputMode({
        currentMode: 'Claw',
        isAssistantWorkspace: false,
        sessionMode: undefined,
      })
    ).toBe('Standard');
  });

  it('keeps Claw sessions synchronized even before workspace state identifies the assistant workspace', () => {
    expect(
      resolveWorkspaceChatInputMode({
        currentMode: 'Standard',
        isAssistantWorkspace: false,
        sessionMode: 'Claw',
      })
    ).toBe('Claw');
  });
});

describe('resolveChatInputModePolicy', () => {
  it('allows mode switching for normal code sessions', () => {
    expect(
      resolveChatInputModePolicy({
        currentMode: 'Standard',
        isAssistantWorkspace: false,
        sessionMode: 'Standard',
      }),
    ).toEqual({
      canSwitchModes: true,
      fixedModeId: null,
      fixedReason: null,
    });
  });

  it('fixes assistant workspaces to Claw', () => {
    expect(
      resolveChatInputModePolicy({
        currentMode: 'Standard',
        isAssistantWorkspace: true,
        sessionMode: 'Standard',
      }),
    ).toEqual({
      canSwitchModes: false,
      fixedModeId: 'Claw',
      fixedReason: 'assistant-workspace',
    });
  });

  it('fixes Claw sessions even when workspace resolution is temporarily stale', () => {
    expect(
      resolveChatInputModePolicy({
        currentMode: 'Standard',
        isAssistantWorkspace: false,
        sessionMode: 'claw',
      }),
    ).toEqual({
      canSwitchModes: false,
      fixedModeId: 'Claw',
      fixedReason: 'session-mode',
    });
  });

  it('keeps Cowork selectable as a project main Agent', () => {
    expect(
      resolveChatInputModePolicy({
        currentMode: 'Cowork',
        isAssistantWorkspace: false,
        sessionMode: 'Standard',
      }),
    ).toEqual({
      canSwitchModes: true,
      fixedModeId: null,
      fixedReason: null,
    });

    expect(
      resolveChatInputModePolicy({
        currentMode: 'Standard',
        isAssistantWorkspace: false,
        sessionMode: 'cowork',
      }),
    ).toEqual({
      canSwitchModes: true,
      fixedModeId: null,
      fixedReason: null,
    });
  });

  it('fixes ACP sessions without treating them as a product mode', () => {
    expect(
      resolveChatInputModePolicy({
        currentMode: 'Standard',
        isAssistantWorkspace: false,
        sessionMode: 'acp:example',
        isAcpTargetSession: true,
      }),
    ).toEqual({
      canSwitchModes: false,
      fixedModeId: null,
      fixedReason: 'acp-session',
    });
  });
});

describe('ChatInput Agent projection', () => {
  it('puts specialized and custom main Agents under Other without duplicating Harness profiles', () => {
    expect(
      resolveChatInputMainAgentModes([
        { id: 'Standard' },
        { id: 'Cowork' },
        { id: 'Multitask' },
        { id: 'Plan' },
        { id: 'Claw' },
        { id: 'minimal' },
        { id: 'Ultimate' },
        { id: 'PlannerPlus' },
      ]),
    ).toEqual([
      { id: 'Cowork' },
      { id: 'PlannerPlus' },
    ]);
  });

});

describe('Agent execution tier locking', () => {
  it('classifies product tiers from Agent types', () => {
    expect(agentExecutionTier('minimal')).toBe('Minimal');
    expect(agentExecutionTier('Ultimate')).toBe('Ultimate');
    expect(agentExecutionTier('Plan')).toBe('Standard');
  });

  it('locks every Harness or main-Agent change after the first turn', () => {
    expect(canSwitchSessionMainAgent({
      sessionStarted: true,
      currentAgentType: 'Plan',
      nextAgentType: 'Cowork',
    })).toBe(false);
    expect(canSwitchSessionMainAgent({
      sessionStarted: true,
      currentAgentType: 'Plan',
      nextAgentType: ' plan ',
    })).toBe(true);
    expect(canSwitchSessionMainAgent({
      sessionStarted: true,
      currentAgentType: 'Standard',
      nextAgentType: 'Cowork',
    })).toBe(false);
    expect(canSwitchSessionMainAgent({
      sessionStarted: false,
      currentAgentType: 'minimal',
      nextAgentType: 'Ultimate',
    })).toBe(true);
  });
});

describe('resolveChatInputSendAgentType', () => {
  it('sends Ultra directly for the Ultimate composer level', () => {
    expect(
      resolveChatInputSendAgentType({
        isSubagentTarget: false,
        sessionMode: null,
        acpTargetAgentType: null,
        composerMode: 'Ultimate',
      }),
    ).toBe('Ultimate');
  });

  it('keeps normal sessions on the composer or ACP target mode', () => {
    expect(
      resolveChatInputSendAgentType({
        isSubagentTarget: false,
        sessionMode: 'Explore',
        acpTargetAgentType: null,
        composerMode: 'Standard',
      }),
    ).toBe('Standard');

    expect(
      resolveChatInputSendAgentType({
        isSubagentTarget: false,
        sessionMode: 'Standard',
        acpTargetAgentType: 'acp:example',
        composerMode: 'Standard',
      }),
    ).toBe('acp:example');
  });

  it('keeps subagent continuations on the child session mode instead of the parent composer mode', () => {
    expect(
      resolveChatInputSendAgentType({
        isSubagentTarget: true,
        subagentType: 'Not provided',
        sessionMode: 'Explore',
        acpTargetAgentType: null,
        composerMode: 'Cowork',
      }),
    ).toBe('Explore');
  });

  it('falls back to subagent relationship type when session mode is unavailable', () => {
    expect(
      resolveChatInputSendAgentType({
        isSubagentTarget: true,
        subagentType: 'ReviewSecurity',
        sessionMode: undefined,
        acpTargetAgentType: null,
        composerMode: 'Standard',
      }),
    ).toBe('ReviewSecurity');
  });

  it('ignores display placeholders when resolving subagent targets', () => {
    expect(
      resolveChatInputSendAgentType({
        isSubagentTarget: true,
        subagentType: 'Not provided',
        sessionMode: 'Not provided',
        acpTargetAgentType: null,
        composerMode: 'Standard',
      }),
    ).toBe('Standard');
  });
});

describe('resolveChatInputCanUseSkills', () => {
  it('allows skills when the target agent exposes the Skill tool', () => {
    expect(
      resolveChatInputCanUseSkills({
        isSubagentTarget: true,
        targetAgentType: 'Explore',
        availableAgents: [
          { id: 'Explore', defaultTools: ['Read', 'Skill'] },
        ],
      }),
    ).toBe(true);
  });

  it('hides skills when the target agent does not expose the Skill tool', () => {
    expect(
      resolveChatInputCanUseSkills({
        isSubagentTarget: true,
        targetAgentType: 'ReviewSecurity',
        availableAgents: [
          { id: 'ReviewSecurity', defaultTools: ['Read', 'Grep', 'Glob'] },
        ],
      }),
    ).toBe(false);

    expect(
      resolveChatInputCanUseSkills({
        isSubagentTarget: false,
        targetAgentType: 'ReadOnly',
        availableAgents: [
          { id: 'ReadOnly', defaultTools: ['Read', 'Grep', 'Glob'] },
        ],
      }),
    ).toBe(false);
  });

  it('hides skills for unknown subagent targets while preserving normal-session fallback', () => {
    expect(
      resolveChatInputCanUseSkills({
        isSubagentTarget: true,
        targetAgentType: 'MissingSubagent',
        availableAgents: [],
      }),
    ).toBe(false);

    expect(
      resolveChatInputCanUseSkills({
        isSubagentTarget: false,
        targetAgentType: 'Standard',
        availableAgents: [],
      }),
    ).toBe(true);
  });

  it('preserves the normal-session fallback when tool metadata is missing', () => {
    expect(
      resolveChatInputCanUseSkills({
        isSubagentTarget: false,
        targetAgentType: 'Standard',
        availableAgents: [{ id: 'Standard' }],
      }),
    ).toBe(true);

    expect(
      resolveChatInputCanUseSkills({
        isSubagentTarget: true,
        targetAgentType: 'Explore',
        availableAgents: [{ id: 'Explore' }],
      }),
    ).toBe(false);
  });
});

describe('isChatInputActionVisibleForTarget', () => {
  it('hides main-session slash actions for subagent targets', () => {
    for (const actionId of ['goal', 'review', 'deepreview', 'init']) {
      expect(
        isChatInputActionVisibleForTarget({
          actionId,
          isSubagentTarget: true,
        }),
      ).toBe(false);
    }
  });

  it('keeps other slash actions visible for subagent targets', () => {
    for (const actionId of ['usage', 'compact', 'reload']) {
      expect(
        isChatInputActionVisibleForTarget({
          actionId,
          isSubagentTarget: true,
        }),
      ).toBe(true);
    }
  });

  it('keeps main-session slash actions visible for normal targets', () => {
    for (const actionId of ['goal', 'review', 'deepreview', 'init']) {
      expect(
        isChatInputActionVisibleForTarget({
          actionId,
          isSubagentTarget: false,
        }),
      ).toBe(true);
    }
  });
});

describe('isPrimarySlashActionVisible', () => {
  it('keeps BTW discoverable when Review is unavailable on the current surface', () => {
    expect(isPrimarySlashActionVisible({
      actionId: 'btw',
      isBtwSession: false,
      canLaunchReview: false,
    })).toBe(true);
    expect(isPrimarySlashActionVisible({
      actionId: 'review',
      isBtwSession: false,
      canLaunchReview: false,
    })).toBe(false);
  });
});

describe('resolveSessionAssistantWorkspace', () => {
  it('does not treat a project session as assistant during workspace scene transitions', () => {
    const projectWorkspace = createWorkspace({
      id: 'project-1',
      rootPath: 'E:/Projects/repos/claude-code',
      workspaceKind: WorkspaceKind.Normal,
    });
    const assistantWorkspace = createWorkspace({
      id: 'assistant-1',
      rootPath: 'C:/Users/wsp/.openbitfun/personal_assistant/workspace',
      workspaceKind: WorkspaceKind.Assistant,
    });

    expect(
      resolveSessionAssistantWorkspace({
        currentWorkspace: assistantWorkspace,
        sessionWorkspaceId: projectWorkspace.id,
        sessionWorkspacePath: projectWorkspace.rootPath,
        openedWorkspaces: [projectWorkspace, assistantWorkspace],
      }),
    ).toBe(false);
  });

  it('recognizes assistant sessions from their own workspace scope even before current workspace catches up', () => {
    const projectWorkspace = createWorkspace({
      id: 'project-1',
      rootPath: 'E:/Projects/repos/claude-code',
      workspaceKind: WorkspaceKind.Normal,
    });
    const assistantWorkspace = createWorkspace({
      id: 'assistant-1',
      rootPath: 'C:/Users/wsp/.openbitfun/personal_assistant/workspace',
      workspaceKind: WorkspaceKind.Assistant,
    });

    expect(
      resolveSessionAssistantWorkspace({
        currentWorkspace: projectWorkspace,
        sessionWorkspaceId: assistantWorkspace.id,
        sessionWorkspacePath: assistantWorkspace.rootPath,
        openedWorkspaces: [projectWorkspace, assistantWorkspace],
      }),
    ).toBe(true);
  });

  it('falls back to the current workspace kind when the session has no explicit workspace scope yet', () => {
    const assistantWorkspace = createWorkspace({
      id: 'assistant-1',
      rootPath: 'C:/Users/wsp/.openbitfun/personal_assistant/workspace',
      workspaceKind: WorkspaceKind.Assistant,
    });

    expect(
      resolveSessionAssistantWorkspace({
        currentWorkspace: assistantWorkspace,
        openedWorkspaces: [assistantWorkspace],
      }),
    ).toBe(true);
  });
});

describe('resolveAvailableChatInputMode', () => {
  it('returns the synchronized session mode when it is still available', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'Standard',
        isAssistantWorkspace: false,
        sessionMode: 'Plan',
        availableModeIds: ['Standard', 'Plan', 'Cowork'],
      }),
    ).toBe('Plan');
  });

  it('keeps a persisted unavailable session mode instead of silently replacing its route', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'PlannerPlus',
        isAssistantWorkspace: false,
        sessionMode: 'PlannerPlus',
        availableModeIds: ['Standard', 'Cowork'],
      }),
    ).toBeNull();
  });

  it('restores the persisted session mode even while its catalog entry is unavailable', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'Cowork',
        isAssistantWorkspace: false,
        sessionMode: 'PlannerPlus',
        availableModeIds: ['Standard', 'Cowork'],
      }),
    ).toBe('PlannerPlus');
  });

  it('restores the persisted session mode while the workspace catalog is loading', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'Standard',
        isAssistantWorkspace: false,
        sessionMode: 'WorkspaceProfile',
        availableModeIds: [],
      }),
    ).toBe('WorkspaceProfile');
  });

  it('keeps assistant workspaces pinned to Claw when available', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'PlannerPlus',
        isAssistantWorkspace: true,
        sessionMode: 'PlannerPlus',
        availableModeIds: ['Standard', 'Claw'],
      }),
    ).toBe('Claw');
  });

  it('keeps Claw sessions pinned even before assistant workspace resolution catches up', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'Standard',
        isAssistantWorkspace: false,
        sessionMode: 'Claw',
        availableModeIds: ['Standard', 'Claw', 'PlannerPlus'],
      }),
    ).toBe('Claw');
  });

  it('does not replace a persisted mode with the first unrelated available mode', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'PlannerPlus',
        isAssistantWorkspace: false,
        sessionMode: 'PlannerPlus',
        availableModeIds: ['Cowork', 'Plan'],
      }),
    ).toBeNull();
  });

  it('uses the user default mode when starting from the internal project default', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'Standard',
        isAssistantWorkspace: false,
        sessionMode: undefined,
        userDefaultModeId: 'PlannerPlus',
        availableModeIds: ['Standard', 'PlannerPlus'],
      }),
    ).toBe('PlannerPlus');
  });

  it('does not let the user default override a retired mode bound by an older peer', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'Multitask',
        isAssistantWorkspace: false,
        sessionMode: 'Multitask',
        userDefaultModeId: 'PlannerPlus',
        availableModeIds: ['Standard', 'Multitask', 'PlannerPlus'],
      }),
    ).toBeNull();
  });

  it('ignores unavailable user defaults and falls back to agentic', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'MissingMode',
        isAssistantWorkspace: false,
        sessionMode: undefined,
        userDefaultModeId: 'PlannerPlus',
        availableModeIds: ['Standard', 'Cowork'],
      }),
    ).toBe('Standard');
  });

  it.each(['Multitask', 'Plan'])('does not restore retired %s as a new-session main Agent default', (retiredMode) => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'Standard',
        isAssistantWorkspace: false,
        sessionMode: undefined,
        userDefaultModeId: retiredMode,
        availableModeIds: ['Standard', retiredMode],
      }),
    ).toBeNull();
  });

  it('keeps assistant workspaces pinned to Claw even with a user default', () => {
    expect(
      resolveAvailableChatInputMode({
        currentMode: 'Standard',
        isAssistantWorkspace: true,
        sessionMode: undefined,
        userDefaultModeId: 'PlannerPlus',
        availableModeIds: ['Standard', 'Claw', 'PlannerPlus'],
      }),
    ).toBe('Claw');
  });
});
