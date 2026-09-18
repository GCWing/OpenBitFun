// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalEventBus } from '@/infrastructure/event-bus';
import { MCP_CONFIG_CHANGED } from '@/infrastructure/mcp/configEvents';
import type { ExternalSourceCatalogSnapshot } from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import { buildEcosystemProductRuntimes, type EcosystemProductId } from './ecosystemCompatibilityModel';

const mocks = vi.hoisted(() => ({
  getSkillSettings: vi.fn(), setSkillDisabled: vi.fn(), petSettingsListener: vi.fn(), getAccounts: vi.fn(), getPets: vi.fn(), importPet: vi.fn(), getPetSettings: vi.fn(), savePetSettings: vi.fn(), getInstructions: vi.fn(), openScene: vi.fn(), openDestination: vi.fn(), openNativeSkills: vi.fn(),
  deleteSkill: vi.fn(), loadMcp: vi.fn(), saveMcp: vi.fn(), mutateHook: vi.fn(), getSkills: vi.fn(), validateSkill: vi.fn(), addSkill: vi.fn(), getHooks: vi.fn(), getHookCatalog: vi.fn(),
  planHook: vi.fn(), applyHook: vi.fn(), planMcp: vi.fn(), applyMcp: vi.fn(), refresh: vi.fn(),
  workspacePath: '/project', workspaceId: 'workspace-id', remote: false, peer: false, skillImportVersion: 0,
}));
vi.mock('@/app/stores/sceneStore', () => ({ useSceneStore: { getState: () => ({ openScene: mocks.openScene }) } }));
vi.mock('@/app/scenes/settings/settingsStore', () => ({ useSettingsStore: { getState: () => ({ openDestination: mocks.openDestination }) } }));
vi.mock('@/app/scenes/skills/skillsSceneStore', () => ({ useSkillsSceneStore: { getState: () => ({ openNativeSkills: mocks.openNativeSkills }) } }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatNumber: String }) }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useCurrentWorkspace: () => ({
  workspacePath: mocks.workspacePath, workspace: { id: mocks.workspaceId, workspaceKind: mocks.remote ? 'remote' : 'normal' },
}) }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({ usePeerDeviceModeOptional: () => ({ peerMode: { active: mocks.peer } }) }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: {
  getGlobalSkillSettings: mocks.getSkillSettings, setGlobalSkillDisabled: mocks.setSkillDisabled,
  getConfig: mocks.getPetSettings,
  getSkillScanReport: async (...args: unknown[]) => ({ skills: await mocks.getSkills(...args), diagnostics: [], importOperationsVersion: mocks.skillImportVersion }), validateSkillPath: mocks.validateSkill, addSkill: mocks.addSkill, deleteSkill: mocks.deleteSkill,
} }));
vi.mock('@/infrastructure/api/service-api/ExternalHooksAPI', () => ({ externalHooksAPI: {
  getImportSnapshot: mocks.getHooks, getCatalog: mocks.getHookCatalog, planImport: mocks.planHook, applyImport: mocks.applyHook, mutateImport: mocks.mutateHook,
} }));
vi.mock('@/infrastructure/api/service-api/ExternalSourcesAPI', () => ({ externalSourcesAPI: {
  planMcpImport: mocks.planMcp, applyMcpImport: mocks.applyMcp,
} }));
vi.mock('@/infrastructure/config/services/AgentCompanionPetService', () => ({
  listExternalAgentCompanionPets: mocks.getPets, importReviewedAgentCompanionPet: mocks.importPet,
  AGENT_COMPANION_PETS_CHANGED: 'agent-companion-pets-changed',
}));
vi.mock('@/infrastructure/config/services/AIExperienceConfigService', () => ({ aiExperienceConfigService: {
  saveSettings: mocks.savePetSettings, addChangeListener: mocks.petSettingsListener,
} }));
vi.mock('@/infrastructure/api/service-api/AIApi', () => ({ aiApi: { listSubscriptionAccounts: mocks.getAccounts } }));
vi.mock('@/infrastructure/api/service-api/InstructionSourcesAPI', () => ({ instructionSourcesAPI: { getCatalog: mocks.getInstructions } }));
vi.mock('@/infrastructure/api/service-api/MCPAPI', () => ({ MCPAPI: { loadMCPJsonConfig: mocks.loadMcp, saveMCPJsonConfig: mocks.saveMcp } }));
vi.mock('@openbitfun/ui', async (importOriginal) => {
  const Wrapper = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return {
    Alert: (await importOriginal<typeof import('@openbitfun/ui')>()).Alert,
    Input: ({ size: _size, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Switch: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input type="checkbox" role="switch" {...props} />,
    Checkbox: ({ size: _size, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input type="checkbox" {...props} />,
    Button: ({ children, disabled, onClick, 'aria-label': label }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button disabled={disabled} onClick={onClick} aria-label={label}>{children}</button>,
    Select: ({ value, options, onValueChange, disabled }: { value: string; options: Array<{ value: string; label: string }>; onValueChange: (value: string) => void; disabled?: boolean }) => <select value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
    SearchField: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Dialog: ({ open, children, onOpenChange, id, 'data-ecosystem-category': category }: React.PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void; id?: string; 'data-ecosystem-category'?: string }>) => open ? <div role="dialog" id={id} data-ecosystem-category={category}><button onClick={() => onOpenChange(false)}>close</button>{children}</div> : null,
    DialogClose: () => null, DialogDescription: Wrapper, DialogHeaderActions: Wrapper, DialogFooter: Wrapper, DialogHeader: Wrapper, DialogHeading: Wrapper, DialogTitle: Wrapper, DialogBody: Wrapper,
    Icon: () => <span data-icon="true" />,
    IconButton: ({ icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.ReactNode }) => <button {...props}>{icon}</button>,
    Card: Wrapper, CardBody: Wrapper,
    CardHeader: ({ title, description }: { title?: React.ReactNode; description?: React.ReactNode }) => <div>{title}{description}</div>,
    ScrollArea: Wrapper, LoadingState: Wrapper, OverflowText: Wrapper, StatusPill: Wrapper,
  };
});
import ExternalAgentContent, { type ExternalAgentContentHandle } from './ExternalAgentContent';
import { clearEcosystemDiscoveryCache } from './ecosystemDiscoveryCache';

function fixture() {
  const sources = ['codex', 'claude-code'].map((ecosystemId) => ({
    stableKey: ecosystemId, record: { ecosystemId, key: { providerId: `${ecosystemId}.mcp`, sourceId: 'user' },
      displayName: ecosystemId, location: `/${ecosystemId}`, scope: 'user_global', health: 'available', diagnostics: [] },
  }));
  const snapshot = { generation: 1, discoveryPending: false, sources, commands: [],
    hostCapabilities: { canMutatePolicy: true, canManageSources: true, canApproveRuntime: true },
    integrationPolicy: { status: 'compatible', effective: { enabled: true, ecosystems: Object.fromEntries(['codex', 'claude-code'].map(id => [id, { capabilities: { mcp: 'discover_only', subagent: 'auto', command: 'auto' } }])) }, registeredEcosystems: [] },
    mcpServers: sources.map((source) => ({ candidateId: source.stableKey, definition: {
      id: { source: source.record.key, localId: 'docs' }, name: `${source.stableKey}-MCP`, transport: 'local_stdio',
      staticStatus: { state: 'ready' }, environmentKeys: [], headerNames: [], commandPreview: 'docs-server',
    } })),
  } as unknown as ExternalSourceCatalogSnapshot;
  const skills = ['codex', 'claude-code', 'openbitfun'].map((sourceId) => ({
    key: sourceId, sourceId, sourceSlot: sourceId, sourceLabel: sourceId, name: `${sourceId}-Skill`,
    path: `/${sourceId}/skills/demo`, dirName: sourceId === 'openbitfun' ? 'native' : 'demo',
    level: 'user', isBuiltin: false, description: 'Skill description',
  }));
  const hookSources = ['codex', 'claude-code'].map((ecosystemId) => ({ ecosystemId,
    key: { providerId: `${ecosystemId}.hooks`, sourceId: 'user' }, displayName: `${ecosystemId}-Hooks`,
    scope: 'user_global', locationHint: `/${ecosystemId}/settings.json`, health: 'available',
  }));
  const hooks = { schemaVersion: 1, revision: 'r1', imports: [], diagnostics: [], catalog: {
    discoveryPending: false, sources: hookSources, providers: [], diagnostics: [], failedProviderIds: [],
    entries: hookSources.map((source) => ({ source: source.key, stableKey: source.ecosystemId, nativeEvent: 'Stop', handlerKind: 'command', matcher: { kind: 'any' } })),
  } };
  const plan = { schemaVersion: 1, planFingerprint: 'v1', items: sources.map((source) => ({
    candidateId: source.stableKey, disposition: 'eligible', displayName: source.stableKey, proposedNativeId: 'docs', transport: 'local_stdio',
  })) };
  const hookPlan = { schemaVersion: 1, source: hookSources[0], disposition: 'import', behaviorVersion: 'v1', planFingerprint: 'h1', skipped: [],
    handlers: [{ stableKey: 'stop-hook', event: 'Stop', command: 'echo reviewed-command', dependencies: [] }],
  };
  return { snapshot, skills, hooks, plan, hookPlan };
}

describe('external agent content and explicit import boundary', () => {
  let root: Root;
  let container: HTMLDivElement;
  let data: ReturnType<typeof fixture>;
  beforeEach(() => {
    clearEcosystemDiscoveryCache();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.resetAllMocks();
    localStorage.clear();
    mocks.remote = false; mocks.peer = false; mocks.workspacePath = '/project'; mocks.workspaceId = 'workspace-id'; mocks.skillImportVersion = 0;
    data = fixture();
    mocks.getSkillSettings.mockResolvedValue({ directSkillManagementVersion: 1, globallyDisabledUserSkillKeys: [], globallyDisabledProjectSkillKeys: [] });
    mocks.setSkillDisabled.mockResolvedValue({ directSkillManagementVersion: 1, globallyDisabledUserSkillKeys: [], globallyDisabledProjectSkillKeys: [] });
    mocks.getAccounts.mockResolvedValue([]);
    mocks.getPets.mockResolvedValue({ candidates: [], diagnostics: [] });
    mocks.getPetSettings.mockResolvedValue({ enable_agent_companion: false });
    mocks.savePetSettings.mockResolvedValue(undefined);
    mocks.petSettingsListener.mockReturnValue(() => {});
    mocks.getInstructions.mockResolvedValue({ schemaVersion: 1, entries: [], failedEcosystems: [] });
    mocks.getSkills.mockImplementation(async () => [...data.skills]);
    mocks.getHooks.mockResolvedValue(data.hooks);
    mocks.getHookCatalog.mockResolvedValue(data.hooks.catalog);
    mocks.planMcp.mockResolvedValue(data.plan);
    mocks.planHook.mockResolvedValue(data.hookPlan);
    mocks.validateSkill.mockResolvedValue({ valid: true });
    mocks.addSkill.mockImplementation(async () => {
      data.skills.push({ ...data.skills[0], key: 'imported-copy', sourceId: 'openbitfun', sourceSlot: 'openbitfun', path: '/native/skills/demo' });
      return 'ok';
    });
    mocks.deleteSkill.mockImplementation(async () => { data.skills = data.skills.filter((skill) => skill.key !== 'imported-copy'); mocks.getSkills.mockImplementation(async () => [...data.skills]); return 'ok'; });
    mocks.saveMcp.mockResolvedValue({ runtimeApplied: true });
    mocks.loadMcp.mockResolvedValue({ fingerprint: 'native-v1', jsonConfig: JSON.stringify({ mcpServers: { docs: { command: 'docs-server', _openbitfunImport: { sourceCandidateId: 'codex', behaviorVersion: 'v1' } }, keep: { command: 'keep' } } }) });
    mocks.mutateHook.mockResolvedValue(data.hooks);
    mocks.applyMcp.mockResolvedValue({ outcome: { status: 'applied' } });
    mocks.applyHook.mockResolvedValue({ outcome: { kind: 'applied', snapshot: data.hooks } });
    mocks.refresh.mockResolvedValue(undefined);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(product: EcosystemProductId = 'codex', catalogFailed = false, onCounts?: (counts: Record<string, number>) => void) {
    const runtime = buildEcosystemProductRuntimes(data.snapshot, []).find((entry) => entry.spec.id === product)!;
    await act(async () => root.render(<ExternalAgentContent key={`${product}:${mocks.workspacePath}`} runtime={runtime} snapshot={data.snapshot} catalogFailed={catalogFailed} onRefresh={mocks.refresh} onSupplementalCounts={onCounts} />));
  }
  async function click(label: string, kind?: string) {
    if (kind && !container.querySelector(`[data-import-kind="${kind}"]`)) await expand(kind);
    const region = kind ? container.querySelector(`[data-import-kind="${kind}"][data-import-discovered="true"]`)! : container;
    const button = Array.from(region.querySelectorAll('button')).find((candidate) => candidate.textContent === label);
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  }

  async function expand(kind: string) {
    if (container.querySelector(`[data-ecosystem-category="${kind}"]`)) return;
    const trigger = container.querySelector<HTMLButtonElement>(
      `[data-content-group="${kind}"] button[aria-haspopup="dialog"], [data-content-group="${kind}"] button[aria-expanded]`,
    )!;
    if (trigger.getAttribute('aria-expanded') !== 'true') await act(async () => trigger.click());
  }

  it('shows native account status only for the matching provider and opens existing settings', async () => {
    mocks.getAccounts.mockResolvedValue([
      { provider: 'codex', connected: true, account: 'codex@example.test' },
      { provider: 'opencode', connected: true, account: 'other@example.test' },
    ]);
    await render();
    await expand('account');
    const account = container.querySelector('[data-content-group="account"]')!;
    expect(account.textContent).toContain('codex@example.test');
    expect(account.textContent).not.toContain('other@example.test');
    expect(account.textContent).toContain('content.accounts.labels.connected');
    expect(account.querySelector('input[type="checkbox"]')).toBeNull();
    expect(account.textContent).not.toContain('content.importSelected');
    await click('content.accounts.manage');
    expect(mocks.openDestination).toHaveBeenCalledWith({ pageId: 'ai.models' });
    expect(mocks.openScene).toHaveBeenCalledWith('settings');
  });

  it('offers the existing login path for a disconnected subscription', async () => {
    mocks.getAccounts.mockResolvedValue([{ provider: 'opencode', connected: false }]);
    await render('opencode');
    await expand('account');
    expect(container.textContent).toContain('content.accounts.labels.notConnected');
    await click('content.accounts.connect');
    expect(mocks.openDestination).toHaveBeenCalledWith({ pageId: 'ai.models' });
  });

  it.each([
    ['vault_unavailable', 'vaultUnavailable'],
    ['reauthentication_required', 'reauthenticationRequired'],
  ])('does not present %s as a healthy connection', async (flag, state) => {
    mocks.getAccounts.mockResolvedValue([{ provider: 'codex', connected: true, [flag]: true }]);
    await render();
    await expand('account');
    const account = container.querySelector('[data-content-group="account"]')!;
    expect(account.textContent).toContain(`content.accounts.states.${state}`);
    expect(account.textContent).not.toContain('content.accounts.labels.connected');
    expect(account.textContent).toContain('content.accounts.connect');
  });

  it('rereads accounts on page refresh and clears stale success after a failure', async () => {
    mocks.getAccounts.mockResolvedValue([{ provider: 'codex', connected: true, account: 'old@example.test' }]);
    await render();
    await expand('account');
    mocks.getAccounts.mockRejectedValue(new Error('unavailable'));
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="content.accounts.refresh"]')!;
    await act(async () => refresh.click());
    expect(container.textContent).toContain('content.accounts.labels.failed');
    expect(container.textContent).not.toContain('old@example.test');
    mocks.getAccounts.mockResolvedValue([{ provider: 'codex', connected: false }]);
    await act(async () => refresh.click());
    expect(container.textContent).toContain('content.accounts.labels.notConnected');
  });

  it('hides local account identity immediately on a peer switch and does not query peer accounts', async () => {
    mocks.getAccounts.mockResolvedValue([{ provider: 'codex', connected: true, account: 'local@example.test' }]);
    await render();
    await expand('account');
    const calls = mocks.getAccounts.mock.calls.length;
    mocks.peer = true;
    await render();
    expect(container.textContent).not.toContain('local@example.test');
    expect(container.textContent).toContain('content.accounts.states.unsupportedHost');
    expect(mocks.getAccounts).toHaveBeenCalledTimes(calls);
    expect(container.textContent).not.toContain('content.accounts.manage');
  });

  it('ignores a pending local account response after switching to a peer', async () => {
    let resolve!: (value: unknown[]) => void;
    mocks.getAccounts.mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    mocks.peer = true;
    await render();
    await act(async () => resolve([{ provider: 'codex', connected: true, account: 'late@example.test' }]));
    await expand('account');
    expect(container.textContent).not.toContain('late@example.test');
    expect(container.textContent).toContain('content.accounts.states.unsupportedHost');
  });

  it('keeps a provider missing from an older host unavailable instead of offering login', async () => {
    mocks.getAccounts.mockResolvedValue([{ provider: 'codex', connected: false }]);
    await render('opencode');
    await expand('account');
    expect(container.textContent).toContain('content.accounts.states.unavailable');
    expect(container.textContent).not.toContain('content.accounts.connect');
  });

  it('does not query subscriptions for an ecosystem without an account provider', async () => {
    await render('claude-code');
    expect(mocks.getAccounts).not.toHaveBeenCalled();
    expect(container.querySelector('[data-content-group="account"] button')).toBeNull();
  });

  function petFixture() {
    const pet = { id: 'cat', displayName: 'Codex Cat', source: 'codex', packagePath: '/codex/pets/cat', spritesheetPath: '/codex/pets/cat/sprite.png', spritesheetMimeType: 'image/png', spriteVersionNumber: 2 };
    const candidate = { sourceKey: 'cat-key', fingerprint: 'reviewed-v1', pet, previewDataUrl: 'data:image/png;base64,AA==', imported: null as null | typeof pet, copyModified: false, sourceChanged: false };
    return { candidates: [candidate], diagnostics: [] as string[] };
  }

  it('opens pets in their own catalog dialog and refreshes them from the scene control', async () => {
    mocks.getPets.mockResolvedValue(petFixture());
    const refreshControlRef = React.createRef<ExternalAgentContentHandle>();
    const runtime = buildEcosystemProductRuntimes(data.snapshot, []).find((entry) => entry.spec.id === 'codex')!;
    await act(async () => root.render(<ExternalAgentContent runtime={runtime} snapshot={data.snapshot} catalogFailed={false} onRefresh={mocks.refresh} refreshControlRef={refreshControlRef} />));
    await expand('pet');
    expect(container.textContent).toContain('Codex Cat');
    expect(container.querySelectorAll('[data-ecosystem-category="pet"]')).toHaveLength(1);
    mocks.getPets.mockClear(); mocks.getAccounts.mockClear();
    await act(async () => refreshControlRef.current!.refresh());
    expect(mocks.getPets).toHaveBeenCalledTimes(1);
    expect(mocks.getAccounts).toHaveBeenCalledTimes(1);
    await click('close');
    await expand('skill');
    expect(container.querySelector('[data-ecosystem-category="pet"]')).toBeNull();
    expect(container.querySelector('[data-ecosystem-category="skill"]')).not.toBeNull();
  });

  it('reuses pets on reopen and focus, and retains the list during an explicit refresh', async () => {
    mocks.getPets.mockResolvedValue(petFixture());
    await render();
    expect(mocks.getPets).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Codex Cat');
    await expand('pet'); await click('close'); await expand('pet');
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(mocks.getPets).toHaveBeenCalledTimes(1);
    let resolveRefresh!: (value: ReturnType<typeof petFixture>) => void;
    mocks.getPets.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    const refresh = container.querySelector<HTMLButtonElement>('[data-ecosystem-category="pet"] button[aria-label="content.refresh"]')!;
    await act(async () => refresh.click());
    expect(mocks.getPets).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Codex Cat');
    expect(refresh.disabled).toBe(true);
    await act(async () => resolveRefresh(petFixture()));
    expect(refresh.disabled).toBe(false);
  });

  it('updates the active pet from settings without rescanning and closes the catalog to manage a copy', async () => {
    const catalog = petFixture();
    catalog.candidates[0].imported = { ...catalog.candidates[0].pet, source: 'user', packagePath: '/native/cat' };
    mocks.getPets.mockResolvedValue(catalog);
    await render(); await expand('pet');
    await act(async () => mocks.petSettingsListener.mock.lastCall![0]({ enable_agent_companion: true, agent_companion_pet: catalog.candidates[0].imported }));
    expect(container.textContent).toContain('content.pets.states.using');
    expect(mocks.getPets).toHaveBeenCalledTimes(1);
    await click('content.manageCopy');
    expect(container.querySelector('[data-ecosystem-category="pet"]')).toBeNull();
    expect(mocks.openDestination).toHaveBeenCalledWith({ pageId: 'application.pet' });
  });

  it('reviews a pet before copying, then offers explicit use without selecting it during import', async () => {
    const catalog = petFixture();
    mocks.getPets.mockResolvedValue(catalog);
    mocks.importPet.mockImplementation(async () => { catalog.candidates[0].imported = { ...catalog.candidates[0].pet, source: 'user', packagePath: '/native/cat' }; return catalog.candidates[0].imported; });
    await render(); await expand('pet');
    expect(container.textContent).toContain('Codex Cat');
    expect(mocks.importPet).not.toHaveBeenCalled();
    await click('content.prepareImport');
    expect(container.querySelectorAll('[role="dialog"]')[1]?.textContent).toContain('content.pets.reviewDescription');
    await click('content.confirm');
    expect(mocks.importPet.mock.calls[0][0].fingerprint).toBe('reviewed-v1');
    expect(mocks.savePetSettings).not.toHaveBeenCalled();
    await click('content.pets.use');
    expect(mocks.savePetSettings).toHaveBeenCalledWith({ agent_companion_pet: expect.objectContaining({ packagePath: '/native/cat' }), enable_agent_companion: true });
  });

  it('includes discovered pets in the ecosystem content total and clears removed sources', async () => {
    const onCounts = vi.fn();
    await render('codex', false, onCounts);
    const baseline = onCounts.mock.lastCall?.[0].codex ?? 0;
    mocks.getPets.mockResolvedValue(petFixture());
    await act(async () => globalEventBus.emit('agent-companion-pets-changed', {}));
    expect(onCounts.mock.lastCall?.[0].codex).toBe(baseline + 1);
    mocks.getPets.mockResolvedValue({ candidates: [], diagnostics: [] });
    await act(async () => globalEventBus.emit('agent-companion-pets-changed', {}));
    expect(onCounts.mock.lastCall?.[0].codex).toBe(baseline);
  });

  it('labels bundled pets and preserves their identity through the review dialog', async () => {
    const catalog = petFixture();
    Object.assign(catalog.candidates[0], { builtinId: 'codex' });
    catalog.candidates[0].pet.packagePath = '/installed/app.asar';
    mocks.getPets.mockResolvedValue(catalog);
    await render(); await expand('pet');
    expect(container.textContent).toContain('content.pets.builtinSource');
    await click('content.prepareImport');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('content.pets.builtinSource');
    await click('content.confirm');
    expect(mocks.importPet).toHaveBeenCalledWith(expect.objectContaining({ builtinId: 'codex', fingerprint: 'reviewed-v1' }));
    expect(mocks.savePetSettings).not.toHaveBeenCalled();
  });

  it('refreshes pet import state after native deletion and retains edited copies', async () => {
    const catalog = petFixture();
    catalog.candidates[0].imported = { ...catalog.candidates[0].pet, source: 'user', packagePath: '/native/cat' };
    catalog.candidates[0].copyModified = true;
    mocks.getPets.mockResolvedValue(catalog);
    await render(); await expand('pet');
    expect(container.textContent).toContain('content.pets.states.copyModified');
    expect(container.textContent).not.toContain('content.prepareImport');
    catalog.candidates[0].imported = null; catalog.candidates[0].copyModified = false;
    await act(async () => globalEventBus.emit('agent-companion-pets-changed', {}));
    expect(container.textContent).toContain('content.pets.states.ready');
    expect(container.textContent).toContain('content.prepareImport');
  });

  it('shows a failed pet confirmation and never selects a disappeared native copy', async () => {
    const catalog = petFixture(); mocks.getPets.mockResolvedValue(catalog);
    mocks.importPet.mockRejectedValue(new Error('Source changed'));
    await render(); await expand('pet'); await click('content.prepareImport'); await click('content.confirm');
    expect(container.textContent).toContain('content.pets.operationFailed');
    expect(mocks.savePetSettings).not.toHaveBeenCalled();
    catalog.candidates[0].imported = { ...catalog.candidates[0].pet, source: 'user', packagePath: '/native/cat' };
    await act(async () => globalEventBus.emit('agent-companion-pets-changed', {}));
    mocks.getPets.mockResolvedValue(petFixture());
    await click('content.pets.use');
    expect(mocks.savePetSettings).not.toHaveBeenCalled();
  });

  it('does not load local pets in an unsupported context or another ecosystem', async () => {
    mocks.peer = true; await render(); await expand('pet');
    expect(mocks.getPets).not.toHaveBeenCalled();
    expect(container.textContent).toContain('content.pets.states.unsupported');
    mocks.peer = false; await render('claude-code');
    expect(mocks.getPets).not.toHaveBeenCalled();
  });

  it('keeps copy management on imported rows without category management links', async () => {
    data.plan.items[0].disposition = 'already_imported';
    await render();
    expect(container.textContent).not.toContain('content.manageNative');
    await click('content.manageCopy', 'mcp');
    expect(mocks.openDestination).toHaveBeenCalledWith({ pageId: 'tools.mcp' });
    expect(mocks.openScene).toHaveBeenCalledWith('settings');
    expect(container.querySelector('[data-ecosystem-category]')).toBeNull();
  });

  it('opens category content in a dialog and returns to that list after inspecting an item', async () => {
    await render();
    const overview = container.querySelector('.ecosystem-compatibility__content-overview')!;
    expect(overview.querySelector('[data-import-kind]')).toBeNull();
    await expand('mcp');
    const catalog = container.querySelector('[role="dialog"][data-ecosystem-category="mcp"]')!;
    expect(catalog.querySelector('[data-import-kind="mcp"]')).not.toBeNull();
    expect(overview.querySelector('[data-import-kind]')).toBeNull();

    await click('content.view', 'mcp');
    const detail = container.querySelector('[role="dialog"]:not([data-ecosystem-category])')!;
    expect(detail.textContent).toContain('docs-server');
    await act(async () => detail.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.querySelector('[data-ecosystem-category="mcp"]')).toBe(catalog);
    expect(mocks.applyMcp).not.toHaveBeenCalled();

    await act(async () => catalog.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.querySelector('[data-ecosystem-category]')).toBeNull();
    expect(overview.querySelector('[data-import-kind]')).toBeNull();
  });

  it.each([
    ['codex', 'subagent'], ['codex', 'mcp'], ['codex', 'skill'], ['codex', 'hook'], ['claude-code', 'command'],
  ] as const)('shows an empty %s %s category without list controls or placeholder rows', async (product, category) => {
    data.snapshot.mcpServers = [];
    data.skills = [];
    data.hooks.catalog.sources = [];
    data.hooks.catalog.entries = [];
    await render(product); await expand(category);
    const dialog = container.querySelector(`[data-ecosystem-category="${category}"]`)!;
    expect(dialog.querySelector('[data-content-empty-state="notDetected"] p')?.textContent).toBe('import.states.notDetected');
    const scanButton = dialog.querySelector<HTMLButtonElement>('[data-content-empty-state] button');
    expect(scanButton?.textContent).toBe('content.scan');
    expect(scanButton?.disabled).toBe(false);
    expect(dialog.querySelector('[role="table"], [role="columnheader"], [data-import-kind], input')).toBeNull();
    expect(dialog.textContent).not.toMatch(/content\.(importCategory|importSelected|undoSelected|selectedCount|noMatches)/);
    expect(dialog.querySelector('button[aria-label="content.refresh"]')).not.toBeNull();
    expect(container.querySelector(`[data-content-group="${category}"]`)).not.toBeNull();
  });

  it('keeps search and selection recoverable when real content has no matches', async () => {
    await render(); await expand('skill');
    const dialog = container.querySelector('[data-ecosystem-category="skill"]')!;
    const checkbox = dialog.querySelector<HTMLInputElement>('[data-import-kind] input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    const searchInput = dialog.querySelector<HTMLInputElement>('input[aria-label="content.search"]')!;
    async function searchFor(value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput, value);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await searchFor('no matching item');
    expect(dialog.querySelector('[data-content-empty-state="noMatches"]')?.textContent).toBe('content.noMatches');
    expect(dialog.querySelector('[data-content-empty-state] button')).toBeNull();
    expect(dialog.querySelector('[role="table"], [role="columnheader"], input[type="checkbox"]')).toBeNull();
    expect(dialog.textContent).not.toMatch(/content\.(importCategory|importSelected|undoSelected|selectedCount)/);
    expect(dialog.querySelector('input[aria-label="content.search"]')).toBe(searchInput);

    await searchFor('');
    expect(dialog.querySelector('[data-content-empty-state]')).toBeNull();
    expect(dialog.querySelector('[data-import-kind="skill"]')?.textContent).toContain('codex-Skill');
    expect(dialog.querySelector<HTMLInputElement>('[data-import-kind] input[type="checkbox"]')?.checked).toBe(true);
  });

  it.each(['failed', 'disabled'])('distinguishes a %s scan from a completed empty scan', async (state) => {
    data.snapshot.mcpServers = [];
    if (state === 'disabled') data.snapshot.integrationPolicy.effective.enabled = false;
    await render('codex', state === 'failed'); await expand('mcp');
    const dialog = container.querySelector('[data-ecosystem-category="mcp"]')!;
    const expectedState = state === 'failed' ? 'discoveryUnavailable' : 'discoveryDisabled';
    expect(dialog.querySelector(`[data-content-empty-state="${expectedState}"] p`)?.textContent).toBe(`import.states.${expectedState}`);
    expect(dialog.querySelector('[data-content-empty-state] button')?.textContent).toBe(state === 'failed' ? 'content.scan' : undefined);
    expect(dialog.querySelector('[role="table"], [data-import-kind], input')).toBeNull();
  });

  it('does not label a completed category as loading while supplemental discovery is pending', async () => {
    mocks.getSkills.mockImplementation(() => new Promise(() => {}));
    await render(); await expand('subagent');
    const dialog = container.querySelector('[data-ecosystem-category="subagent"]')!;
    expect(dialog.querySelector('[data-content-empty-state="notDetected"]')).not.toBeNull();
    expect(dialog.textContent).not.toContain('loading');
    expect(dialog.textContent).not.toContain('import.states.checking');
  });

  it('shows instruction ownership, scope and path matching without copy controls', async () => {
    mocks.getInstructions.mockResolvedValue({ schemaVersion: 1, failedEcosystems: [], entries: [
      { ecosystemId: 'codex', name: 'Codex user rules', path: '/user/AGENTS.md', scope: 'user', pathPatterns: [] },
      { ecosystemId: 'claude-code', name: 'Claude path rule', path: '/project/.claude/rules/api.md', scope: 'project', pathPatterns: ['src/**/*.ts'] },
      { ecosystemId: 'shared', name: 'AGENTS.md', path: '/project/AGENTS.md', scope: 'project', pathPatterns: [] },
    ] });
    await render(); await expand('instruction');
    expect(container.textContent).toContain('Codex user rules');
    expect(container.textContent).toContain('content.instructions.shared');
    expect(container.textContent).not.toContain('Claude path rule');
    const rows = container.querySelectorAll('[data-import-kind="instruction"]');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.getAttribute('data-import-state')).toBe('discovered');
      expect(row.querySelector('input[type="checkbox"]')).toBeNull();
      expect(row.textContent).not.toContain('content.prepareImport');
      expect(row.textContent).not.toContain('content.undo');
    }
    await render('claude-code'); await expand('instruction');
    await click('content.view', 'instruction');
    expect(container.querySelector('[role="dialog"]:not([data-ecosystem-category])')?.textContent).toContain('src/**/*.ts');
    expect(container.querySelector('[role="dialog"]:not([data-ecosystem-category])')?.textContent).toContain('content.instructions.conditional');
    expect(mocks.applyMcp).not.toHaveBeenCalled();
  });

  it.each(['remote', 'peer'] as const)('does not substitute local instruction sources on a %s surface', async (surface) => {
    mocks[surface] = true;
    await render(); await expand('instruction');
    expect(mocks.getInstructions).not.toHaveBeenCalled();
    expect(container.querySelector('[data-content-empty-state="discoveryUnavailable"]')).not.toBeNull();
    expect(container.textContent).toContain('content.instructions.unsupportedHost');
  });

  it('shows a legacy host failure and recovers instruction discovery on refresh', async () => {
    mocks.getInstructions.mockRejectedValueOnce(new Error('Unknown command'));
    await render(); await expand('instruction');
    expect(container.querySelector('[data-content-empty-state="discoveryUnavailable"]')).not.toBeNull();
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="content.refresh"]')!;
    await act(async () => refresh.click());
    expect(container.querySelector('[data-content-empty-state="notDetected"]')).not.toBeNull();
  });

  it('clears a local instruction detail when switching to a peer', async () => {
    mocks.getInstructions.mockResolvedValue({ schemaVersion: 1, failedEcosystems: [], entries: [
      { ecosystemId: 'codex', name: 'Local rules', path: '/private/local/AGENTS.md', scope: 'user', pathPatterns: [] },
    ] });
    await render(); await expand('instruction'); await click('content.view', 'instruction');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('/private/local/AGENTS.md');
    mocks.peer = true;
    await render();
    expect(container.textContent).not.toContain('/private/local/AGENTS.md');
    expect(container.querySelector('[role="dialog"]:not([data-ecosystem-category])')).toBeNull();
    expect(mocks.getInstructions).toHaveBeenCalledTimes(1);
  });

  it.each(['cursor'] as const)('exposes %s Skills with default enabled switches and no copy actions', async (sourceId) => {
    data.skills.push({ ...data.skills[0], key: `project::${sourceId}::shared`, sourceId, path: `/${sourceId}/shared` });
    await render(sourceId); await expand('skill');
    const row = container.querySelector('[data-import-kind="skill"]')!;
    expect(row.textContent).toContain(`/${sourceId}/shared`);
    expect(row.querySelector<HTMLInputElement>('[role="switch"]')?.checked).toBe(true);
    expect(row.querySelector<HTMLInputElement>('[role="switch"]')?.disabled).toBe(false);
    expect(row.textContent).not.toContain('content.prepareImport');
    expect(row.textContent).not.toContain('content.undo');
    expect(mocks.addSkill).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('content.skills.directUse');
  });

  it('persists a project switch and reads it back after returning to the ecosystem', async () => {
    data.skills[0].level = 'project';
    const disabled = { directSkillManagementVersion: 1, globallyDisabledUserSkillKeys: [], globallyDisabledProjectSkillKeys: [data.skills[0].key] };
    mocks.setSkillDisabled.mockResolvedValue(disabled);
    await render(); await expand('skill');
    await act(async () => container.querySelector<HTMLInputElement>('[role="switch"]')!.click());
    expect(mocks.setSkillDisabled).toHaveBeenCalledWith({ skillKey: data.skills[0].key, disabled: true, workspaceId: 'workspace-id' });
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(false);
    expect(container.querySelector('[data-import-kind="skill"]')?.getAttribute('data-import-state')).toBe('disabled');
    mocks.getSkillSettings.mockResolvedValue(disabled);
    await render('claude-code'); await render(); await expand('skill');
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(false);
    expect(mocks.deleteSkill).not.toHaveBeenCalled();
  });

  it('updates availability changed in the Skill library without rescanning content', async () => {
    await render(); await expand('skill');
    const scanCount = mocks.getSkills.mock.calls.length;
    mocks.getSkillSettings.mockResolvedValue({ directSkillManagementVersion: 1, globallyDisabledUserSkillKeys: [data.skills[0].key], globallyDisabledProjectSkillKeys: [] });
    await act(async () => globalEventBus.emit('mode:config:updated'));
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(false);
    expect(mocks.getSkills).toHaveBeenCalledTimes(scanCount);
  });

  it('keeps a failed switch change retryable without displaying false success', async () => {
    mocks.setSkillDisabled.mockRejectedValue(new Error('Write failed'));
    await render(); await expand('skill');
    await act(async () => container.querySelector<HTMLInputElement>('[role="switch"]')!.click());
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(true);
    expect(container.textContent).toContain('content.skills.updateFailed');
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(false);
  });

  it('does not let an older discovery response overwrite a completed switch change', async () => {
    await render(); await expand('skill');
    let finish!: (value: unknown) => void;
    mocks.getSkillSettings.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="content.refresh"]')!.click());
    mocks.setSkillDisabled.mockResolvedValue({ directSkillManagementVersion: 1, globallyDisabledUserSkillKeys: [data.skills[0].key], globallyDisabledProjectSkillKeys: [] });
    await act(async () => container.querySelector<HTMLInputElement>('[role="switch"]')!.click());
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(false);
    await act(async () => finish({ directSkillManagementVersion: 1, globallyDisabledUserSkillKeys: [], globallyDisabledProjectSkillKeys: [] }));
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(false);
  });

  it.each(['legacy', 'peer', 'remote'] as const)('keeps Skills visible but gates switches for a %s host', async (host) => {
    mocks.peer = host === 'peer'; mocks.remote = host === 'remote';
    if (host === 'legacy') mocks.getSkillSettings.mockResolvedValue({ globallyDisabledUserSkillKeys: [] });
    await render(); await expand('skill');
    expect(container.textContent).toContain('codex-Skill');
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(true);
    expect(container.textContent).toContain('content.skills.unsupported');
    expect(mocks.setSkillDisabled).not.toHaveBeenCalled();
    expect(mocks.addSkill).not.toHaveBeenCalled();
  });

  it('preserves existing native copies while managing their source independently', async () => {
    data.skills.push({ ...data.skills[0], key: 'native-copy', sourceId: 'openbitfun', path: '/native/copy' });
    await render(); await expand('skill');
    expect(container.querySelectorAll('[data-import-kind="skill"]')).toHaveLength(1);
    expect(container.querySelector('[data-import-kind="skill"]')?.getAttribute('data-import-state')).toBe('available');
    expect(mocks.deleteSkill).not.toHaveBeenCalled();
  });

  it('ignores a switch response after changing workspaces', async () => {
    let finish!: (value: unknown) => void;
    mocks.setSkillDisabled.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render(); await expand('skill');
    await act(async () => container.querySelector<HTMLInputElement>('[role="switch"]')!.click());
    mocks.workspacePath = '/other-project'; mocks.workspaceId = 'other-workspace-id';
    await render(); await expand('skill');
    await act(async () => finish({ directSkillManagementVersion: 1, globallyDisabledUserSkillKeys: [], globallyDisabledProjectSkillKeys: [data.skills[0].key] }));
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(true);
  });

  it('reviews MCP and Hooks without copying Skills in a full agent batch', async () => {
    mocks.skillImportVersion = 1;
    await render();
    await click('content.importAll');
    expect(mocks.addSkill).not.toHaveBeenCalled();
    expect(mocks.applyMcp).not.toHaveBeenCalled();
    expect(mocks.applyHook).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]:not([data-ecosystem-category])')?.textContent).toContain('echo reviewed-command');
    await click('content.confirm');
    expect(mocks.addSkill).not.toHaveBeenCalled();
    expect(mocks.applyMcp.mock.calls[0][2]).toEqual([{ candidateId: 'codex' }]);
    expect(mocks.applyHook).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('content.batchResults');
  });

  it('groups the review by type and advances progress only when an operation settles', async () => {
    mocks.skillImportVersion = 1;
    let finishMcp!: (value: unknown) => void;
    let failHook!: (error: Error) => void;
    mocks.applyMcp.mockImplementation(() => new Promise((resolve) => { finishMcp = resolve; }));
    mocks.applyHook.mockImplementation(() => new Promise((_resolve, reject) => { failHook = reject; }));
    await render(); await click('content.importAll');
    const dialog = container.querySelector('[role="dialog"]:not([data-ecosystem-category])')!;
    expect([...dialog.querySelectorAll('.ecosystem-compatibility__batch-group')].map((group) => group.getAttribute('aria-label'))).toEqual(['capabilities.mcp', 'capabilities.hook']);
    expect(dialog.querySelector('progress')).toBeNull();
    await click('content.confirm');
    const progress = dialog.querySelector('progress')!;
    expect(progress.max).toBe(2); expect(progress.value).toBe(0);
    await act(async () => finishMcp({ outcome: { status: 'applied' } }));
    expect(progress.value).toBe(1);
    expect(dialog.textContent).toContain('content.batchPending');
    await act(async () => failHook(new Error('Copy permission denied')));
    expect(progress.value).toBe(2);
    expect(dialog.textContent).toContain('Copy permission denied');
    expect(dialog.textContent).toContain('content.batchState.failed');
    expect(dialog.textContent).not.toContain('content.batchPending');
  });

  it('starts with compact categories and mounts only the expanded category', async () => {
    await render();
    expect(container.querySelectorAll('[data-content-group]').length).toBeGreaterThan(2);
    expect(container.querySelectorAll('[data-import-kind]')).toHaveLength(0);
    const overview = container.querySelector('.ecosystem-compatibility__content-overview')!;
    expect(overview.querySelectorAll('[role="columnheader"]')).toHaveLength(3);
    expect(overview.textContent).toContain('import.columns.state');
    expect(overview.querySelector('[data-content-group="skill"] [data-icon]')).not.toBeNull();
    expect(overview.querySelector('[data-content-group="skill"]')?.textContent).toContain('content.itemCount');
    expect(overview.querySelector('[data-content-group="account"] button[aria-expanded]')).not.toBeNull();
    await expand('skill');
    expect(container.textContent).toContain('codex-Skill');
    expect(container.textContent).not.toContain('codex-MCP');
    await expand('mcp');
    expect(container.textContent).not.toContain('codex-Skill');
    expect(container.textContent).toContain('codex-MCP');
  });

  it('shows only the selected agent’s content and makes no import on discovery or inspection', async () => {
    await render();
    await expand('skill'); expect(container.textContent).toContain('codex-Skill'); await expand('hook'); expect(container.textContent).toContain('codex-Hooks'); await expand('mcp'); expect(container.textContent).toContain('codex-MCP');
    expect(container.textContent).not.toContain('claude-code-Skill'); expect(container.textContent).not.toContain('claude-code-MCP'); expect(container.textContent).not.toContain('claude-code-Hooks'); expect(container.textContent).not.toContain('openbitfun-Skill');
    await click('content.view', 'mcp');
    expect(container.textContent).toContain('docs-server');
    expect(mocks.applyMcp).not.toHaveBeenCalled(); expect(mocks.addSkill).not.toHaveBeenCalled(); expect(mocks.applyHook).not.toHaveBeenCalled();
    await render('claude-code');
    expect(container.querySelector('[role="dialog"]:not([data-ecosystem-category])')).toBeNull();
    await expand('skill'); expect(container.textContent).not.toContain('codex-Skill'); expect(container.textContent).toContain('claude-code-Skill');
  });

  it('requires a second explicit confirmation and sends only the selected MCP candidate', async () => {
    mocks.applyMcp.mockImplementationOnce(async () => {
      mocks.planMcp.mockResolvedValue({
        ...data.plan,
        items: data.plan.items.map((item) => item.candidateId === 'codex'
          ? { ...item, disposition: 'already_imported' }
          : item),
      });
      return { outcome: { status: 'applied' } };
    });
    await render(); await click('content.prepareImport', 'mcp');
    expect(mocks.applyMcp).not.toHaveBeenCalled();
    await click('content.confirm');
    expect(mocks.applyMcp).toHaveBeenCalledWith('workspace-id', data.plan, [{ candidateId: 'codex' }]);
    expect(container.querySelector('[data-import-kind="mcp"]')?.getAttribute('data-import-state')).toBe('imported');
  });

  it('cancels without copying and rejects an updated MCP plan until reviewed again', async () => {
    await render(); await click('content.prepareImport', 'mcp'); await click('content.cancel');
    expect(mocks.applyMcp).not.toHaveBeenCalled();
    const refreshed = { ...data.plan, planFingerprint: 'v2', items: [{ ...data.plan.items[0], disposition: 'unavailable' }] };
    mocks.applyMcp.mockResolvedValueOnce({ outcome: { status: 'stale', refreshedPlan: refreshed } });
    await click('content.prepareImport', 'mcp'); await click('content.confirm');
    expect(container.textContent).toContain('content.stale');
    const confirm = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'content.confirm');
    expect(confirm?.disabled).toBe(true);
    expect(mocks.applyMcp).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['single', 'notification'], ['single', 'refresh'], ['batch', 'notification'], ['batch', 'refresh'],
  ])('reconciles a %s MCP import deleted in native management through %s', async (mode, trigger) => {
    mocks.skillImportVersion = 3;
    mocks.planMcp.mockImplementation(async () => structuredClone(data.plan));
    mocks.applyMcp.mockImplementation(async () => {
      data.plan.items[0].disposition = 'already_imported';
      return { outcome: { status: 'applied' } };
    });
    await render();
    if (mode === 'single') await click('content.prepareImport', 'mcp');
    else await click('content.importAll');
    await click('content.confirm');
    if (mode === 'batch') await click('content.close');
    await expand('mcp');
    const row = () => container.querySelector('[data-import-kind="mcp"]')!;
    expect(row().getAttribute('data-import-state')).toBe('imported');
    const calls = mocks.planMcp.mock.calls.length;
    const generation = data.snapshot.generation;
    data.plan.items[0].disposition = 'eligible';
    if (trigger === 'notification') {
      await act(async () => globalEventBus.emit(MCP_CONFIG_CHANGED, { surfaceId: 'local' }));
    } else {
      const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="content.refresh"]')!;
      await act(async () => refresh.click());
    }
    expect(data.snapshot.generation).toBe(generation);
    expect(mocks.planMcp.mock.calls.length).toBeGreaterThan(calls);
    expect(row().getAttribute('data-import-state')).toBe('ready');
    expect(row().textContent).toContain('content.prepareImport');
    expect(row().textContent).not.toContain('content.undo');
    expect(row().textContent).not.toContain('content.manageCopy');
    expect(mocks.saveMcp).not.toHaveBeenCalled();
  });

  it('ignores changes on another host and old MCP plan responses after deletion', async () => {
    data.plan.items[0].disposition = 'already_imported';
    mocks.planMcp.mockImplementation(async () => structuredClone(data.plan));
    await render(); await expand('mcp');
    const calls = mocks.planMcp.mock.calls.length;
    await act(async () => globalEventBus.emit(MCP_CONFIG_CHANGED, { surfaceId: 'another-device' }));
    expect(mocks.planMcp).toHaveBeenCalledTimes(calls);
    const stale = structuredClone(data.plan);
    let finish!: (plan: typeof data.plan) => void;
    mocks.planMcp.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => globalEventBus.emit(MCP_CONFIG_CHANGED, { surfaceId: 'local' }));
    data.plan.items[0].disposition = 'eligible';
    await act(async () => globalEventBus.emit(MCP_CONFIG_CHANGED, { surfaceId: 'local' }));
    await act(async () => finish(stale));
    expect(container.querySelector('[data-import-kind="mcp"]')?.getAttribute('data-import-state')).toBe('ready');
  });

  it('does not offer another import when the native MCP read-back fails after saving', async () => {
    await render(); await click('content.prepareImport', 'mcp');
    mocks.planMcp.mockRejectedValue(new Error('Native configuration unavailable'));
    await click('content.confirm');
    const row = container.querySelector('[data-import-kind="mcp"]')!;
    expect(mocks.applyMcp).toHaveBeenCalledOnce();
    expect(row.getAttribute('data-import-state')).toBe('unavailable');
    expect(row.textContent).not.toContain('content.prepareImport');
    expect(row.textContent).not.toContain('content.undo');
  });

  it('withdraws import actions when the latest external catalog read failed', async () => {
    await render();
    await render('codex', true); await expand('mcp');
    const row = container.querySelector('[data-import-kind="mcp"]');
    expect(row?.getAttribute('data-import-state')).toBe('discovered');
    expect(row?.textContent).not.toContain('content.prepareImport');
    expect(mocks.applyMcp).not.toHaveBeenCalled();
  });

  it('shows the exact Hook commands and applies only the reviewed external source', async () => {
    await render(); await click('content.prepareImport', 'hook');
    expect(mocks.planHook).toHaveBeenCalledWith('workspace-id', data.hookPlan.source.key);
    expect(container.textContent).toContain('echo reviewed-command'); expect(mocks.applyHook).not.toHaveBeenCalled();
    await click('content.confirm'); expect(mocks.applyHook).toHaveBeenCalledWith('workspace-id', data.hookPlan);
  });

  it('rejects a Hook preview for a different agent instead of showing or applying it', async () => {
    mocks.planHook.mockResolvedValue({ ...data.hookPlan, source: data.hooks.catalog.sources[1] });
    await render(); await click('content.prepareImport', 'hook');
    expect(container.querySelector('[role="dialog"]:not([data-ecosystem-category])')).toBeNull();
    expect(container.textContent).toContain('content.previewFailed');
    expect(mocks.applyHook).not.toHaveBeenCalled();
  });

  it.each(['pi', 'dsh'] as const)('keeps %s hook declarations visible without copy actions', async (product) => {
    const ecosystemId = product === 'dsh' ? 'deepseek-harness' : 'pi';
    data.hooks.catalog.sources[0].ecosystemId = ecosystemId;
    await render(product); await expand('hook');
    const row = container.querySelector('[data-import-kind="hook"]')!;
    expect(row.getAttribute('data-import-state')).toBe('discovered');
    expect(row.textContent).toContain('content.hookDiscoveryOnly');
    expect(row.textContent).not.toContain('content.prepareImport');
    expect(container.querySelector('[data-content-group="hook"]')?.textContent).not.toContain('content.importCategory');
    expect(mocks.planHook).not.toHaveBeenCalled();
  });

  it('distinguishes a disabled scan from a legacy snapshot without policy facts', async () => {
    data.snapshot.integrationPolicy.effective.enabled = false;
    await render(); await expand('mcp');
    expect(container.querySelector('[data-import-kind="mcp"]')?.getAttribute('data-import-state')).toBe('discoveryDisabled');
    expect(container.querySelector('[data-content-empty-state]')).toBeNull();
    Object.assign(data.snapshot.integrationPolicy, { effective: undefined });
    await render();
    expect(container.querySelector('[data-import-kind="mcp"]')?.getAttribute('data-import-state')).toBe('discovered');
  });

  it('shows direct command availability independently of copy import and same-name selection', async () => {
    data.snapshot.hostCapabilities.canExecuteExternalAssets = true;
    data.snapshot.commands = [{ candidateId: 'command-1', definition: {
      id: { source: data.snapshot.sources[1].record.key, localId: 'review' }, name: 'review',
      description: 'Review changes', contentVersion: 'v1', availability: { state: 'available' },
    } }];
    await render('claude-code'); await expand('command');
    const row = () => container.querySelector('[data-import-kind="command"]')!;
    expect(row().getAttribute('data-import-state')).toBe('available');
    expect(row().textContent).toContain('content.directUse.available');
    expect(row().textContent).not.toContain('content.prepareImport');
    data.snapshot.commandConflicts = [{ conflictKey: 'review', commandName: 'review', candidates: [] }];
    await render('claude-code');
    expect(row().getAttribute('data-import-state')).toBe('conflict');
    data.snapshot.commandConflicts[0].selectedCandidateId = 'command-1';
    await render('claude-code');
    expect(row().getAttribute('data-import-state')).toBe('available');
    data.snapshot.integrationPolicy.effective.ecosystems['claude-code'].capabilities.command = 'discover_only';
    await render('claude-code');
    expect(row().getAttribute('data-import-state')).toBe('disabled');
  });

  it('shows unknown usage for a legacy host without execution capability facts', async () => {
    data.snapshot.commands = [{ definition: {
      id: { source: data.snapshot.sources[1].record.key, localId: 'review' }, name: 'review',
      description: '', contentVersion: 'v1', availability: { state: 'available' },
    } }];
    await render('claude-code'); await expand('command');
    expect(container.querySelector('[data-import-kind="command"]')?.getAttribute('data-import-state')).toBe('discovered');
    expect(container.textContent).toContain('content.directUse.unknown');
  });

  it('keeps a cached candidate inspectable and explains the stale result', async () => {
    await render('codex', true); await expand('mcp');
    expect(container.querySelector('[data-import-kind="mcp"]')?.getAttribute('data-import-state')).toBe('discovered');
    expect(container.querySelector('[data-import-kind="mcp"]')?.textContent).not.toContain('content.prepareImport');
  });

  it('keeps directly usable Skills visible while external Hook and MCP discovery is paused', async () => {
    data.snapshot.discovery = { enabled: false, canChange: true, hasScanned: true, preferenceRevision: 1 };
    await render();
    expect(mocks.getSkills).toHaveBeenCalledOnce();
    expect(mocks.getHooks).not.toHaveBeenCalled();
    expect(mocks.planMcp).not.toHaveBeenCalled();
    await expand('mcp');
    expect(container.querySelector('[data-import-kind="mcp"]')?.getAttribute('data-import-state')).toBe('review');
    await click('content.prepareImport', 'mcp');
    expect(mocks.planMcp).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]:not([data-ecosystem-category])')).not.toBeNull();
    expect(mocks.applyMcp).not.toHaveBeenCalled();
    expect(data.snapshot.discovery.enabled).toBe(false);
  });

  it('finishes an explicit Hook refresh while automatic discovery remains paused', async () => {
    vi.useFakeTimers();
    try {
      data.snapshot.discovery = { enabled: false, canChange: true, hasScanned: true, preferenceRevision: 1 };
      mocks.getHooks.mockResolvedValueOnce({ ...data.hooks, catalog: { ...data.hooks.catalog, discoveryPending: true, sources: [], entries: [] } })
        .mockResolvedValue(data.hooks);
      await render();
      await expand('hook');
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="content.refresh"]')!.click());
      expect(mocks.getHooks).toHaveBeenCalledWith('workspace-id', true);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(mocks.getHooks).toHaveBeenLastCalledWith('workspace-id', false);
      await expand('hook');
      expect(container.textContent).toContain('codex-Hooks');
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(mocks.getHooks).toHaveBeenCalledTimes(2);
      expect(data.snapshot.discovery.enabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('does not label an imported MCP copy as connected or usable', async () => {
    data.plan.items[0].disposition = 'already_imported';
    await render(); await expand('mcp');
    const row = container.querySelector('[data-import-kind="mcp"]')!;
    expect(row.getAttribute('data-import-state')).toBe('imported');
    expect(row.textContent).toContain('content.mcpImportedDescription');
    expect(row.textContent).not.toContain('import.states.available');
  });

  it.each(['remote', 'peer'] as const)('keeps %s source previews but gates unsupported imports without a local fallback', async (surface) => {
    mocks[surface] = true;
    mocks.skillImportVersion = 3;
    await render(); await expand('skill');
    expect(container.textContent).toContain('codex-Skill');
    expect(container.textContent).not.toContain('content.prepareImport');
    expect(container.textContent).not.toContain('content.manageNative');
    expect(mocks.validateSkill).not.toHaveBeenCalled();
    expect(mocks.planMcp).not.toHaveBeenCalled(); expect(mocks.getHooks).not.toHaveBeenCalled();
    expect(mocks.getHookCatalog).toHaveBeenCalledWith('workspace-id', false);
    expect(mocks.addSkill).not.toHaveBeenCalled(); expect(mocks.applyMcp).not.toHaveBeenCalled();
  });

  it('can cancel undo, then removes only the imported MCP copy after confirmation', async () => {
    data.plan.items[0].disposition = 'already_imported';
    await render(); await click('content.undo', 'mcp');
    expect(container.textContent).toContain('content.undoWarning');
    expect(mocks.saveMcp).not.toHaveBeenCalled();
    await click('content.cancel');
    expect(mocks.saveMcp).not.toHaveBeenCalled();
    await click('content.undo', 'mcp'); await click('content.confirmUndo');
    expect(mocks.saveMcp).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.saveMcp.mock.calls[0][0])).toEqual({ mcpServers: { keep: { command: 'keep' } } });
    expect(mocks.saveMcp.mock.calls[0][1]).toBe('native-v1');
  });

  it('releases the UI after undo commits while the refreshed import plan is still pending', async () => {
    data.plan.items[0].disposition = 'already_imported';
    await render(); await click('content.undo', 'mcp');
    let finishPlan!: (plan: typeof data.plan) => void;
    mocks.planMcp.mockImplementationOnce(() => new Promise(resolve => { finishPlan = resolve; }));
    await click('content.confirmUndo');
    expect(mocks.saveMcp).toHaveBeenCalledTimes(1);
    const view = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-import-kind="mcp"] button')).find(button => button.textContent === 'content.view');
    expect(view?.disabled).toBe(false);
    expect(container.querySelector('[role="dialog"]:not([data-ecosystem-category])')).toBeNull();
    data.plan.items[0].disposition = 'eligible';
    await act(async () => { finishPlan(data.plan); });
    expect(container.querySelector('[data-import-kind="mcp"]')?.getAttribute('data-import-state')).toBe('ready');
  });

  it('retains import state after a failed undo and requires a new review', async () => {
    data.plan.items[0].disposition = 'already_imported';
    mocks.saveMcp.mockRejectedValue(new Error('stale'));
    await render(); await click('content.undo', 'mcp'); await click('content.confirmUndo');
    expect(container.textContent).toContain('content.undoFailed');
    expect(container.querySelector('[role="dialog"]:not([data-ecosystem-category]) [role="alert"]')?.textContent).toContain('stale');
    expect(container.querySelector('[data-import-kind="mcp"]')?.getAttribute('data-import-state')).toBe('imported');
    expect(mocks.saveMcp).toHaveBeenCalledTimes(1);
  });

  it('removes only the selected Hook import using its reviewed revision', async () => {
    const imported = { ...data.hooks, imports: [{ importId: 'codex-hook-copy', source: data.hookPlan.source, enabled: true, behaviorVersion: 'v1', state: 'current' }] };
    mocks.getHooks.mockResolvedValue(imported);
    await render(); await click('content.undo', 'hook');
    expect(mocks.mutateHook).not.toHaveBeenCalled();
    await click('content.confirmUndo');
    expect(mocks.mutateHook).toHaveBeenCalledWith('workspace-id', 'r1', { kind: 'remove', importId: 'codex-hook-copy' });
  });

});
