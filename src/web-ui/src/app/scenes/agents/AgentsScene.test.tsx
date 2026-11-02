import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useAgentsStore } from './agentsStore';
import { isLocallyManageableSubagent } from './agentVisibility';

const useAgentsListMock = vi.hoisted(() => vi.fn());
const notificationInfoMock = vi.hoisted(() => vi.fn());
const notificationSuccessMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('./components/CreateAgentPage', () => ({
  default: () => <div data-testid="create-agent-page">create agent</div>,
}));

vi.mock('./components/AgentCard', () => ({
  default: ({
    agent,
    toolCount,
    onOpenDetails,
  }: {
    agent: { name: string };
    toolCount?: number;
    onOpenDetails: (agent: unknown) => void;
  }) => (
    <button
      type="button"
      data-tool-count={toolCount}
      onClick={() => onOpenDetails(agent)}
    >
      {agent.name}
    </button>
  ),
}));

vi.mock('./components/CoreAgentCard', async () => ({
  default: (await import('./components/AgentCard')).default,
}));

vi.mock('./components/useUserToolGroups', () => ({
  useUserToolGroups: () => ({
    groups: [],
    loading: false,
    saveGroups: vi.fn(),
  }),
}));

vi.mock('@/features/skill-groups/useUserSkillGroups', () => ({
  useUserSkillGroups: () => ({
    groups: [],
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('./components/SkillGroupPicker', () => ({
  SkillGroupPicker: () => <div data-testid="agent-detail-skill-groups">skill picker</div>,
  SkillGroupSummary: () => <div data-testid="agent-detail-skill-summary">skill summary</div>,
}));

vi.mock('./components/ToolGroupPicker', () => ({
  ToolGroupPicker: ({ tools }: { tools: Array<{ name: string }> }) => (
    <div data-testid="agent-detail-tool-groups">
      {tools.map((tool) => tool.name).join(',')}
    </div>
  ),
  ToolGroupSummary: ({ tools }: { tools: Array<{ name: string }> }) => (
    <div data-testid="agent-detail-tool-summary">
      {tools.map((tool) => tool.name).join(',')}
    </div>
  ),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Select: () => <div />,
  Switch: () => <input type="checkbox" readOnly />,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/infrastructure/confirm-dialog', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/infrastructure/confirm-dialog')>(),
  confirmDanger: vi.fn(async () => false),
}));

vi.mock('@/app/components/GalleryLayout', () => ({
  GalleryEmpty: () => <div />,
  GalleryGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  GalleryLayout: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <main className={className}>{children}</main>
  ),
  GalleryPageHeader: () => <header />,
  GallerySkeleton: () => <div />,
  GalleryZone: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock('./hooks/useAgentsList', () => ({
  useAgentsList: () => useAgentsListMock(),
}));

function mockAgentsList(overrides: Record<string, unknown> = {}) {
  useAgentsListMock.mockReturnValue({
    hiddenAgentIds: new Set<string>(),
    allAgents: [],
    filteredAgents: [],
    loading: false,
    availableTools: [],
    toolCatalogStatus: 'available',
    getModeProfile: () => null,
    getAgentSkills: () => [],
    getModeManageableSubagents: () => [],
    counts: { builtin: 0, user: 0, project: 0, mode: 0, subagent: 0 },
    loadAgents: vi.fn(),
    getModeConfig: () => undefined,
    handleSetTools: vi.fn(),
    handleResetTools: vi.fn(),
    handleSetSkills: vi.fn(),
    handleResetSkills: vi.fn(),
    handleSetSubagentEnabled: vi.fn(),
    handleSetSubagentModel: vi.fn(),
    ...overrides,
  });
}

vi.mock('@/app/hooks/useGallerySceneAutoRefresh', () => ({
  useGallerySceneAutoRefresh: vi.fn(),
}));

vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({ workspacePath: 'D:/workspace/project' }),
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: {
    getConfig: vi.fn(async () => false),
    onConfigChange: vi.fn(() => () => {}),
  },
}));

vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({
    success: notificationSuccessMock,
    error: vi.fn(),
    warning: vi.fn(),
    info: notificationInfoMock,
  }),
}));

vi.mock('@/infrastructure/api/service-api/SubagentAPI', () => ({
  SubagentAPI: {
    deleteSubagent: vi.fn(),
  },
}));

let JSDOMCtor: (new (
  html?: string,
  options?: { pretendToBeVisual?: boolean }
) => { window: Window & typeof globalThis }) | null = null;

try {
  const jsdom = await import('jsdom');
  JSDOMCtor = jsdom.JSDOM as typeof JSDOMCtor;
} catch {
  JSDOMCtor = null;
}

const describeWithJsdom = JSDOMCtor ? describe : describe.skip;

describe('agent editability', () => {
  it('keeps external subagents visible but outside local mutations', () => {
    expect(isLocallyManageableSubagent({ source: 'external' })).toBe(false);
    expect(isLocallyManageableSubagent({ subagentSource: 'external', source: 'user' })).toBe(false);
    expect(isLocallyManageableSubagent({ source: 'builtin' })).toBe(true);
  });
});

describeWithJsdom('AgentsScene', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOMCtor!('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost',
    });

    const { window } = dom;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('navigator', window.navigator);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('MutationObserver', window.MutationObserver);
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    useAgentsStore.getState().openHome();
    notificationInfoMock.mockReset();
    notificationSuccessMock.mockReset();
    mockAgentsList();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    dom.window.close();
    vi.unstubAllGlobals();
    useAgentsStore.getState().openHome();
  });

  it('keeps agent creation inside a full-height scene page wrapper', async () => {
    useAgentsStore.getState().openCreateAgent();
    const { default: AgentsScene } = await import('./AgentsScene');

    await act(async () => {
      root.render(<AgentsScene />);
    });

    expect(container.querySelector('[data-testid="create-agent-page"]')).toBeTruthy();
    expect(container.querySelector('.openbitfun-agents-scene--page')).toBeTruthy();
  }, 10_000);

  it('keeps agent subpages stretched across the active scene viewport', () => {
    const stylesheet = readFileSync(
      fileURLToPath(new URL('./AgentsScene.scss', import.meta.url)),
      'utf8',
    );

    expect(stylesheet).toContain('width: 100%;');
    expect(stylesheet).toContain('flex: 1 1 auto;');
    expect(stylesheet).toContain('min-width: 0;');
  });

  it('uses one responsive catalog without overview category navigation', () => {
    const sceneSource = readFileSync(
      fileURLToPath(new URL('./AgentsScene.tsx', import.meta.url)),
      'utf8',
    );

    expect(sceneSource.match(/<GalleryGrid\b[^>]*\bminCardWidth=\{300\}[^>]*>/g)).toHaveLength(1);
    expect(sceneSource).toContain('catalogAgents.map');
    expect(sceneSource).not.toContain('gallery-anchor-bar');
    expect(sceneSource).not.toContain('agents-core-zone');
  });

  it('presents four canonical Harness cards in an accessible list', async () => {
    const { default: AgentsScene } = await import('./AgentsScene');

    await act(async () => {
      root.render(<AgentsScene />);
    });

    const presentation = container.querySelector('.openbitfun-agents-scene__harness-presentation');
    expect(presentation?.tagName).toBe('UL');
    expect(presentation?.getAttribute('role')).toBe('list');
    expect(presentation?.getAttribute('aria-label')).toBe('harnessZone.title');
    expect(presentation?.querySelectorAll(':scope > li')).toHaveLength(4);
    expect(presentation?.querySelectorAll('[data-openbitfun-component="harness-profile-step"]')).toHaveLength(4);

    for (const id of ['Minimal', 'Standard', 'Ultimate', 'Creative']) {
      const profile = container.querySelector<HTMLElement>(`[data-testid="agents-harness-${id}"]`);
      expect(profile?.dataset.openbitfunProfile).toBe(id);
      expect(profile?.textContent).toContain(`harnessZone.profiles.${id}.name`);
      expect(profile?.textContent).toContain(`harnessZone.profiles.${id}.description`);
      expect(profile?.tagName).toBe('BUTTON');
      expect(profile?.querySelector('.openbitfun-agents-scene__harness-profile-icon')).not.toBeNull();
      expect(profile?.querySelector('.openbitfun-agents-scene__harness-route svg')).not.toBeNull();
      expect(profile?.dataset.openbitfunState).toBeUndefined();
    }
    expect(presentation?.querySelectorAll('button')).toHaveLength(4);
    expect(presentation?.textContent).not.toMatch(/harnessZone\.(task|result|connected|comingSoon)/);

    expect(notificationInfoMock).not.toHaveBeenCalled();
    expect(notificationSuccessMock).not.toHaveBeenCalled();
  });

  it.each(['Minimal', 'Standard', 'Ultimate', 'Creative'])(
    'opens the %s animation and one-sentence description before configuration', async (id) => {
      const harness = {
        key: `harness::${id}`, id, name: id, description: 'Runtime policy',
        agentKind: 'harness', source: 'builtin', capabilities: [], defaultTools: [],
      };
      mockAgentsList({ allAgents: [harness] });
      const { default: AgentsScene } = await import('./AgentsScene');
      await act(async () => { root.render(<AgentsScene />); });
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`[data-testid="agents-harness-${id}"]`)?.click();
      });

      const preview = document.querySelector<HTMLElement>('[data-testid="harness-preview-dialog"]');
      expect(preview?.getAttribute('data-size')).toBe('sm');
      expect(preview?.getAttribute('aria-labelledby')).toBe(preview?.querySelector('h2')?.id);
      const animation = preview?.querySelector('[data-testid="harness-preview-animation"]');
      expect(animation?.getAttribute('data-profile')).toBe(id);
      expect(animation?.tagName).toBe('BUTTON');
      expect(animation?.getAttribute('aria-label')).toBe('harnessZone.replay');
      expect(preview?.querySelector('[data-testid="harness-preview-replay"]')).toBeNull();
      const description = preview?.querySelector('[data-testid="harness-preview-description"]');
      expect(description?.textContent).toBe(`harnessZone.profiles.${id}.description`);
      expect(description?.textContent).toBe(container.querySelector(
        `[data-testid="agents-harness-${id}"] .openbitfun-agents-scene__harness-profile-purpose`,
      )?.textContent);
      expect(preview?.getAttribute('aria-describedby')).toBe(description?.id);
      expect(preview?.querySelector('[role="tablist"]')).toBeNull();
      expect(document.querySelector('[data-testid="agent-detail-panel"]')).toBeNull();

      await act(async () => {
        preview?.querySelector<HTMLButtonElement>('[data-openbitfun-part="close"]')?.click();
      });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
      expect(document.querySelector('[data-testid="harness-preview-dialog"]')).toBeNull();
      expect(document.querySelector('[data-testid="agent-detail-panel"]')).toBeNull();
    },
  );

  it('expands the same Harness dialog into configuration without replacing its overlay or focus scope', async () => {
    const harness = {
      key: 'harness::Standard', id: 'Standard', name: 'Standard', description: 'Runtime policy',
      agentKind: 'harness', source: 'builtin', capabilities: [], defaultTools: [],
    };
    mockAgentsList({ allAgents: [harness] });
    const { default: AgentsScene } = await import('./AgentsScene');
    await act(async () => { root.render(<AgentsScene />); });
    const card = container.querySelector<HTMLButtonElement>('[data-testid="agents-harness-Standard"]')!;
    await act(async () => {
      card.focus();
      card.click();
    });
    const preview = document.querySelector<HTMLElement>('[data-testid="harness-preview-dialog"]')!;
    const overlay = preview.closest('[data-openbitfun-part="overlay"]');
    const heading = preview.querySelector('h2');
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    Object.defineProperty(window.HTMLElement.prototype, 'animate', { value: animate, configurable: true });
    vi.spyOn(preview, 'getBoundingClientRect').mockImplementation(() => ({
      width: preview.dataset.size === 'sm' ? 420 : 960,
      height: preview.dataset.size === 'sm' ? 400 : 540,
    } as DOMRect));
    await act(async () => {
      const manage = preview.querySelector<HTMLButtonElement>('[data-testid="harness-preview-manage"]')!;
      manage.focus();
      manage.click();
    });
    expect(document.querySelector('[data-testid="agent-detail-panel"]')).toBeNull();
    expect(preview.dataset.detailView).toBe('transitioning');
    expect(preview.dataset.state).toBe('open');
    expect(document.querySelectorAll('[data-openbitfun-component="dialog"][data-openbitfun-part="overlay"]')).toHaveLength(1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    expect(document.querySelector('[data-testid="harness-preview-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="agent-detail-panel"]')).toBe(preview);
    expect(preview.closest('[data-openbitfun-part="overlay"]')).toBe(overlay);
    expect(preview.querySelector('h2')).toBe(heading);
    expect(preview.dataset.size).toBe('lg');
    expect(preview.querySelector('[data-testid="agent-detail-title"]')?.textContent).toBe('Standard');
    expect(preview.querySelector('[data-testid="agent-detail-basic-section"]')).toBeTruthy();
    expect(preview.querySelector('[data-testid="agent-detail-capability-cards"]')).toBeTruthy();
    expect(document.activeElement).toBe(preview.querySelector('[data-openbitfun-part="close"]'));
    expect(animate).toHaveBeenCalledWith([
      { width: '420px', height: '400px' }, { width: '960px', height: '540px' },
    ], expect.objectContaining({ duration: 350 }));
    await act(async () => { preview.querySelector<HTMLButtonElement>('[data-testid="agent-detail-close"]')?.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    expect(document.activeElement).toBe(card);
  });

  it('cancels the management transition when the Harness dialog is closed', async () => {
    mockAgentsList({ allAgents: [{
      key: 'harness::Standard', id: 'Standard', name: 'Standard', description: 'Runtime policy',
      agentKind: 'harness', source: 'builtin', capabilities: [], defaultTools: [],
    }] });
    const { default: AgentsScene } = await import('./AgentsScene');
    await act(async () => { root.render(<AgentsScene />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="agents-harness-Standard"]')?.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="harness-preview-manage"]')?.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="agent-detail-close"]')?.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="agent-detail-panel"]')).toBeNull();
  });

  it('shows a completed illustration when reduced motion is preferred', async () => {
    window.matchMedia = vi.fn(query => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    mockAgentsList({ allAgents: [{
      key: 'harness::Creative', id: 'Creative', name: 'Creative', description: 'Runtime policy',
      agentKind: 'harness', source: 'builtin', capabilities: [], defaultTools: [],
    }] });
    const { default: AgentsScene } = await import('./AgentsScene');
    await act(async () => { root.render(<AgentsScene />); });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="agents-harness-Creative"]')?.click();
    });
    const preview = document.querySelector('[data-testid="harness-preview-dialog"]');
    expect(preview?.querySelector('.harness-preview__app-button')).toBeTruthy();
    expect(preview?.querySelector('.harness-preview__sparkle')).toBeTruthy();
    await act(async () => {
      preview?.querySelector<HTMLButtonElement>('[data-testid="harness-preview-animation"]')?.click();
    });
    expect(preview?.querySelector('.harness-preview__app-button')).toBeTruthy();
    await act(async () => {
      preview?.querySelector<HTMLButtonElement>('[data-testid="harness-preview-manage"]')?.click();
    });
    expect(document.querySelector('[data-testid="agent-detail-panel"]')).toBe(preview);
    expect(preview?.querySelector('[data-testid="agent-detail-capability-cards"]')).toBeTruthy();
  });

  it('shows skill grouping and editing for a custom subagent with the Skill tool', async () => {
    const subagent = {
      key: 'user::skill-worker',
      id: 'skill-worker',
      name: 'Skill worker',
      description: 'Uses specialized workflows.',
      isReadonly: false,
      isReview: false,
      toolCount: 1,
      defaultTools: ['Skill'],
      defaultEnabled: true,
      effectiveEnabled: true,
      source: 'user',
      agentKind: 'subagent' as const,
      capabilities: [],
    };
    mockAgentsList({
      allAgents: [subagent],
      filteredAgents: [subagent],
      getAgentSkills: (agentId: string) => agentId === subagent.id
        ? [{ key: 'user::custom::workflow', effectiveEnabled: true }]
        : [],
    });
    const { default: AgentsScene } = await import('./AgentsScene');

    await act(async () => {
      root.render(<AgentsScene />);
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === subagent.name)
        ?.click();
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(
      document.querySelector('[data-testid="agent-detail-title"]')?.id,
    );
    expect(dialog?.querySelector('[role="tablist"]')).toBeNull();
    expect(dialog?.querySelectorAll('[data-detail-section]')).toHaveLength(3);
    expect(dialog?.querySelector('[data-testid="agent-detail-description"]')?.textContent)
      .toBe(subagent.description);
    expect(dialog?.querySelector('[data-testid="agent-detail-capabilities-section"]')).toBeNull();

    const skillsTab = dialog?.querySelector<HTMLButtonElement>('[data-detail-section="skills"]');
    expect(skillsTab).toBeTruthy();

    await act(async () => {
      skillsTab?.click();
    });
    expect(dialog?.querySelector('[data-testid="agent-detail-skill-summary"]')).toBeTruthy();
    expect(dialog?.querySelector('[data-detail-page="skills"]')?.getAttribute('aria-labelledby'))
      .toBe(dialog?.querySelector('.agent-detail-dialog__section-title')?.id);
    expect(dialog?.querySelector('[data-testid="agent-detail-basic-section"]')).toBeNull();

    const manageButton = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent === 'manage');
    expect(manageButton).toBeTruthy();
    await act(async () => {
      manageButton?.click();
    });
    expect(dialog?.querySelector('[data-testid="agent-detail-skill-groups"]')).toBeTruthy();
    const footer = dialog?.querySelector(':scope > footer');
    expect(footer?.getAttribute('data-appearance')).toBe('floating');
    expect(footer?.previousElementSibling?.getAttribute('role')).toBe('region');
    const cancelButton = Array.from(footer?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((button) => button.textContent === 'agentsOverview.cancel');
    expect(cancelButton).toBeTruthy();
    await act(async () => { cancelButton?.click(); });
    expect(dialog?.querySelector('footer')).toBeNull();
    expect(dialog?.querySelector('[data-testid="agent-detail-skill-summary"]')).toBeTruthy();
  });

  it.each([false, true])('shows an overview with capability cards and navigates within the same centered dialog (collaboration: %s)', async collaboration => {
    const agent = {
      key: 'builtin::Cowork', id: 'Cowork', name: 'Cowork', description: 'Daily work and coding.',
      source: 'builtin', agentKind: 'agent', capabilities: [{ category: 'coding', level: 4 }],
      defaultTools: ['Read', 'Skill', ...(collaboration ? ['AgentSpawn'] : [])],
    };
    mockAgentsList({
      allAgents: [agent], filteredAgents: [agent],
      availableTools: [{ name: 'Read', description: 'Read files.', is_readonly: true }],
      getAgentSkills: () => [{ key: 'user::custom::workflow', effectiveEnabled: true }],
    });
    const { default: AgentsScene } = await import('./AgentsScene');
    await act(async () => { root.render(<AgentsScene />); });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === agent.name)?.click();
    });
    const dialog = document.querySelector<HTMLElement>('[data-testid="agent-detail-panel"]')!;
    const overlay = dialog.closest('[data-openbitfun-part="overlay"]');
    expect(dialog.dataset.size).toBe('lg');
    expect(dialog.querySelector('[data-testid="agent-detail-basic-section"]')).toBeTruthy();
    expect(dialog.querySelector('[data-testid="agent-detail-description"]')?.textContent).toBe(agent.description);
    expect(dialog.querySelector('[data-testid="agent-detail-capabilities-section"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="agent-detail-basic-section"] h3')).toBeNull();
    expect(dialog.querySelectorAll('[data-detail-section]')).toHaveLength(collaboration ? 3 : 2);
    expect(dialog.querySelector('[role="tablist"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="agent-detail-back"]')).toBeNull();
    const tools = dialog.querySelector<HTMLElement>('[data-detail-section="tools"]')!;
    await act(async () => { tools.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(document.querySelector('[data-testid="agent-detail-panel"]')).toBe(dialog);
    expect(dialog.closest('[data-openbitfun-part="overlay"]')).toBe(overlay);
    expect(dialog.dataset.size).toBe('lg');
    expect(dialog.querySelector('[data-detail-page="tools"]')).toBeTruthy();
    expect(dialog.querySelector('[data-testid="agent-detail-capability-cards"]')).toBeNull();
    expect(dialog.querySelector('[data-testid="agent-detail-tool-summary"]')).toBeTruthy();
    expect(dialog.querySelector('[data-testid="agent-detail-title"]')).toBeNull();
    expect(dialog.querySelector('[data-openbitfun-component="assistant-avatar"]')).toBeNull();
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('.agent-detail-dialog__section-title')?.id);
    const back = dialog.querySelector<HTMLButtonElement>('[data-testid="agent-detail-back"]')!;
    expect(back.getAttribute('aria-label')).toBe('agentsOverview.detail.backToOverview');
    expect(back.textContent).toBe('');
    expect(document.activeElement).toBe(back);
    await act(async () => { back.click(); });
    expect(dialog.querySelector('[data-testid="agent-detail-basic-section"]')).toBeTruthy();
    expect(dialog.querySelector('[data-testid="agent-detail-title"]')?.textContent).toBe(agent.name);
    expect(document.activeElement).toBe(dialog.querySelector('[data-detail-section="tools"]'));
    expect(document.querySelectorAll('[data-openbitfun-component="dialog"][data-openbitfun-part="overlay"]')).toHaveLength(1);
  });

  it('keeps the tools configuration entry available when no tools are enabled', async () => {
    const agent = {
      key: 'user::custom', id: 'custom', name: 'Custom', description: 'Custom agent.',
      source: 'user', agentKind: 'agent', capabilities: [], defaultTools: [],
    };
    mockAgentsList({
      allAgents: [agent], filteredAgents: [agent],
      availableTools: [{ name: 'Read', description: 'Read files.', is_readonly: true }],
    });
    const { default: AgentsScene } = await import('./AgentsScene');
    await act(async () => { root.render(<AgentsScene />); });
    await act(async () => { Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === agent.name)?.click(); });
    const dialog = document.querySelector<HTMLElement>('[data-testid="agent-detail-panel"]')!;
    const tools = dialog.querySelector<HTMLElement>('[data-detail-section="tools"]');
    expect(tools).toBeTruthy();
    await act(async () => { tools?.click(); });
    const manage = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'manage');
    expect(manage?.disabled).toBe(false);
    await act(async () => { manage?.click(); });
    expect(dialog.querySelector('[data-testid="agent-detail-tool-groups"]')).toBeTruthy();
  });

  it('keeps MCP tools out of mode cards and tool details', async () => {
    const mode = {
      key: 'mode::custom-mode',
      id: 'custom-mode',
      name: 'Custom mode',
      description: 'General coding mode.',
      isReadonly: false,
      isReview: false,
      toolCount: 2,
      defaultTools: ['Read'],
      defaultEnabled: true,
      effectiveEnabled: true,
      source: 'user',
      agentKind: 'agent' as const,
      capabilities: [],
    };
    mockAgentsList({
      allAgents: [mode],
      filteredAgents: [mode],
      availableTools: [
        { name: 'Read', description: 'Read files.', is_readonly: true },
        {
          name: 'mcp__github__list_issues',
          description: 'List issues.',
          is_readonly: true,
        },
      ],
      getModeConfig: () => ({
        profile_id: 'Standard',
        enabled_tools: ['Read', 'mcp__github__list_issues'],
        default_tools: ['Read'],
      }),
    });
    const { default: AgentsScene } = await import('./AgentsScene');

    await act(async () => {
      root.render(<AgentsScene />);
    });

    const card = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === mode.name);
    expect(card?.dataset.toolCount).toBe('1');

    await act(async () => {
      card?.click();
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-detail-section="tools"]')?.click();
    });

    const summary = document.querySelector('[data-testid="agent-detail-tool-summary"]');
    expect(summary?.textContent).toBe('Read');
    expect(summary?.textContent).not.toContain('mcp__github__list_issues');
  });

  it('surfaces an unsupported tool catalog on the tools page instead of an empty list', async () => {
    // When the host can't answer get_all_tools_info the tools tab must say so
    // and disable editing, rather than rendering as "no tools". See PR #2428
    // round 5 #2.
    const mode = {
      key: 'mode::custom-mode',
      id: 'custom-mode',
      name: 'Custom mode',
      description: 'General coding mode.',
      isReadonly: false,
      isReview: false,
      toolCount: 1,
      defaultTools: ['Read'],
      defaultEnabled: true,
      effectiveEnabled: true,
      source: 'user',
      agentKind: 'agent' as const,
      capabilities: [],
    };
    mockAgentsList({
      allAgents: [mode],
      filteredAgents: [mode],
      availableTools: [],
      toolCatalogStatus: 'unsupported',
      getModeConfig: () => ({
        profile_id: 'custom-mode',
        enabled_tools: ['Read'],
        default_tools: ['Read'],
      }),
    });
    const { default: AgentsScene } = await import('./AgentsScene');

    await act(async () => {
      root.render(<AgentsScene />);
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === mode.name)
        ?.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-detail-section="tools"]')
        ?.click();
    });

    const status = document.querySelector('[data-testid="agent-detail-tools-catalog-status"]');
    expect(status?.textContent).toContain('agentsOverview.toolsUnsupported');
    // The tool summary picker must not render — the catalog is not available.
    expect(document.querySelector('[data-testid="agent-detail-tool-summary"]')).toBeNull();
  });
});
