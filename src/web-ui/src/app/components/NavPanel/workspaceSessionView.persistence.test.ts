// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_SESSION_VIEW, useWorkspaceSessionViewStore } from './workspaceSessionView';

const STORAGE_KEY = 'openbitfun.workspace-session-view.v2';

describe('workspace session view persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceSessionViewStore.setState({ ...DEFAULT_WORKSPACE_SESSION_VIEW, sourceAgents: {} });
  });

  it.each([3, 4])('reads version %i preferences and preserves legacy workspace selections when saving', async version => {
    const legacy = {
      grouping: 'all', ordering: 'name', show: 'unread',
      filters: { ...DEFAULT_WORKSPACE_SESSION_VIEW.filters, hiddenSources: ['external'] },
      sourceAgents: { 'local:project': 'codex', 'peer:project': 'claude-code' },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version, state: legacy }));

    await useWorkspaceSessionViewStore.persist.rehydrate();
    expect(useWorkspaceSessionViewStore.getState()).toMatchObject({
      ...legacy, sourceAgent: 'all',
      explicitAllFilters: DEFAULT_WORKSPACE_SESSION_VIEW.explicitAllFilters,
    });
    useWorkspaceSessionViewStore.getState().setSourceAgent('zcode');

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.state).toMatchObject({ ...legacy, sourceAgent: 'zcode' });
    useWorkspaceSessionViewStore.setState({ sourceAgent: 'all' });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    await useWorkspaceSessionViewStore.persist.rehydrate();
    expect(useWorkspaceSessionViewStore.getState().sourceAgent).toBe('zcode');
  });

  it.each(['hiddenStatuses', 'hiddenWorktrees', 'hiddenEnvironments', 'hiddenSources'] as const)(
    'preserves manual full selection separately from the All preset for %s after reload', async filter => {
      useWorkspaceSessionViewStore.getState().setHiddenFilterOptions(filter, []);
      const manual = localStorage.getItem(STORAGE_KEY)!;
      useWorkspaceSessionViewStore.getState().resetFilters();
      localStorage.setItem(STORAGE_KEY, manual);
      await useWorkspaceSessionViewStore.persist.rehydrate();
      expect(useWorkspaceSessionViewStore.getState().filters[filter]).toEqual([]);
      expect(useWorkspaceSessionViewStore.getState().explicitAllFilters).not.toContain(filter);

      useWorkspaceSessionViewStore.getState().selectAllFilterOptions(filter);
      const all = localStorage.getItem(STORAGE_KEY)!;
      useWorkspaceSessionViewStore.getState().setHiddenFilterOptions(filter, []);
      localStorage.setItem(STORAGE_KEY, all);
      await useWorkspaceSessionViewStore.persist.rehydrate();
      expect(useWorkspaceSessionViewStore.getState().filters[filter]).toEqual([]);
      expect(useWorkspaceSessionViewStore.getState().explicitAllFilters).toContain(filter);
    },
  );
});
