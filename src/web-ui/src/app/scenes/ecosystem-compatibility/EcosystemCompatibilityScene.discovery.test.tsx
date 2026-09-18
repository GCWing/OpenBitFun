// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSourceCatalogSnapshot, ExternalMcpImportPlanV1 } from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import { clearEcosystemDiscoveryCache } from './ecosystemDiscoveryCache';
import { catalogDiscoveryState } from './ecosystemCompatibilityModel';

const mocks = vi.hoisted(() => ({
  getDiscoverySnapshot: vi.fn(),
  setAutomaticDiscovery: vi.fn(),
  planMcpImport: vi.fn<() => Promise<ExternalMcpImportPlanV1>>(),
  applyMcpImport: vi.fn(),
  ownerSurface: null as string | null,
  selectedProductId: 'codex',
  setOwnerSurface: vi.fn(),
  workspaceId: 'workspace-a' as string | null,
  workspacePath: '/workspace',
  peerDeviceId: '',
  skills: [] as Array<Record<string, unknown>>,
  t: (key: string, values?: Record<string, unknown>) => key === 'productSummary.assets' ? `assets:${values?.count}` : key,
}));
vi.mock('@/infrastructure/api/service-api/ExternalSourcesAPI', () => ({ externalSourcesAPI: mocks }));
vi.mock('@/infrastructure/api/service-api/ACPClientAPI', () => ({ ACPClientAPI: { getClients: async () => [] } }));
// The workspace is identified by its ID; the path is only the IO projection.
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useCurrentWorkspace: () => (mocks.workspaceId
  ? { workspacePath: mocks.workspacePath, workspace: { id: mocks.workspaceId, name: 'Workspace', rootPath: mocks.workspacePath, workspaceKind: 'normal' } }
  : { workspacePath: '', workspace: null }) }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: mocks.t, formatNumber: String }) }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({ usePeerDeviceModeOptional: () => mocks.peerDeviceId ? ({ peerMode: { active: true, deviceId: mocks.peerDeviceId } }) : null }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('./ecosystemCompatibilityStore', () => ({
  useEcosystemCompatibilityStore: (select: (value: unknown) => unknown) => select({
    selectedProductId: mocks.selectedProductId, ownerSurface: mocks.ownerSurface, setOwnerSurface: mocks.setOwnerSurface,
  }),
}));
vi.mock('@openbitfun/ui', async () => {
  const { createElement, forwardRef } = await import('react');
  const { Alert, Switch, Tooltip } = await vi.importActual<typeof import('@openbitfun/ui')>('@openbitfun/ui');
  const Wrapper = forwardRef<HTMLDivElement, { children?: React.ReactNode }>(
    ({ children }, ref) => createElement('div', { ref }, children),
  );
  return {
    Alert,
    ...Object.fromEntries(['LoadingState', 'NavigationPanel', 'NavigationPanelBody', 'NavigationPanelContent',
      'NavigationPanelFooter', 'NavigationPanelHeader', 'NavigationPanelSection',
      'OverflowText', 'ScrollArea', 'SearchField', 'Select', 'StatusPill', 'Textarea', 'DialogBody', 'DialogFooter', 'DialogHeader', 'DialogHeaderActions', 'DialogDescription', 'DialogHeading', 'DialogTitle'].map((name) => [name, Wrapper])),
    Switch, Tooltip,
    NavigationPanelItem: ({ children, title, 'data-product-id': productId }: React.HTMLAttributes<HTMLDivElement> & { 'data-product-id'?: string }) => createElement('div', { title, 'data-product-id': productId }, children),
    IconButton: ({ icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.ReactNode }) => createElement('button', props, icon),
    Checkbox: ({ size: _size, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => createElement('input', { type: 'checkbox', ...props }),
    Icon: () => null, DialogClose: () => null,
    Dialog: ({ open, children, 'data-ecosystem-category': category }: { open: boolean; children?: React.ReactNode; 'data-ecosystem-category'?: string }) => open ? createElement('div', { role: 'dialog', 'data-ecosystem-category': category }, children) : null,
    Button: ({ children, onClick, disabled, 'aria-label': label }: React.ButtonHTMLAttributes<HTMLButtonElement>) => createElement('button', { onClick, disabled, 'aria-label': label }, children),
  };
});

vi.mock('@/infrastructure/config/services/AgentCompanionPetService', () => ({
  listExternalAgentCompanionPets: async () => ({ candidates: [], diagnostics: [] }),
  AGENT_COMPANION_PETS_CHANGED: 'agent-companion-pets-changed',
}));
vi.mock('@/infrastructure/config/services/AIExperienceConfigService', () => ({ aiExperienceConfigService: {
  addChangeListener: () => () => {},
} }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { getGlobalSkillSettings: async () => ({ directSkillManagementVersion: 1, globallyDisabledUserSkillKeys: [], globallyDisabledProjectSkillKeys: [] }), getConfig: async () => ({ enable_agent_companion: false }), getSkillScanReport: async () => ({ skills: mocks.skills, diagnostics: [] }) } }));
vi.mock('@/infrastructure/api/service-api/ExternalHooksAPI', () => ({ externalHooksAPI: {
  getCatalog: async () => ({ sources: [], entries: [], providers: [], failedProviderIds: [], discoveryPending: false }),
  getImportSnapshot: async () => ({ catalog: { sources: [], entries: [], providers: [], failedProviderIds: [], discoveryPending: false }, imports: [] }),
} }));

import EcosystemCompatibilityScene from './EcosystemCompatibilityScene';

function snapshot(enabled: boolean, pending = false, discovered = false, preferenceRevision = 1): ExternalSourceCatalogSnapshot {
  const source = { providerId: 'codex.mcp', sourceId: 'user' };
  return {
    generation: discovered ? 2 : 1, discoveryPending: pending, preferenceRevision,
    discovery: { enabled, canChange: true, hasScanned: enabled || discovered, preferenceRevision },
    hostCapabilities: { canMutatePolicy: true, canManageSources: true, canApproveRuntime: true },
    integrationPolicy: {
      status: 'compatible', registeredEcosystems: [],
      effective: { enabled: false, ecosystems: { codex: { mode: 'recommended', capabilities: { mcp: 'ask_before_use', subagent: 'ask_before_use' } } } },
    },
    commands: [],
    sources: discovered ? [{ stableKey: 'codex:user', record: {
      key: source, ecosystemId: 'codex', displayName: 'Codex', location: '<user>/config.toml',
      health: 'available', diagnostics: [],
    } }] : [],
    mcpServers: discovered ? [{ candidateId: 'codex:mcp:docs', definition: { id: { source }, name: 'Docs MCP' } }] : [],
  } as unknown as ExternalSourceCatalogSnapshot;
}

describe('compatibility discovery lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    clearEcosystemDiscoveryCache();
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.getDiscoverySnapshot.mockReset();
    mocks.setAutomaticDiscovery.mockReset();
    mocks.ownerSurface = null;
    mocks.selectedProductId = 'codex';
    mocks.setOwnerSurface.mockImplementation((owner) => { mocks.ownerSurface = owner; });
    mocks.setOwnerSurface.mockClear();
    mocks.planMcpImport.mockResolvedValue({ schemaVersion: 1, planFingerprint: 'plan', items: [] });
    mocks.applyMcpImport.mockReset();
    mocks.workspaceId = 'workspace-a';
    mocks.workspacePath = '/workspace';
    mocks.peerDeviceId = '';
    mocks.skills = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function renderMcp() {
    await act(async () => root.render(<EcosystemCompatibilityScene />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-content-group="mcp"] button[aria-haspopup="dialog"]');
    if (trigger && !container.querySelector('[data-ecosystem-category="mcp"]')) await act(async () => trigger.click());
  }

  it('uses the Cursor brand mark and does not present shared directories as agents', async () => {
    mocks.selectedProductId = 'cursor';
    mocks.getDiscoverySnapshot.mockResolvedValue(snapshot(true));
    mocks.skills = [{ key: 'user::home.agents::review', name: 'review', sourceId: 'agent-skills', level: 'user', path: '/home/.agents/skills/review' }];
    await act(async () => root.render(<EcosystemCompatibilityScene />));
    expect(container.querySelector<HTMLElement>('[data-product-logo="cursor"]')?.style.maskImage).toContain('/assets/ecosystem-compatibility/cursor.svg');
    expect(container.querySelector('[data-product-id="agent-skills"]')).toBeNull();
    expect(container.textContent).not.toContain('Agent Skills');
  });

  function discoverySwitch(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('[data-external-discovery-control] input[role="switch"]');
    expect(input).not.toBeNull();
    return input!;
  }

  function discoveryDescription(): HTMLElement {
    const descriptionId = discoverySwitch().getAttribute('aria-describedby')!.split(' ')[0];
    const description = document.getElementById(descriptionId);
    expect(description?.hidden).toBe(true);
    return description!;
  }

  it('keeps discovery available before the first scan and reveals its explanation on hover or focus', async () => {
    mocks.getDiscoverySnapshot.mockResolvedValue(snapshot(false));
    await renderMcp();
    expect(container.querySelector('[data-content-empty-state="notScanned"]')).not.toBeNull();
    expect(discoverySwitch().checked).toBe(false);
    expect(discoverySwitch().disabled).toBe(false);
    expect(discoveryDescription().textContent).toBe('discovery.disabledDescription discovery.workspaceScope');
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector('#ecosystem-source-manager')).toBeNull();
    expect(container.querySelector('.ecosystem-compatibility__body')?.textContent).not.toContain('discovery.disabledDescription');
    const control = container.querySelector<HTMLElement>('[data-external-discovery-control]')!;
    await act(async () => control.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(discoveryDescription().textContent);
    await act(async () => control.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => discoverySwitch().focus());
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(discoveryDescription().textContent);
    await act(async () => discoverySwitch().blur());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(mocks.getDiscoverySnapshot).toHaveBeenCalledTimes(1);
  });

  it('updates discovery without enabling runtime policy and collects the resulting scan', async () => {
    const initial = snapshot(false);
    mocks.getDiscoverySnapshot.mockResolvedValueOnce(initial).mockResolvedValue(snapshot(true, false, true, 2));
    mocks.setAutomaticDiscovery.mockResolvedValue(snapshot(true, true, false, 2));
    await renderMcp();
    await act(async () => discoverySwitch().click());
    expect(mocks.setAutomaticDiscovery).toHaveBeenCalledExactlyOnceWith('workspace-a', true, 1);
    expect(initial.integrationPolicy.effective.enabled).toBe(false);
    expect(discoverySwitch().checked).toBe(true);
    expect(discoveryDescription().textContent).toBe('discovery.enabledDescription discovery.workspaceScope');
    expect(initial.integrationPolicy.effective.ecosystems.codex.mode).toBe('recommended');
    expect(mocks.setOwnerSurface).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(container.querySelector('[data-import-kind="mcp"]')?.getAttribute('data-import-discovered')).toBe('true');
  });

  it('uses host user settings when no workspace is open', async () => {
    mocks.workspaceId = null;
    mocks.getDiscoverySnapshot.mockResolvedValue(snapshot(true));
    mocks.setAutomaticDiscovery.mockResolvedValue(snapshot(false, false, false, 2));
    await renderMcp();
    await act(async () => discoverySwitch().click());
    expect(mocks.setAutomaticDiscovery).toHaveBeenCalledExactlyOnceWith(undefined, false, 1);
    expect(discoverySwitch().checked).toBe(false);
    expect(discoveryDescription().textContent).toBe('discovery.disabledDescription discovery.userScope');
  });

  it.each(['read-only-host', 'legacy-revision', 'incompatible-policy'])(
    'keeps %s discovery explicit and read-only', async (reason) => {
      const value = snapshot(true);
      if (reason === 'read-only-host') value.discovery!.canChange = false;
      if (reason === 'legacy-revision') delete value.discovery;
      if (reason === 'incompatible-policy') { value.integrationPolicy.status = 'incompatible_schema'; value.discovery!.canChange = false; }
      mocks.getDiscoverySnapshot.mockResolvedValue(value);
      await renderMcp();
      expect(discoverySwitch().disabled).toBe(true);
      expect(discoveryDescription().textContent).toBe('discovery.readOnlyDescription');
      const control = container.querySelector<HTMLElement>('[data-external-discovery-control]')!;
      expect(control.tabIndex).toBe(0);
      await act(async () => control.focus());
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('discovery.readOnlyDescription');
      await act(async () => discoverySwitch().click());
      expect(mocks.setAutomaticDiscovery).not.toHaveBeenCalled();
    },
  );

  it('shows a save failure beside discovery and refreshes the confirmed state', async () => {
    mocks.getDiscoverySnapshot.mockResolvedValueOnce(snapshot(false)).mockResolvedValue(snapshot(true, false, false, 2));
    mocks.setAutomaticDiscovery.mockRejectedValue(new Error('Preference revision changed'));
    await renderMcp();
    await act(async () => discoverySwitch().click());
    const alert = container.querySelector('[data-external-discovery-control] [role="alert"]');
    expect(alert?.textContent).toBe('discovery.saveFailed');
    expect(alert?.getAttribute('data-openbitfun-component')).toBe('alert');
    expect(alert?.getAttribute('aria-live')).toBe('assertive');
    expect(alert?.querySelector('[data-openbitfun-part="icon"]')).toBeNull();
    expect(discoverySwitch().checked).toBe(true);
    expect(discoverySwitch().disabled).toBe(false);
    expect(mocks.getDiscoverySnapshot).toHaveBeenLastCalledWith('workspace-a', false);
  });

  it('does not let an older refresh undo a confirmed discovery change', async () => {
    let resolveRefresh: (value: ExternalSourceCatalogSnapshot) => void = () => {};
    mocks.getDiscoverySnapshot.mockResolvedValueOnce(snapshot(true)).mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    mocks.setAutomaticDiscovery.mockResolvedValue(snapshot(false, false, false, 2));
    await renderMcp();
    const refresh = container.querySelector<HTMLButtonElement>('.ecosystem-compatibility__product-header button[aria-label="content.refresh"]');
    expect(refresh).not.toBeNull();
    expect(container.querySelector('[data-external-agent-content] > .ecosystem-compatibility__section-heading button[aria-label="content.refresh"]')).toBeNull();
    await act(async () => refresh!.click());
    expect(refresh!.disabled).toBe(true);
    await act(async () => discoverySwitch().click());
    expect(discoverySwitch().checked).toBe(false);
    await act(async () => resolveRefresh(snapshot(true)));
    expect(discoverySwitch().checked).toBe(false);
  });

  it('ignores a completed save from a workspace that is no longer displayed', async () => {
    let resolveSave: (value: ExternalSourceCatalogSnapshot) => void = () => {};
    mocks.getDiscoverySnapshot.mockResolvedValue(snapshot(false));
    mocks.setAutomaticDiscovery.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    await renderMcp();
    await act(async () => discoverySwitch().click());
    expect(discoverySwitch().disabled).toBe(true);
    mocks.workspaceId = 'workspace-b';
    mocks.workspacePath = '/other-workspace';
    await renderMcp();
    await act(async () => resolveSave(snapshot(true, false, false, 2)));
    expect(discoverySwitch().checked).toBe(false);
    expect(discoverySwitch().disabled).toBe(false);
  });

  it('collects the completed MCP scan without requiring a manual refresh', async () => {
    mocks.getDiscoverySnapshot.mockResolvedValueOnce(snapshot(true, true)).mockResolvedValue(snapshot(true, false, true));
    await renderMcp();
    expect(container.querySelector('[data-content-empty-state="checking"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(container.querySelector('[data-import-kind="mcp"]')?.getAttribute('data-import-discovered')).toBe('true');
    expect(container.textContent).toContain('Docs MCP');
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(mocks.getDiscoverySnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.getDiscoverySnapshot).toHaveBeenLastCalledWith('workspace-a', false);
  });

  it('scans from the empty state while automatic discovery stays paused', async () => {
    const pending = snapshot(false, true, false);
    pending.discovery!.hasScanned = true;
    let resolveScan!: (value: ExternalSourceCatalogSnapshot) => void;
    mocks.getDiscoverySnapshot.mockResolvedValueOnce(snapshot(false))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveScan = resolve; }))
      .mockResolvedValue(snapshot(false, false, true));
    await renderMcp();
    const scanButton = container.querySelector<HTMLButtonElement>('[data-content-empty-state] button')!;
    expect(scanButton.textContent).toBe('content.scan');
    await act(async () => scanButton.click());
    expect(mocks.getDiscoverySnapshot).toHaveBeenLastCalledWith('workspace-a', true);
    expect(container.querySelector('[data-content-empty-state="checking"]')).not.toBeNull();
    expect(scanButton.disabled).toBe(true);
    await act(async () => scanButton.click());
    expect(mocks.getDiscoverySnapshot).toHaveBeenCalledTimes(2);
    expect(discoverySwitch().checked).toBe(false);
    await act(async () => resolveScan(pending));
    expect(scanButton.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(container.textContent).toContain('Docs MCP');
    expect(container.querySelector('[data-content-empty-state]')).toBeNull();
    expect(mocks.getDiscoverySnapshot).toHaveBeenLastCalledWith('workspace-a', false);
    expect(mocks.setAutomaticDiscovery).not.toHaveBeenCalled();
  });

  it('retains discovered content when paused and after a failed read', async () => {
    mocks.getDiscoverySnapshot.mockResolvedValueOnce(snapshot(true, false, true));
    mocks.setAutomaticDiscovery.mockResolvedValue(snapshot(false, false, true, 2));
    await renderMcp();
    await act(async () => discoverySwitch().click());
    expect(container.textContent).toContain('Docs MCP');
    mocks.getDiscoverySnapshot.mockRejectedValue(new Error('Host temporarily unavailable'));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="content.refresh"]')!.click());
    expect(container.textContent).toContain('Docs MCP');
    expect(discoverySwitch().checked).toBe(false);
  });

  it('ignores a late scan from the previous workspace', async () => {
    let resolveOld: (value: ExternalSourceCatalogSnapshot) => void = () => {};
    mocks.getDiscoverySnapshot.mockResolvedValueOnce(snapshot(true, true)).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    await renderMcp();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    mocks.workspaceId = 'workspace-b';
    mocks.workspacePath = '/other-workspace';
    mocks.getDiscoverySnapshot.mockResolvedValue(snapshot(false));
    await renderMcp();
    await act(async () => resolveOld(snapshot(true, false, true)));
    expect(container.textContent).not.toContain('Docs MCP');
    expect(container.querySelector('[data-content-empty-state="notScanned"]')).not.toBeNull();
  });

  it('keeps the discovered catalog when only the workspace path changes', async () => {
    mocks.getDiscoverySnapshot.mockResolvedValueOnce(snapshot(true, false, true));
    await renderMcp();
    expect(container.textContent).toContain('Docs MCP');
    mocks.workspacePath = '/moved-checkout';
    await renderMcp();
    expect(container.textContent).toContain('Docs MCP');
    expect(mocks.getDiscoverySnapshot).toHaveBeenCalledTimes(1);
  });

  it('drops local catalog content immediately when switching to a peer on the same workspace', async () => {
    mocks.getDiscoverySnapshot.mockResolvedValueOnce(snapshot(true, false, true));
    await renderMcp();
    expect(container.textContent).toContain('Docs MCP');
    let resolvePeer: (value: ExternalSourceCatalogSnapshot) => void = () => {};
    mocks.getDiscoverySnapshot.mockImplementationOnce(() => new Promise((resolve) => { resolvePeer = resolve; }));
    mocks.peerDeviceId = 'peer-host';
    await renderMcp();
    expect(container.textContent).not.toContain('Docs MCP');
    await act(async () => resolvePeer(snapshot(true)));
    expect(container.textContent).not.toContain('Docs MCP');
    expect(mocks.getDiscoverySnapshot).toHaveBeenCalledTimes(2);
  });

  it('distinguishes capability policy, failed reads and a completed empty scan', () => {
    const value = snapshot(true);
    delete value.discovery;
    value.integrationPolicy.effective.enabled = true;
    expect(catalogDiscoveryState(value, 'codex', 'mcp')).toBe('notDetected');
    value.integrationPolicy.effective.ecosystems.codex.capabilities.mcp = 'disabled';
    expect(catalogDiscoveryState(value, 'codex', 'mcp')).toBe('discoveryDisabled');
    value.integrationPolicy.status = 'incompatible_schema';
    expect(catalogDiscoveryState(value, 'codex', 'mcp')).toBe('discoveryUnavailable');
  });

  it('keeps content-only ecosystems usable without promising an unavailable ACP runtime', async () => {
    mocks.selectedProductId = 'pi';
    mocks.getDiscoverySnapshot.mockResolvedValue(snapshot(true));
    await renderMcp();
    expect(container.querySelector('[data-external-agent-content="pi"]')).not.toBeNull();
    expect(container.textContent).not.toContain('run.description');
    expect(container.textContent).not.toContain('run.openManager');
    expect(container.textContent).not.toContain('header.notAvailable');
  });

  it('counts external Skills once, focuses the header from legacy settings links, and reloads on host changes', async () => {
    mocks.skills = [
      { key: 'project::codex::sample', name: 'sample', sourceId: 'codex', sourceSlot: 'codex', path: '/workspace/.codex/skills/sample' },
      { key: 'project::openbitfun::sample', name: 'sample', sourceId: 'openbitfun', sourceSlot: 'openbitfun', path: '/workspace/.openbitfun/skills/sample', importOrigin: { sourceId: 'codex' } },
    ];
    mocks.getDiscoverySnapshot.mockResolvedValue(snapshot(true, false, true));
    await renderMcp();
    expect(container.querySelector('[data-product-id="codex"]')?.getAttribute('title')).toBe('Codex · assets:2');
    expect(container.textContent).toContain('host.local');
    expect(container.textContent).not.toContain('host.remote');
    mocks.ownerSurface = 'external-sources';
    await act(async () => root.render(<EcosystemCompatibilityScene />));
    expect(container.querySelector('[data-product-id="codex"]')?.getAttribute('title')).toBe('Codex · assets:2');
    expect(mocks.setOwnerSurface).toHaveBeenCalledWith(null);
    expect(document.activeElement).toBe(container.querySelector('[data-external-discovery-control]'));
    expect(container.querySelector('[data-content-group="mcp"]')).not.toBeNull();
    mocks.peerDeviceId = 'different-host';
    mocks.skills = [];
    mocks.getDiscoverySnapshot.mockResolvedValue(snapshot(true));
    await act(async () => root.render(<EcosystemCompatibilityScene />));
    expect(container.querySelector('[data-product-id="codex"]')?.getAttribute('title')).toBe('Codex · productSummary.available');
  });
});
