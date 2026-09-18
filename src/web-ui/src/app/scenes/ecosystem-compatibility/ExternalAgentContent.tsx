import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { Alert, Button, Checkbox, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeaderActions, DialogHeading, DialogTitle, Icon, IconButton, LoadingState, OverflowText, ScrollArea, SearchField, Switch, StatusPill, type IconSource } from '@openbitfun/ui';
import { EcosystemDialog as Dialog } from './EcosystemDialog';
import { EcosystemBatchLayout } from './EcosystemBatchLayout';
import EcosystemPets from './EcosystemPets';
import EcosystemAccounts, { ecosystemAccountProvider } from './EcosystemAccounts';
import { presentEcosystemContent } from './ecosystemContentPresentation';
import { ecosystemDiscoveryCache, rememberEcosystemHooks, rememberEcosystemSkills } from './ecosystemDiscoveryCache';
import { importErrorMessage } from './ecosystemSkillImport';
import { applyEcosystemBatchUndo, type BatchUndoEntry, type BatchUndoResult } from './ecosystemBatchUndo';
import { CircleUserRound, FileText, Package, PawPrint, Server, Webhook, Wrench } from 'lucide-react';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useSettingsStore } from '@/app/scenes/settings/settingsStore';
import { useI18n } from '@/infrastructure/i18n';
import { useNotification } from '@/shared/notification-system';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { globalEventBus } from '@/infrastructure/event-bus';
import { MCP_CONFIG_CHANGED, type MCPConfigChanged } from '@/infrastructure/mcp/configEvents';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { WorkspaceKind } from '@/shared/types';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { externalSourcesAPI, type ExternalMcpImportPlanV1, type ExternalSourceCatalogSnapshot } from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import { externalHooksAPI, type ExternalHookImportPlan, type ExternalHookImportSnapshot, type ExternalHookSource } from '@/infrastructure/api/service-api/ExternalHooksAPI';
import { instructionSourcesAPI, type InstructionSourceCatalog, type InstructionSourceEntry } from '@/infrastructure/api/service-api/InstructionSourcesAPI';
import type { SkillInfo, SkillScanDiagnostic, GlobalSkillSettings } from '@/infrastructure/config/types';
import { getSkillSourceId, isOpenBitFunManagedSkill } from '@/infrastructure/config/skillSourcePresentation';
import { buildEcosystemImportItems, catalogDiscoveryState, type EcosystemImportItem, type EcosystemImportItemKind, type EcosystemProductRuntime } from './ecosystemCompatibilityModel';
import { applyImportUndo, prepareHookUndo, prepareMcpUndo, type ImportUndoReview } from './ecosystemImportUndo';
import { applyEcosystemBatch, type BatchImportEntry, type BatchImportResult } from './ecosystemBatchImport';

interface ContentItem extends EcosystemImportItem {
  skill?: SkillInfo;
  hookSource?: ExternalHookSource;
  instruction?: InstructionSourceEntry;
}

const CONTENT_ICONS: Record<EcosystemImportItemKind, IconSource> = {
  account: { glyph: CircleUserRound },
  settings: { name: 'settings' },
  command: { name: 'command-mac' },
  tool: { glyph: Wrench },
  subagent: { name: 'user' },
  skill: { glyph: Package },
  mcp: { glyph: Server },
  hook: { glyph: Webhook },
  instruction: { glyph: FileText },
  memory: { name: 'thinking' },
  plugin: { name: 'extension' },
  pet: { glyph: PawPrint },
};

type Review =
  | { kind: 'mcp'; item: ContentItem; plan: ExternalMcpImportPlanV1 }
  | { kind: 'hook'; item: ContentItem; plan: ExternalHookImportPlan };

export interface ExternalAgentContentHandle {
  refresh: () => Promise<void>;
}

interface Props {
  scopeKey?: string;
  /** The scene owns placement; this catalog keeps the refresh lifecycle and disabled state. */
  refreshControlRef?: Ref<ExternalAgentContentHandle>;
  onRefreshDisabledChange?: (disabled: boolean) => void;
  runtime: EcosystemProductRuntime;
  snapshot: ExternalSourceCatalogSnapshot | null;
  catalogFailed: boolean;
  onRefresh: () => Promise<unknown>;
  onSupplementalCounts?: (counts: Record<string, number>) => void;
}

/** An external catalog, never an embedded native manager. Mount separately for each host/workspace/agent. */
export default function ExternalAgentContent({ scopeKey, refreshControlRef, onRefreshDisabledChange, runtime, snapshot, catalogFailed, onRefresh, onSupplementalCounts }: Props) {
  const contentId = useId();
  const { t, formatNumber } = useI18n('scenes/ecosystem-compatibility');
  const notification = useNotification();
  const { workspace, workspacePath } = useCurrentWorkspace();
  const peer = usePeerDeviceModeOptional();
  const cache = ecosystemDiscoveryCache(scopeKey ?? JSON.stringify([peer?.peerMode.active ? peer.peerMode.deviceId : undefined, workspace?.id]));
  const automaticDiscovery = snapshot !== null && (snapshot.discovery?.enabled ?? true);
  const localImportSupported = isTauriRuntime() && !peer?.peerMode.active
    && workspace?.workspaceKind !== WorkspaceKind.Remote;
  const [skills, setSkills] = useState<SkillInfo[]>(() => cache.skills ?? []);
  const [skillSettings, setSkillSettings] = useState<GlobalSkillSettings | null>(null);
  const [skillDiagnostics, setSkillDiagnostics] = useState<SkillScanDiagnostic[]>(() => cache.skillDiagnostics?.filter((entry) => entry.sourceId === runtime.spec.ecosystemId) ?? []);
  const [hooks, setHooks] = useState<ExternalHookImportSnapshot | null>(() => cache.hooks ?? null);
  const [instructionSnapshot, setInstructionSnapshot] = useState<{ workspaceId: string | undefined; catalog: InstructionSourceCatalog | null } | null>(null);
  const instructions = localImportSupported && instructionSnapshot?.workspaceId === workspace?.id
    ? instructionSnapshot?.catalog ?? null : null;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [contentRefreshVersion, setContentRefreshVersion] = useState(0);
  const [accountExpanded, setAccountExpanded] = useState(false);
  const [petDialogOpen, setPetDialogOpen] = useState(false);
  const [petCount, setPetCount] = useState(0);
  const [loadFailures, setLoadFailures] = useState<string[]>([]);
  const [plan, setPlan] = useState<ExternalMcpImportPlanV1 | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planFailed, setPlanFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<EcosystemImportItemKind | null>(null);
  const [detail, setDetail] = useState<ContentItem | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [batch, setBatch] = useState<BatchImportEntry[] | null>(null);
  const [batchSkipped, setBatchSkipped] = useState(0);
  const [batchResults, setBatchResults] = useState<BatchImportResult[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchUndo, setBatchUndo] = useState<BatchUndoEntry[] | null>(null);
  const [batchUndoResults, setBatchUndoResults] = useState<BatchUndoResult[] | null>(null);
  const [undo, setUndo] = useState<{ item: ContentItem; review: ImportUndoReview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const alive = useRef(false);
  const loadSequence = useRef(0);
  const skillSettingsRevision = useRef(0);
  const reviewSequence = useRef(0);
  const mcpPlanSequence = useRef(0);

  const openNativeManagement = (kind: EcosystemImportItemKind) => {
    if (!localImportSupported) return;
    setKind(null);
    setNotice(null);
    if (kind === 'mcp' || kind === 'hook') {
      useSettingsStore.getState().openDestination(kind === 'mcp'
        ? { pageId: 'tools.mcp' } : { pageId: 'tools.automation', viewId: 'hooks' });
      useSceneStore.getState().openScene('settings');
    }
  };

  const loadSupplemental = useCallback(async (refresh = false, collectPending = false) => {
    const sequence = ++loadSequence.current;
    const settingsRevision = skillSettingsRevision.current;
    setLoading(true);
    const [skillResult, hookResult, instructionResult, settingsResult] = await Promise.allSettled([
      collectPending ? Promise.resolve(null)
        : configAPI.getSkillScanReport({ workspaceId: workspace?.id, forceRefresh: refresh }),
      !refresh && !automaticDiscovery && !collectPending ? Promise.resolve(cache.hooks ?? null) : localImportSupported
        ? externalHooksAPI.getImportSnapshot(workspace?.id, refresh)
        : externalHooksAPI.getCatalog(workspace?.id, refresh).then((catalog) => ({
          schemaVersion: 1 as const, revision: '', catalog, imports: [], diagnostics: [],
        })),
      localImportSupported ? instructionSourcesAPI.getCatalog(workspace?.id) : Promise.resolve(null),
      localImportSupported ? configAPI.getGlobalSkillSettings(workspace?.id) : Promise.resolve(null),
    ]);
    if (!alive.current || sequence !== loadSequence.current) return;
    const failures: string[] = [];
    if (skillResult.status === 'fulfilled' && skillResult.value) {
      setSkills(rememberEcosystemSkills(cache, skillResult.value.skills, skillResult.value.diagnostics));
      setSkillDiagnostics(skillResult.value.diagnostics.filter((entry) => entry.sourceId === runtime.spec.ecosystemId));
    } else if (skillResult.status === 'rejected') { failures.push('skill'); }
    if (hookResult.status === 'fulfilled') {
      if (hookResult.value) setHooks(rememberEcosystemHooks(cache, hookResult.value));
    } else { failures.push('hook'); }
    setInstructionSnapshot({ workspaceId: workspace?.id, catalog: instructionResult.status === 'fulfilled' ? instructionResult.value : null });
    if (instructionResult.status === 'rejected') failures.push('instruction');
    if (settingsRevision === skillSettingsRevision.current) {
      setSkillSettings(settingsResult.status === 'fulfilled' ? settingsResult.value : null);
    }
    setLoadFailures(failures);
    setLoading(false);
  }, [automaticDiscovery, cache, localImportSupported, runtime.spec.ecosystemId, workspace?.id]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; loadSequence.current += 1; reviewSequence.current += 1; };
  }, []);

  useEffect(() => {
    void loadSupplemental();
  }, [loadSupplemental]);

  useEffect(() => {
    if (!localImportSupported) return;
    const refreshAvailability = async () => {
      const revision = ++skillSettingsRevision.current;
      try {
        const settings = await configAPI.getGlobalSkillSettings(workspace?.id);
        if (alive.current && revision === skillSettingsRevision.current) setSkillSettings(settings);
      } catch {
        if (alive.current && revision === skillSettingsRevision.current) setSkillSettings(null);
      }
    };
    globalEventBus.on('mode:config:updated', refreshAvailability);
    return () => {
      skillSettingsRevision.current += 1;
      globalEventBus.off('mode:config:updated', refreshAvailability);
    };
  }, [localImportSupported, workspacePath, workspace?.id]);

  useEffect(() => {
    if (!hooks?.catalog.discoveryPending) return;
    const timer = window.setTimeout(() => void loadSupplemental(false, true), 1000);
    return () => window.clearTimeout(timer);
  }, [automaticDiscovery, hooks?.catalog.discoveryPending, hooks, loadSupplemental]);

  const items = useMemo<ContentItem[]>(() => {
    const catalog = buildEcosystemImportItems(snapshot, runtime);
    const externalSkills = skills.filter((skill) => !isOpenBitFunManagedSkill(skill)
      && getSkillSourceId(skill) === runtime.spec.ecosystemId);
    const hookSources = hooks?.catalog.sources.filter((source) => source.ecosystemId === runtime.spec.ecosystemId) ?? [];
    const instructionSources = instructions?.entries.filter((source) => source.ecosystemId === runtime.spec.ecosystemId || source.ecosystemId === 'shared') ?? [];
    return catalog.flatMap((item): ContentItem[] => {
      if (item.kind === 'instruction' && instructionSources.length > 0) return instructionSources.map((instruction) => ({
        ...item, id: `instruction:${instruction.scope}:${instruction.path}`, name: instruction.name,
        sourceName: instruction.ecosystemId === 'shared' ? t('content.instructions.shared') : runtime.spec.name,
        sourceLocation: instruction.path, discovered: true, instruction,
      }));
      if (item.kind === 'skill' && externalSkills.length > 0) return externalSkills.map((skill) => ({
        ...item, id: `skill:${skill.key}`, name: skill.name, description: skill.description,
        sourceName: skill.sourceLabel || runtime.spec.name, sourceLocation: skill.path,
        discovered: true, skill,
      }));
      if (item.kind === 'hook' && hookSources.length > 0) return hookSources.map((source) => ({
        ...item, id: `hook:${source.key.providerId}:${source.key.sourceId}`, name: source.displayName,
        sourceName: runtime.spec.name, sourceLocation: source.locationHint,
        discovered: true, hookSource: source,
      }));
      return [item];
    });
  }, [hooks, instructions, runtime, skills, snapshot, t]);

  useEffect(() => {
    if (loading) return;
    const counts: Record<string, number> = {};
    for (const skill of skills) {
      if (isOpenBitFunManagedSkill(skill)) continue;
      const source = getSkillSourceId(skill);
      counts[source] = (counts[source] ?? 0) + 1;
    }
    for (const source of hooks?.catalog.sources ?? []) {
      counts[source.ecosystemId] = (counts[source.ecosystemId] ?? 0) + 1;
    }
    if (localImportSupported && runtime.spec.id === 'codex') {
      counts.codex = (counts.codex ?? 0) + petCount;
    }
    onSupplementalCounts?.(counts);
  }, [hooks, loading, localImportSupported, onSupplementalCounts, petCount, runtime.spec.id, skills]);

  const hasMcp = items.some((item) => item.kind === 'mcp' && item.discovered);
  const refreshMcpPlan = useCallback(async (explicit = false) => {
    if (!automaticDiscovery && !explicit) return;
    const sequence = ++mcpPlanSequence.current;
    setPlan(null);
    if (!localImportSupported || !hasMcp) { setPlanLoading(false); return; }
    setPlanLoading(true);
    setPlanFailed(false);
    const next = await externalSourcesAPI.planMcpImport(workspace?.id).catch(() => null);
    if (!alive.current || sequence !== mcpPlanSequence.current) return;
    setPlan(next);
    setPlanFailed(next === null);
    setPlanLoading(false);
  }, [automaticDiscovery, hasMcp, localImportSupported, workspace?.id]);
  useEffect(() => {
    void refreshMcpPlan();
    return () => { mcpPlanSequence.current += 1; };
  }, [refreshMcpPlan, snapshot?.generation]);

  useEffect(() => {
    if (!localImportSupported || !hasMcp) return;
    const scope = getActiveSurfaceScope();
    return globalEventBus.on<MCPConfigChanged>(MCP_CONFIG_CHANGED, ({ surfaceId }) => {
      if (scope.isCurrent() && surfaceId === scope.surfaceId) void refreshMcpPlan();
    });
  }, [hasMcp, localImportSupported, refreshMcpPlan]);

  const importedHook = (item: ContentItem) => hooks?.imports.some((entry) => (
    entry.source.key.providerId === item.hookSource?.key.providerId
    && entry.source.key.sourceId === item.hookSource?.key.sourceId
  ));
  const skillManagementSupported = localImportSupported && skillSettings?.directSkillManagementVersion === 1;
  const skillDisabled = (skill: SkillInfo) => (skill.level === 'user'
    ? skillSettings?.globallyDisabledUserSkillKeys : skillSettings?.globallyDisabledProjectSkillKeys)?.includes(skill.key) ?? false;
  async function toggleSkill(skill: SkillInfo, enabled: boolean) {
    if (!skillManagementSupported || busy) return;
    skillSettingsRevision.current += 1;
    const scope = getActiveSurfaceScope();
    setBusy(true); setNotice(null);
    try {
      const settings = await configAPI.setGlobalSkillDisabled({ skillKey: skill.key, disabled: !enabled, workspaceId: workspace?.id });
      if (alive.current && scope.isCurrent()) {
        setSkillSettings(settings);
        globalEventBus.emit('mode:config:updated');
      }
    } catch { if (alive.current && scope.isCurrent()) setNotice(t('content.skills.updateFailed')); }
    finally {
      skillSettingsRevision.current += 1;
      if (alive.current) setBusy(false);
    }
  }
  const presentation = (item: ContentItem) => {
    if (item.skill && (loadFailures.includes('skill') || cache.staleSkillKeys?.has(item.skill.key))) return { state: 'discovered' as const, canImport: false, descriptionKey: 'content.lastKnownResult' };
    if (item.skill) return {
      state: !skillManagementSupported ? 'unknown' as const : skillDisabled(item.skill) ? 'disabled' as const : 'available' as const,
      canImport: false,
      descriptionKey: !skillManagementSupported ? 'content.skills.unsupported' : undefined,
    };
    let discoveryState: ReturnType<typeof catalogDiscoveryState> = 'notDetected';
    if (item.kind === 'instruction') {
      if (loading) discoveryState = 'checking';
      else if (!localImportSupported || loadFailures.includes('instruction') || !instructions
        || (!item.discovered && instructions.failedEcosystems.some((id) => id === 'shared' || id === runtime.spec.ecosystemId))) {
        discoveryState = 'discoveryUnavailable';
      }
    } else if (item.kind === 'skill' || item.kind === 'hook') {
      const providerFailed = item.kind === 'hook' && hooks?.catalog.providers.some((provider) => (
        provider.ecosystemId === runtime.spec.ecosystemId && hooks.catalog.failedProviderIds.includes(provider.providerId)
      ));
      const hasScanned = item.kind === 'skill' ? cache.skills !== undefined : cache.hooks !== undefined;
      if (!snapshot) discoveryState = catalogFailed ? 'discoveryUnavailable' : 'checking';
      else if (!automaticDiscovery && !hasScanned) discoveryState = 'notScanned';
      else if (loading || (item.kind === 'hook' && hooks?.catalog.discoveryPending)) discoveryState = 'checking';
      else if (loadFailures.includes(item.kind) || (item.kind === 'skill'
        && ((!item.discovered && skillDiagnostics.length > 0)))
        || providerFailed) discoveryState = 'discoveryUnavailable';
    } else discoveryState = catalogDiscoveryState(snapshot, runtime.spec.ecosystemId, item.kind);
    return presentEcosystemContent({
      item, discoveryState, catalogFailed, localImportSupported,
      // MCP copy existence comes from the current native import plan, not a past success.
      imported: (item.kind !== 'mcp' && completed.has(item.id)) || !!importedHook(item),
      skillImportSupported: false,
      hookImportSupported: !!item.hookSource && ['claude-code', 'codex'].includes(item.hookSource.ecosystemId),
      planLoading,
      mcpDisposition: plan?.items.find((entry) => entry.candidateId === item.candidateId)?.disposition,
      mcpPlanDeferred: !automaticDiscovery && !plan && !planFailed,
    });
  };
  const contentState = (item: ContentItem) => presentation(item).state;
  const stateDescription = (item: ContentItem, state: string) => {
    if (item.kind === 'instruction' && !localImportSupported) return t('content.instructions.unsupportedHost');
    const { descriptionKey } = presentation(item);
    if (descriptionKey) return t(descriptionKey);
    if (state === 'unavailable') {
      const entry = plan?.items.find((candidate) => candidate.candidateId === item.candidateId);
      const definition = snapshot?.mcpServers?.find((server) => server.candidateId === item.candidateId)?.definition;
      if (definition?.staticStatus?.state === 'disabled_by_source') return t('content.sourceDisabled');
      return entry?.reasonCode === 'external_mcp.import_setup_required' ? t('content.setupRequired') : t('content.importUnavailable');
    }
    return item.description || t('content.externalOnly');
  };

  async function prepareBatch(group?: EcosystemImportItemKind, selectedOnly = false) {
    if (busy || !localImportSupported) return;
    setBusy(true);
    setNotice(null);
    const candidates = items.filter((item) => ['mcp', 'hook'].includes(item.kind) && (!group || item.kind === group) && item.discovered && (!selectedOnly || (selected.has(item.id)
      && `${item.name} ${item.description ?? ''} ${item.sourceLocation ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))));
    const entries: BatchImportEntry[] = [];
    try {
      const freshMcpPlan = candidates.some((item) => item.kind === 'mcp')
        ? await externalSourcesAPI.planMcpImport(workspace?.id).catch(() => null) : null;
      for (const item of candidates) {
        if (!alive.current) return;
        if (!presentation(item).canImport) continue;
        if (item.kind === 'mcp' && item.candidateId && freshMcpPlan?.items.some((candidate) =>
          candidate.candidateId === item.candidateId && ['eligible', 'automatic_rename'].includes(candidate.disposition))) {
          entries.push({ id: item.id, name: item.name, kind: 'mcp', candidateId: item.candidateId, plan: freshMcpPlan });
        } else if (item.hookSource) {
          const next = await externalHooksAPI.planImport(workspace?.id, item.hookSource.key).catch(() => null);
          if (next && next.source.ecosystemId === runtime.spec.ecosystemId
            && next.source.key.providerId === item.hookSource.key.providerId
            && next.source.key.sourceId === item.hookSource.key.sourceId
            && next.disposition !== 'unavailable' && next.handlers.length) {
            entries.push({ id: item.id, name: item.name, kind: 'hook', plan: next });
          }
        }
      }
      if (!alive.current) return;
      setBatchSkipped(candidates.length - entries.length);
      setBatchResults(null);
      setBatch(entries);
    } finally { if (alive.current) setBusy(false); }
  }

  async function confirmBatch() {
    if (!batch?.length || busy || !localImportSupported) return;
    setBusy(true);
    setBatchResults([]);
    try {
      await applyEcosystemBatch(batch, { workspaceId: workspace?.id }, (result) => {
        if (!alive.current) return;
        setBatchResults((current) => [...(current ?? []), result]);
        if (result.status === 'imported' && batch.find((entry) => entry.id === result.id)?.kind !== 'mcp') {
          setCompleted((current) => new Set([...current, result.id]));
        }
      });
      if (alive.current) {
        void refreshMcpPlan(true);
        void loadSupplemental(true);
        void onRefresh().catch(() => { if (alive.current) setNotice(t('content.refreshAfterImportFailed')); });
      }
    } catch { if (alive.current) setNotice(t('content.refreshAfterImportFailed')); }
    finally { if (alive.current) setBusy(false); }
  }

  async function prepareImport(item: ContentItem) {
    const sequence = ++reviewSequence.current;
    setNotice(null);
    if (!localImportSupported || busy) return;
    setBusy(true);
    try {
      if (item.hookSource) {
        const next = await externalHooksAPI.planImport(workspace?.id, item.hookSource.key);
        if (!alive.current || sequence !== reviewSequence.current) return;
        if (next.source.ecosystemId !== runtime.spec.ecosystemId || next.source.key.providerId !== item.hookSource.key.providerId || next.source.key.sourceId !== item.hookSource.key.sourceId) { setNotice(t('content.previewFailed')); return; }
        setReview({ kind: 'hook', item, plan: next });
      } else if (item.kind === 'mcp') {
        const next = plan ?? await externalSourcesAPI.planMcpImport(workspace?.id);
        if (!alive.current || sequence !== reviewSequence.current) return;
        setPlan(next);
        setReview({ kind: 'mcp', item, plan: next });
      }
    } catch {
      if (alive.current && sequence === reviewSequence.current) setNotice(t('content.previewFailed'));
    } finally {
      if (alive.current && sequence === reviewSequence.current) setBusy(false);
    }
  }

  async function confirmImport() {
    if (!review || busy || !localImportSupported) return;
    const captured = review;
    setBusy(true);
    setNotice(null);
    try {
      if (captured.kind === 'mcp') {
        const candidateId = captured.item.candidateId!;
        const selected = captured.plan.items.find((item) => item.candidateId === candidateId);
        if (!selected || !['eligible', 'automatic_rename'].includes(selected.disposition)) return;
        const result = await externalSourcesAPI.applyMcpImport(workspace?.id, captured.plan, [{ candidateId }]);
        if (!alive.current) return;
        if (result.outcome.status === 'stale') {
          setPlan(result.outcome.refreshedPlan);
          setReview({ ...captured, plan: result.outcome.refreshedPlan });
          setNotice(t('content.stale'));
          return;
        }
      } else {
        if (captured.plan.disposition === 'unavailable' || captured.plan.handlers.length === 0) return;
        const result = await externalHooksAPI.applyImport(workspace?.id, captured.plan);
        if (!alive.current) return;
        if (result.outcome.kind === 'stale') {
          setReview({ ...captured, plan: result.outcome.refreshedPlan });
          setNotice(t('content.stale'));
          return;
        }
        setHooks(result.outcome.snapshot);
      }
      if (!alive.current) return;
      if (captured.kind === 'mcp') void refreshMcpPlan(true);
      else setCompleted((current) => new Set([...current, captured.item.id]));
      setReview(null);
      setDetail(null);
      notification.success(t('content.importSuccess', { name: captured.item.name }), { duration: 3200 });
      void loadSupplemental(true);
      void onRefresh().catch(() => { if (alive.current) setNotice(t('content.refreshAfterImportFailed')); });
    } catch (error) {
      const reason = importErrorMessage(error);
      if (alive.current) setNotice(`${t('content.importFailed')} ${reason}`);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function prepareUndo(item: ContentItem) {
    if (busy || !localImportSupported) return;
    const sequence = ++reviewSequence.current;
    setBusy(true);
    setNotice(null);
    try {
      const next = item.kind === 'mcp' && item.candidateId ? await prepareMcpUndo(item.candidateId)
        : item.hookSource ? await prepareHookUndo(item.hookSource, workspace?.id)
          : null;
      if (!alive.current || sequence !== reviewSequence.current) return;
      if (!next) { setNotice(t('content.undoUnavailable')); return; }
      setUndo({ item, review: next });
    } catch {
      if (alive.current && sequence === reviewSequence.current) setNotice(t('content.undoFailed'));
    } finally {
      if (alive.current && sequence === reviewSequence.current) setBusy(false);
    }
  }

  async function confirmUndo() {
    if (!undo || busy || !localImportSupported) return;
    const captured = undo;
    setBusy(true);
    setNotice(null);
    try {
      const result = await applyImportUndo(captured.review, workspace?.id);
      if (!alive.current) return;
      setCompleted((current) => { const next = new Set(current); next.delete(captured.item.id); return next; });
      setUndo(null);
      if (result.runtimeApplied) {
        notification.success(t('content.undoSuccess', { name: captured.item.name }), { duration: 3200 });
      } else {
        setNotice(t('content.undoRuntimePending', { name: captured.item.name }));
      }
      // Clear stale imported states immediately, then reload authoritative owners.
      if (captured.review.kind === 'hook') {
        const importId = captured.review.importId;
        setHooks((current) => current ? { ...current, imports: current.imports.filter((entry) => entry.importId !== importId) } : current);
      }
      if (captured.review.kind === 'mcp') void refreshMcpPlan(true);
      void loadSupplemental(true);
      void onRefresh().catch(() => { if (alive.current) setNotice(t('content.refreshAfterImportFailed')); });
    } catch (error) {
      if (alive.current) setNotice(`${t('content.undoFailed')} ${importErrorMessage(error)}`);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function prepareBatchUndo(group?: EcosystemImportItemKind, selectedOnly = false) {
    if (busy || !localImportSupported) return;
    setBusy(true); setNotice(null); setBatchUndoResults(null);
    try {
      const entries: BatchUndoEntry[] = [];
      for (const item of items.filter((entry) => (!group || entry.kind === group) && (!selectedOnly || (selected.has(entry.id)
        && `${entry.name} ${entry.description ?? ''} ${entry.sourceLocation ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))) && contentState(entry) === 'imported')) {
          const review = item.kind === 'mcp' && item.candidateId ? await prepareMcpUndo(item.candidateId)
          : item.hookSource ? await prepareHookUndo(item.hookSource, workspace?.id)
            : null;
        if (!alive.current) return;
        if (!review) throw new Error(t('content.undoUnavailable'));
        entries.push({ id: item.id, name: item.name, review });
      }
      setBatchUndo(entries);
    } catch (error) { if (alive.current) setNotice(`${t('content.undoFailed')} ${importErrorMessage(error)}`); }
    finally { if (alive.current) setBusy(false); }
  }

  async function confirmBatchUndo() {
    if (!batchUndo?.length || busy || !localImportSupported) return;
    setBusy(true); setBatchUndoResults([]);
    try {
      await applyEcosystemBatchUndo(batchUndo, workspace?.id, (result) => {
        if (!alive.current) return;
        setBatchUndoResults((current) => [...(current ?? []), result]);
        if (result.status !== 'failed') setCompleted((current) => { const next = new Set(current); next.delete(result.id); return next; });
      });
      if (!alive.current) return;
      setSelected(new Set());
      void loadSupplemental(true);
      void refreshMcpPlan(true);
      void onRefresh().catch(() => { if (alive.current) setNotice(t('content.refreshAfterImportFailed')); });
    } catch (error) { if (alive.current) setNotice(`${t('content.undoFailed')} ${importErrorMessage(error)}`); }
    finally { if (alive.current) setBusy(false); }
  }

  const reviewMcp = review?.kind === 'mcp' ? review.plan.items.find((entry) => entry.candidateId === review.item.candidateId) : undefined;
  const confirmDisabled = busy || !review || (review.kind === 'mcp'
    ? !reviewMcp || !['eligible', 'automatic_rename'].includes(reviewMcp.disposition)
    : review.plan.disposition === 'unavailable' || review.plan.handlers.length === 0);
  const categoryItems = items.filter((item) => item.kind === kind);
  // Category placeholders describe discovery in the overview; only real entries belong in the list.
  const categoryEntries = categoryItems.filter((item) => item.discovered);
  const visible = categoryEntries.filter((item) =>
    `${item.name} ${item.description ?? ''} ${item.sourceLocation ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const emptyState = categoryEntries.length === 0 && categoryItems[0]
    ? refreshing ? 'checking' : contentState(categoryItems[0]) : null;
  const canScanEmptyCategory = emptyState !== null
    && ['notDetected', 'notScanned', 'discoveryUnavailable', 'checking'].includes(emptyState);
  const copyActionsSupported = localImportSupported && (kind === 'mcp'
    || (kind === 'hook' && ['claude-code', 'codex'].includes(runtime.spec.ecosystemId)));
  const categoryDialogId = `${contentId}-category`;
  const requestedDetail = review?.item ?? detail;
  const viewed = requestedDetail?.kind === 'instruction'
    ? items.find((item) => item.id === requestedDetail.id && item.discovered) ?? null
    : requestedDetail;
  const mcpDetail = viewed?.kind === 'mcp' ? snapshot?.mcpServers?.find((entry) => entry.candidateId === viewed.candidateId)?.definition : undefined;
  const hookEntries = viewed?.hookSource ? hooks?.catalog.entries.filter((entry) => (
    entry.source.providerId === viewed.hookSource!.key.providerId && entry.source.sourceId === viewed.hookSource!.key.sourceId
  )) ?? [] : [];

  const refreshContent = async () => {
    if (busy || refreshing) return;
    setRefreshing(true);
    setContentRefreshVersion((value) => value + 1);
    setNotice(null);
    void refreshMcpPlan(true);
    const results = await Promise.allSettled([loadSupplemental(true), onRefresh()]);
    if (!alive.current) return;
    if (results.some((result) => result.status === 'rejected')) setNotice(t('content.scanFailed'));
    setRefreshing(false);
  };

  useImperativeHandle(refreshControlRef, () => ({ refresh: refreshContent }));
  useLayoutEffect(() => {
    onRefreshDisabledChange?.(busy || loading || refreshing);
  }, [busy, loading, refreshing, onRefreshDisabledChange]);

  return (
    <section className="ecosystem-compatibility__section" data-external-agent-content={runtime.spec.ecosystemId}>
      <div className="ecosystem-compatibility__section-heading ecosystem-compatibility__section-heading--actions">
        <div><h2>{t('content.title', { name: runtime.spec.name })}</h2><p>{t('content.description')}</p></div>
        {localImportSupported && items.some((item) => ['mcp', 'hook'].includes(item.kind)) ? (
          <div className="ecosystem-compatibility__import-action">
            <Button size="sm" variant="primary" disabled={busy || loading || planLoading} onClick={() => void prepareBatch()}>{t('content.importAll')}</Button>
            <Button size="sm" variant="outline" disabled={busy || loading || !items.some((item) => contentState(item) === 'imported')} onClick={() => void prepareBatchUndo()}>{t('content.undoAll')}</Button>
          </div>
        ) : null}
      </div>
      {notice && !kind && !review && !undo && !batch && !batchUndo ? <Alert className="ecosystem-compatibility__notice ecosystem-compatibility__feedback" role="status" showIcon={false} message={notice} /> : null}
      {loading ? <LoadingState size="sm">{t('loading')}</LoadingState> : null}
      <div className="ecosystem-compatibility__content-overview" role="table" aria-label={t('content.title', { name: runtime.spec.name })}>
        <div className="ecosystem-compatibility__content-summary ecosystem-compatibility__content-summary--header" role="row">
          <span role="columnheader">{t('import.columns.item')}</span>
          <span role="columnheader">{t('import.columns.source')}</span>
          <span role="columnheader">{t('import.columns.state')}</span>
        </div>
      {Array.from(new Set(items.map((item) => item.kind))).map((group) => {
        if (group === 'pet' && runtime.spec.id === 'codex') return <EcosystemPets key="pet" onCountChange={setPetCount} supported={localImportSupported} refreshVersion={contentRefreshVersion} open={petDialogOpen} onOpenChange={(open) => { setPetDialogOpen(open); setAccountExpanded(false); setSearch(''); setSelected(new Set()); }} />;
        const accountProvider = ecosystemAccountProvider(runtime.spec.id);
        if (group === 'account' && accountProvider) return <EcosystemAccounts key={`${group}:${accountProvider}`} provider={accountProvider} supported={localImportSupported} refreshVersion={contentRefreshVersion} expanded={accountExpanded} onToggle={() => { setAccountExpanded((expanded) => !expanded); setPetDialogOpen(false); setSearch(''); setSelected(new Set()); }} />;
        const groupItems = items.filter((item) => item.kind === group);
        const representative = groupItems[0];
        const count = groupItems.filter((item) => item.discovered).length;
        const discoverySupported = representative.discoverySupport === 'supported';
        const viewable = discoverySupported || count > 0;
        const description = !discoverySupported
          ? t('import.discoveryUnsupportedDescription', { name: runtime.spec.name, type: t(`capabilities.${group}`) })
          : presentation(representative).descriptionKey === 'content.lastKnownResult' ? t('content.lastKnownResult')
          : count > 0 ? t('content.groupSummary', { count: formatNumber(count) })
            : stateDescription(representative, contentState(representative));
        return <div key={group} data-content-group={group} role="rowgroup" className="ecosystem-compatibility__content-group">
          <div className="ecosystem-compatibility__content-summary" role="row" data-discovery-support={representative.discoverySupport}>
            <span role="cell" className="ecosystem-compatibility__import-item">
              <span className="ecosystem-compatibility__import-item-icon"><Icon {...CONTENT_ICONS[group]} size="md" /></span>
              <span className="ecosystem-compatibility__import-item-copy">
                <strong className="ecosystem-compatibility__content-title"><OverflowText>{t(`capabilities.${group}`)}</OverflowText></strong>
                <small>{description}</small>
              </span>
            </span>
            <span role="cell">{runtime.spec.name}</span>
            <span role="cell" className="ecosystem-compatibility__content-summary-state">
              {discoverySupported
                ? <StatusPill tone="neutral" title={t('import.states.discoverySupported')}>
                  {count > 0 ? t('content.itemCount', { count: formatNumber(count) })
                    : t(`import.states.${presentation(representative).state}`)}
                </StatusPill>
                : <OverflowText className="ecosystem-compatibility__unsupported-state">{t('import.states.discoveryUnsupported')}</OverflowText>}
              {viewable ? <IconButton size="sm" variant="quiet"
                icon={<Icon name="chevron-right" size="sm" />}
                aria-label={t('content.viewCategory', { type: t(`capabilities.${group}`) })}
                aria-haspopup="dialog" aria-controls={categoryDialogId}
                onClick={() => { setAccountExpanded(false); setPetDialogOpen(false); setKind(group); setSearch(''); setSelected(new Set()); setNotice(null); }} /> : null}
            </span>
          </div>
        </div>;
      })}
      </div>
      <Dialog
        id={categoryDialogId}
        className="ecosystem-compatibility__catalog-dialog"
        data-ecosystem-category={kind ?? undefined}
        open={kind !== null}
        onOpenChange={(open) => { if (!open && !busy) { setKind(null); setSearch(''); setSelected(new Set()); setNotice(null); } }}
        size="xl"
        closeOnEscape={!busy}
        closeOnPointerOutside={!busy}
      >
        {kind ? <>
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{runtime.spec.name} · {t(`capabilities.${kind}`)}</DialogTitle>
            </DialogHeading>
            <DialogHeaderActions>
              <IconButton size="sm" variant="quiet" icon={<Icon name="refresh" size="sm" />} aria-label={t('content.refresh')} title={t('content.refresh')} disabled={busy || loading || refreshing} onClick={() => void refreshContent()} />
              {!busy ? <DialogClose /> : null}
            </DialogHeaderActions>
          </DialogHeader>
          <DialogBody className="ecosystem-compatibility__catalog-body">
            {categoryEntries.length > 0 ? <div className="ecosystem-compatibility__content-filters">
              <SearchField value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('content.search')} aria-label={t('content.search')} />
              {copyActionsSupported && visible.length > 0 ? <>
                <Button size="sm" variant="outline" disabled={busy || loading || planLoading} onClick={() => void prepareBatch(kind)}>{t('content.importCategory')}</Button>
                <Button size="sm" variant="outline" disabled={busy || !visible.some((item) => selected.has(item.id) && presentation(item).canImport)} onClick={() => void prepareBatch(kind, true)}>{t('content.importSelected')}</Button>
                <Button size="sm" variant="outline" disabled={busy || !visible.some((item) => selected.has(item.id) && contentState(item) === 'imported')} onClick={() => void prepareBatchUndo(kind, true)}>{t('content.undoSelected')}</Button>
                <span>{t('content.selectedCount', { count: formatNumber(visible.filter((item) => selected.has(item.id)).length) })}</span>
              </> : null}
            </div> : null}
            {notice && !review && !undo && !batch && !batchUndo ? <Alert className="ecosystem-compatibility__notice ecosystem-compatibility__feedback" role="status" showIcon={false} message={notice} /> : null}
            <ScrollArea className={`ecosystem-compatibility__content-list${visible.length === 0 ? ' ecosystem-compatibility__content-list--empty' : ''}`} tabIndex={0} aria-label={t(`capabilities.${kind}`)}>
            {kind === 'skill' && !skillManagementSupported ? <Alert showIcon={false} message={t('content.skills.unsupported')} /> : null}
            {kind === 'skill' ? skillDiagnostics.map((entry) => <Alert key={`${entry.path}:${entry.message}`} role="status" className="ecosystem-compatibility__notice" showIcon={false} message={<>{entry.path}: {entry.message}</>} />) : null}
            {visible.length > 0 ? <div className="ecosystem-compatibility__import-table" role="table" aria-label={t('content.title', { name: runtime.spec.name })}>
              <div className="ecosystem-compatibility__import-row ecosystem-compatibility__import-row--header" role="row">
                <span role="columnheader" className="ecosystem-compatibility__selection-cell">{localImportSupported && !['instruction', 'skill'].includes(kind ?? '') ? <Checkbox size="sm" aria-label={t('content.selectVisible')} disabled={busy} checked={visible.every((item) => selected.has(item.id))} onChange={(event) => { const checked = event.target.checked; setSelected((current) => { const next = new Set(current); visible.forEach((item) => checked ? next.add(item.id) : next.delete(item.id)); return next; }); }} /> : null}{t('import.columns.item')}</span><span role="columnheader">{t('import.columns.source')}</span><span role="columnheader">{t(kind === 'skill' ? 'content.skills.availability' : 'content.importStatus')}</span><span role="columnheader">{t('import.columns.action')}</span>
              </div>
              {visible.map((item) => {
                const { state, canImport: importable } = presentation(item);
                return <div key={item.id} className="ecosystem-compatibility__import-row" role="row" data-import-kind={item.kind} data-import-state={state} data-discovery-support={item.discoverySupport} data-import-discovered={item.discovered ? 'true' : 'false'}>
                  <span role="cell" className="ecosystem-compatibility__selection-cell">{localImportSupported && !['instruction', 'skill'].includes(item.kind) ? <Checkbox size="sm" aria-label={t('content.selectItem', { name: item.name })} checked={selected.has(item.id)} disabled={busy} onChange={(event) => { const checked = event.target.checked; setSelected((current) => { const next = new Set(current); if (checked) next.add(item.id); else next.delete(item.id); return next; }); }} /> : null}<span className="ecosystem-compatibility__import-item-copy"><strong><OverflowText>{item.name}</OverflowText></strong><small>{t(`capabilities.${item.kind}`)} · {item.skill ? item.skill.description : stateDescription(item, state)}</small></span></span>
                  <span role="cell" className="ecosystem-compatibility__import-source"><strong>{item.sourceName}</strong><small>{item.sourceLocation}</small>{item.skill ? <small>{t(item.skill.level === 'user' ? 'content.instructions.user' : 'content.instructions.project')}{item.skill.isShadowed ? ` · ${t('content.skills.sameName')}` : ''}</small> : null}{item.instruction ? <small>{t(item.instruction.scope === 'user' ? 'content.instructions.user' : 'content.instructions.project')} · {t(item.instruction.pathPatterns.length ? 'content.instructions.conditional' : 'content.instructions.startup')}</small> : null}</span>
                  <span role="cell">{state === 'discoveryUnsupported'
                    ? <OverflowText className="ecosystem-compatibility__unsupported-state">{t('import.states.discoveryUnsupported')}</OverflowText>
                    : <StatusPill tone={state === 'imported' ? 'success' : 'neutral'}>{t(state === 'review' ? 'content.reviewRequired' : `import.states.${state}`)}</StatusPill>}</span>
                  <span role="cell" className="ecosystem-compatibility__import-action">
                    <Button size="sm" variant="text" disabled={busy} aria-label={`${t('content.view')} ${item.name}`} onClick={() => { setNotice(null); setDetail(item); }}>{t('content.view')}</Button>
                    {item.skill ? <Switch checked={!skillDisabled(item.skill)} disabled={busy || !skillManagementSupported || cache.staleSkillKeys?.has(item.skill.key)} aria-label={t('content.skills.toggle', { name: item.name })} onChange={(event) => void toggleSkill(item.skill!, event.target.checked)} /> : null}
                    {importable ? <Button size="sm" variant="outline" disabled={busy} aria-label={`${t('content.prepareImport')} ${item.name}`} onClick={() => void prepareImport(item)}>{t('content.prepareImport')}</Button> : null}
                    {state === 'imported' && localImportSupported && ['mcp', 'hook'].includes(item.kind) ? <Button size="sm" variant="text" disabled={busy} onClick={() => openNativeManagement(item.kind)}>{t('content.manageCopy')}</Button> : null}
                    {state === 'imported' && localImportSupported ? <Button size="sm" variant="text" disabled={busy} aria-label={`${t('content.undo')} ${item.name}`} onClick={() => void prepareUndo(item)}>{t('content.undo')}</Button> : null}
                  </span>
                </div>;
              })}
            </div> : <div className="ecosystem-compatibility__content-empty" data-content-empty-state={emptyState ?? 'noMatches'} role="status">
              {emptyState === 'checking' ? <LoadingState size="sm">{t('import.states.checking')}</LoadingState>
                : <p>{kind === 'instruction' && emptyState === 'discoveryUnavailable' && categoryItems[0]
                  ? stateDescription(categoryItems[0], emptyState)
                  : t(emptyState ? `import.states.${emptyState}` : 'content.noMatches')}</p>}
              {canScanEmptyCategory ? <Button size="sm" variant="outline" disabled={busy || emptyState === 'checking'} onClick={() => void refreshContent()}>{t('content.scan')}</Button> : null}
            </div>}
            {kind === 'instruction' && instructions?.failedEcosystems.some((id) => id === 'shared' || id === runtime.spec.ecosystemId) ? <p role="status">{t('content.instructions.partial')}</p> : null}
            </ScrollArea>
          </DialogBody>
        </> : null}
      </Dialog>
      <Dialog className="ecosystem-compatibility__batch-dialog" open={batchUndo !== null} onOpenChange={(open) => { if (!open && !busy) { setBatchUndo(null); setNotice(null); } }} size="lg" closeOnPointerOutside={!busy}>
        <DialogHeader><DialogHeading><DialogTitle>{t(batchUndoResults ? busy ? 'content.batchUndoing' : 'content.batchUndoResults' : 'content.batchUndoTitle')}</DialogTitle></DialogHeading>{!busy ? <DialogClose /> : null}</DialogHeader>
        <EcosystemBatchLayout entries={batchUndo ?? []} getKind={(entry) => entry.review.kind} busy={busy} processed={batchUndoResults?.length}
          summary={batchUndoResults ? t('content.batchUndoSummary', {
            removed: formatNumber(batchUndoResults.filter((result) => result.status === 'removed').length),
            pending: formatNumber(batchUndoResults.filter((result) => result.status === 'pending').length),
            failed: formatNumber(batchUndoResults.filter((result) => result.status === 'failed').length),
          }) : t('content.batchUndoWarning', { count: formatNumber(batchUndo?.length ?? 0) })}
          renderEntry={(entry) => {
            const result = batchUndoResults?.find((item) => item.id === entry.id);
            return <section className="ecosystem-compatibility__review-section"><strong>{entry.name}</strong><p className="ecosystem-compatibility__path">{entry.review.target}</p>
              {batchUndoResults ? <StatusPill tone={result?.status === 'removed' ? 'success' : result?.status === 'failed' ? 'danger' : 'neutral'}>{result ? t(`content.batchUndoState.${result.status}`) : t('content.batchPending')}</StatusPill> : null}
              {result?.error ? <p className="ecosystem-compatibility__feedback ecosystem-compatibility__feedback--error">{result.error}</p> : null}
            </section>;
          }}>
          {!batchUndo?.length ? <p>{t('content.undoEmpty')}</p> : null}
          {notice ? <Alert role="alert" className="ecosystem-compatibility__notice ecosystem-compatibility__feedback ecosystem-compatibility__feedback--error" showIcon={false} message={notice} /> : null}
        </EcosystemBatchLayout>
        <DialogFooter><Button size="sm" variant="fill" disabled={busy} onClick={() => setBatchUndo(null)}>{t(batchUndoResults ? 'content.close' : 'content.cancel')}</Button>
          {!batchUndoResults ? <Button size="sm" variant="primary" tone="danger" disabled={busy || !batchUndo?.length} loading={busy} onClick={() => void confirmBatchUndo()}>{t('content.confirmUndo')}</Button> : null}
        </DialogFooter>
      </Dialog>
      <Dialog className="ecosystem-compatibility__batch-dialog" open={batch !== null} onOpenChange={(open) => { if (!open && !busy) { setBatch(null); setNotice(null); } }} size="lg" closeOnPointerOutside={!busy}>
        <DialogHeader><DialogHeading><DialogTitle>{t(batchResults ? busy ? 'content.batchImporting' : 'content.batchResults' : 'content.batchTitle')}</DialogTitle></DialogHeading>{!busy ? <DialogClose /> : null}</DialogHeader>
        <EcosystemBatchLayout entries={batch ?? []} getKind={(entry) => entry.kind} busy={busy} processed={batchResults?.length}
          summary={batchResults ? t('content.batchResultSummary', {
            imported: formatNumber(batchResults.filter((result) => result.status === 'imported').length),
            unresolved: formatNumber(batchResults.filter((result) => result.status !== 'imported').length),
            skipped: formatNumber(batchSkipped),
          }) : t('content.batchDescription', { count: formatNumber(batch?.length ?? 0), skipped: formatNumber(batchSkipped) })}
          renderEntry={(entry) => {
            const result = batchResults?.find((item) => item.id === entry.id);
            return <section className="ecosystem-compatibility__review-section"><strong>{entry.name}</strong>
              {batchResults ? <>
                <StatusPill tone={result?.status === 'imported' ? 'success' : result?.status === 'failed' ? 'danger' : 'neutral'}>{result ? t(`content.batchState.${result.status}`) : t('content.batchPending')}</StatusPill>
                {result?.error ? <p className="ecosystem-compatibility__feedback ecosystem-compatibility__feedback--error">{result.error}</p> : null}
              </> : <><p>{t('content.nativeUserTarget')}</p>
              {entry.kind === 'hook' ? <p>{entry.plan.source.locationHint}</p> : null}
              {entry.kind === 'hook' ? <><p>{t('content.hookWarning')}</p>{entry.plan.handlers.map((handler) => <div key={handler.stableKey}><p>{handler.event}{handler.matcher ? ` · ${handler.matcher}` : ''}</p><pre>{handler.command}</pre>{handler.commandWindows ? <pre>{handler.commandWindows}</pre> : null}{handler.dependencies.map((dependency) => <p key={dependency.kind === 'managed' ? dependency.relativePath : dependency.location}>{dependency.kind === 'managed' ? dependency.relativePath : dependency.location}</p>)}</div>)}{entry.plan.skipped.map((entry) => <p key={entry.reasonCode}>{t('content.skipped', { reason: entry.reasonCode, count: formatNumber(entry.count) })}</p>)}</> : null}
              {entry.kind === 'mcp' ? <p>{t('content.mcpTarget', { name: entry.plan.items.find((item) => item.candidateId === entry.candidateId)?.proposedNativeId ?? entry.name })}</p> : null}
             </>}
            </section>;
          }}>
          {!batch?.length ? <p>{t('content.batchEmpty')}</p> : null}
          {notice ? <Alert role="status" className="ecosystem-compatibility__notice" showIcon={false} message={notice} /> : null}
        </EcosystemBatchLayout>
        <DialogFooter><Button size="sm" variant="fill" disabled={busy} onClick={() => setBatch(null)}>{t(batchResults ? 'content.close' : 'content.cancel')}</Button>
          {!batchResults ? <Button size="sm" variant="primary" disabled={busy || !batch?.length} loading={busy} onClick={() => void confirmBatch()}>{t('content.confirm')}</Button> : null}
        </DialogFooter>
      </Dialog>
      <Dialog open={undo !== null} onOpenChange={(open) => { if (!open && !busy) { setUndo(null); setNotice(null); } }} size="md" closeOnPointerOutside={!busy}>
        <DialogHeader><DialogHeading><DialogTitle>{t('content.undoTitle')}</DialogTitle></DialogHeading>{!busy ? <DialogClose /> : null}</DialogHeader>
        <DialogBody>
          {undo ? <div className="ecosystem-compatibility__content-detail">
            <strong className="ecosystem-compatibility__detail-name">{undo.item.name}</strong><p className="ecosystem-compatibility__feedback">{t('content.undoWarning')}</p>
            <section className="ecosystem-compatibility__review-section"><h3>{t('content.nativeCopy')}</h3><p className="ecosystem-compatibility__path">{undo.review.target}</p></section>
            {notice ? <Alert role="alert" className="ecosystem-compatibility__notice ecosystem-compatibility__feedback ecosystem-compatibility__feedback--error" showIcon={false} message={notice} /> : null}
          </div> : null}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="fill" disabled={busy} onClick={() => setUndo(null)}>{t('content.cancel')}</Button>
          <Button size="sm" variant="primary" tone="danger" disabled={busy} loading={busy} onClick={() => void confirmUndo()}>{t('content.confirmUndo')}</Button>
        </DialogFooter>
      </Dialog>
      <Dialog open={viewed !== null} onOpenChange={(open) => { if (!open && !busy) { reviewSequence.current += 1; setReview(null); setDetail(null); setNotice(null); } }} size="lg" closeOnPointerOutside={!busy}>
        <DialogHeader><DialogHeading><DialogTitle>{review ? t('content.confirmTitle') : viewed?.name}</DialogTitle></DialogHeading>{!busy ? <DialogClose /> : null}</DialogHeader>
        <DialogBody>
          {viewed ? <div className="ecosystem-compatibility__content-detail">
            <div className="ecosystem-compatibility__detail-heading"><strong className="ecosystem-compatibility__detail-name">{viewed.name}</strong><StatusPill tone="neutral">{runtime.spec.name} · {t(`capabilities.${viewed.kind}`)}</StatusPill></div>
            <section className="ecosystem-compatibility__review-section"><h3>{t('content.sourceLocation')}</h3><p className="ecosystem-compatibility__path">{viewed.sourceLocation}</p></section>
            {viewed.description ? <section className="ecosystem-compatibility__review-section"><h3>{t('content.descriptionLabel')}</h3><p>{viewed.description}</p></section> : null}
            {stateDescription(viewed, contentState(viewed)) !== viewed.description ? <p className="ecosystem-compatibility__feedback">{stateDescription(viewed, contentState(viewed))}</p> : null}
            {viewed.instruction ? <><p>{t('content.instructions.description')}</p><dl className="ecosystem-compatibility__metadata">
              <dt>{t('content.instructions.scope')}</dt><dd>{t(viewed.instruction.scope === 'user' ? 'content.instructions.user' : 'content.instructions.project')}</dd>
              <dt>{t('content.instructions.application')}</dt><dd>{t(viewed.instruction.pathPatterns.length ? 'content.instructions.conditional' : 'content.instructions.startup')}</dd>
              {viewed.instruction.pathPatterns.length ? <><dt>{t('content.instructions.patterns')}</dt><dd>{viewed.instruction.pathPatterns.join(', ')}</dd></> : null}
            </dl></> : null}
            {mcpDetail ? <dl className="ecosystem-compatibility__metadata"><dt>{t('content.transport')}</dt><dd>{mcpDetail.transport}</dd><dt>{t('content.command')}</dt><dd>{mcpDetail.commandPreview ?? mcpDetail.remoteUrlPreview ?? '—'}</dd><dt>{t('content.environmentKeys')}</dt><dd>{mcpDetail.environmentKeys?.join(', ') || '—'}</dd><dt>{t('content.headerNames')}</dt><dd>{mcpDetail.headerNames?.join(', ') || '—'}</dd></dl> : null}
            {hookEntries.map((entry) => <p key={entry.stableKey}>{entry.nativeEvent} · {entry.handlerKind}{entry.matcher.kind === 'pattern' ? ` · ${entry.matcher.display}` : ''}</p>)}
            {review ? <>
              <p className="ecosystem-compatibility__feedback">{t('content.copyWarning')}</p>
              {review.kind === 'mcp' ? <p>{t('content.mcpTarget', { name: reviewMcp?.proposedNativeId ?? review.item.name })}</p> : null}
              {review.kind === 'hook' ? <>
                <p>{t('content.hookWarning')}</p>
                {review.plan.handlers.map((handler) => <section key={handler.stableKey}><h4>{handler.event}{handler.matcher ? ` · ${handler.matcher}` : ''}</h4><pre>{handler.command}</pre>{handler.commandWindows ? <pre>{handler.commandWindows}</pre> : null}{handler.dependencies.map((dependency) => <p key={dependency.kind === 'managed' ? dependency.relativePath : dependency.location}>{dependency.kind === 'managed' ? dependency.relativePath : dependency.location}</p>)}</section>)}
                {review.plan.skipped.map((entry) => <p key={entry.reasonCode}>{t('content.skipped', { reason: entry.reasonCode, count: formatNumber(entry.count) })}</p>)}
              </> : null}
              {notice ? <Alert role="alert" className="ecosystem-compatibility__notice ecosystem-compatibility__feedback ecosystem-compatibility__feedback--error" showIcon={false} message={notice} /> : null}
            </> : null}
          </div> : null}
        </DialogBody>
        {review ? <DialogFooter>
          <Button size="sm" variant="fill" disabled={busy} onClick={() => { setReview(null); setDetail(null); setNotice(null); }}>{t('content.cancel')}</Button>
          <Button size="sm" variant="primary" disabled={confirmDisabled} loading={busy} onClick={() => void confirmImport()}>{t('content.confirm')}</Button>
        </DialogFooter> : null}
      </Dialog>
    </section>
  );
}
