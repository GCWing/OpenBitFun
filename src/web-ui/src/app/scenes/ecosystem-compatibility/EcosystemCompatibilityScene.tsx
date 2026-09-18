import {
  Button,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogHeaderActions,
  DialogHeading,
  DialogTitle,
  Icon,
  IconButton,
  LoadingState,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelHeader,
  NavigationPanelItem,
  NavigationPanelSection,
  OverflowText,
  ScrollArea,
  SearchField,
  Select,
  StatusPill,
  Switch,
  Textarea,
  Tooltip,
} from '@openbitfun/ui';
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import {
  externalSourcesAPI,
  type ExternalSourceCatalogSnapshot,
} from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import {
  ACPClientAPI,
  type AcpClientInfo,
} from '@/infrastructure/api/service-api/ACPClientAPI';
import { useNotification } from '@/shared/notification-system';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { WorkspaceKind } from '@/shared/types';
import {
  buildEcosystemProductRuntimes,
  totalDiscoveredAssets,
  type EcosystemProductId,
  type EcosystemProductRuntime,
} from './ecosystemCompatibilityModel';
import ExternalAgentContent, { type ExternalAgentContentHandle } from './ExternalAgentContent';
import { EcosystemDialog as Dialog } from './EcosystemDialog';
import ExternalDiscoveryToggle from './ExternalDiscoveryToggle';
import { ecosystemDiscoveryCache, rememberEcosystemCatalog } from './ecosystemDiscoveryCache';
import { useEcosystemCompatibilityStore } from './ecosystemCompatibilityStore';
import './EcosystemCompatibilityScene.scss';

const AcpAgentsConfig = lazy(
  () => import('@/infrastructure/config/components/AcpAgentsConfig'),
);
const PRODUCT_ICON_SOURCES: Record<EcosystemProductId, string> = {
  'claude-code': '/assets/ecosystem-compatibility/claude-code.svg',
  codex: '/assets/ecosystem-compatibility/codex.svg',
  pi: '/assets/ecosystem-compatibility/pi.svg',
  dsh: '/assets/ecosystem-compatibility/deepseek-harness.svg',
  opencode: '/assets/ecosystem-compatibility/opencode.svg',
  cursor: '/assets/ecosystem-compatibility/cursor.svg',
};

function EcosystemProductIcon({ productId, size }: {
  productId: EcosystemProductId;
  size: number;
}) {
  const source = PRODUCT_ICON_SOURCES[productId];
  if (productId === 'cursor') return (
    <span
      className="ecosystem-compatibility__brand-image ecosystem-compatibility__brand-image--monochrome"
      data-product-logo={productId}
      aria-hidden="true"
      style={{ width: size, height: size, maskImage: `url("${source}")` }}
    />
  );
  return (
    <img
      className="ecosystem-compatibility__brand-image"
      src={source}
      alt=""
      width={size}
      height={size}
      draggable={false}
    />
  );
}

const GROUP_ORDER = ['identified', 'more', 'other'] as const;

type LoadIssue = 'externalSources' | 'acpClients';
interface AcpSubagentDraft {
  enabled: boolean;
  description: string;
  bestFor: string;
}

const ACP_SUBAGENT_PROFILE_MAX_LENGTH = 320;

function OwnerSurfaceLoading({ label }: { label: string }) {
  return (
    <LoadingState className="ecosystem-compatibility__owner-loading" role="status" size="sm">
      {label}
    </LoadingState>
  );
}

const EcosystemCompatibilityScene: React.FC = () => {
  const { t, formatNumber } = useI18n([
    'scenes/ecosystem-compatibility',
    'settings/external-apps',
    'settings/acp-agents',
  ]);
  const notification = useNotification();
  const { workspace, workspacePath } = useCurrentWorkspace();
  const peerDevice = usePeerDeviceModeOptional();
  const peerDeviceId = peerDevice?.peerMode.active ? peerDevice.peerMode.deviceId : undefined;
  // Discovery results are owned by the (peer, workspace ID) pair; the path is
  // an IO projection and must not fork the cache when a checkout moves.
  const requestScope = JSON.stringify([peerDeviceId, workspace?.id]);
  const requestSequence = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const acpManagerRef = useRef<React.ComponentRef<typeof AcpAgentsConfig>>(null);
  const discoveryControlRef = useRef<HTMLDivElement>(null);
  const externalContentRef = useRef<ExternalAgentContentHandle>(null);
  const [contentRefreshDisabled, setContentRefreshDisabled] = useState(true);
  const [snapshotState, setSnapshotState] = useState<{ scope: string; value: ExternalSourceCatalogSnapshot | null }>();
  const [clientState, setClientState] = useState<{ scope: string; value: AcpClientInfo[] }>();
  const [supplementalState, setSupplementalState] = useState<{ scope: string; counts: Record<string, number> }>();
  const supplementalCounts = supplementalState?.scope === requestScope ? supplementalState.counts : undefined;
  const onSupplementalCounts = useCallback((counts: Record<string, number>) => {
    setSupplementalState((current) => current?.scope === requestScope
      && JSON.stringify(current.counts) === JSON.stringify(counts) ? current : { scope: requestScope, counts });
  }, [requestScope]);
  const snapshot = snapshotState?.scope === requestScope ? snapshotState.value : ecosystemDiscoveryCache(requestScope).catalog ?? null;
  const acpClients = useMemo(() => clientState?.scope === requestScope ? clientState.value : ecosystemDiscoveryCache(requestScope).clients ?? [], [clientState, requestScope]);
  const setSnapshot = useCallback((value: ExternalSourceCatalogSnapshot | null) => {
    const next = value ? rememberEcosystemCatalog(requestScope, value) : ecosystemDiscoveryCache(requestScope).catalog ?? null;
    setSnapshotState({ scope: requestScope, value: next });
  }, [requestScope]);
  const setAcpClients = useCallback((value: AcpClientInfo[]) => {
    ecosystemDiscoveryCache(requestScope).clients = value;
    setClientState({ scope: requestScope, value });
  }, [requestScope]);
  const [loadIssues, setLoadIssues] = useState<LoadIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const selectedProductId = useEcosystemCompatibilityStore((state) => state.selectedProductId);
  const ownerSurface = useEcosystemCompatibilityStore((state) => state.ownerSurface);
  const selectProduct = useEcosystemCompatibilityStore((state) => state.selectProduct);
  const setOwnerSurface = useEcosystemCompatibilityStore((state) => state.setOwnerSurface);
  useEffect(() => {
    if (ownerSurface !== 'external-sources') return;
    if (contentRef.current) contentRef.current.scrollTop = 0;
    discoveryControlRef.current?.focus();
    setOwnerSurface(null);
  }, [ownerSurface, setOwnerSurface]);
  const [editingSubagentClientId, setEditingSubagentClientId] = useState<string | null>(null);
  const [savingSubagentClientId, setSavingSubagentClientId] = useState<string | null>(null);
  const [subagentDraft, setSubagentDraft] = useState<AcpSubagentDraft>({
    enabled: true,
    description: '',
    bestFor: '',
  });

  const loadCompatibility = useCallback(async (
    forceRefresh: boolean,
    backgroundRequest?: { isCurrent: () => boolean },
  ) => {
    const sequence = ++requestSequence.current;
    if (!forceRefresh && !backgroundRequest) setLoading(true);

    const [sourceResult, clientsResult] = await Promise.allSettled([
      externalSourcesAPI.getDiscoverySnapshot(workspace?.id, forceRefresh),
      ACPClientAPI.getClients(),
    ]);
    if (sequence !== requestSequence.current || backgroundRequest?.isCurrent() === false) return undefined;

    const nextIssues: LoadIssue[] = [];
    if (sourceResult.status === 'fulfilled') {
      setSnapshot(sourceResult.value);
    } else {
      nextIssues.push('externalSources');
    }
    if (clientsResult.status === 'fulfilled') {
      setAcpClients(clientsResult.value);
    } else {
      nextIssues.push('acpClients');
    }
    setLoadIssues(nextIssues);
    setLoading(false);
    return sourceResult.status === 'fulfilled' ? sourceResult.value : undefined;
  }, [setAcpClients, setSnapshot, workspace?.id]);

  useEffect(() => {
    setSnapshot(null);
    setLoadIssues([]);
    void loadCompatibility(false);
    return () => {
      requestSequence.current += 1;
    };
  }, [loadCompatibility, setAcpClients, setSnapshot]);

  useEffect(() => {
    // Reading completion never starts a scan when automatic discovery is off.
    if (!snapshot?.discoveryPending) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const poll = () => {
      const delays = [300, 750, 1500, 3000];
      timer = window.setTimeout(async () => {
        const next = await loadCompatibility(false, { isCurrent: () => !cancelled });
        if (cancelled || (next && !next.discoveryPending)) return;
        attempt += 1;
        poll();
      }, delays[Math.min(attempt, delays.length - 1)]);
    };
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadCompatibility, snapshot?.discoveryPending]);

  useEffect(() => {
    const refreshClients = () => {
      void loadCompatibility(false);
    };
    window.addEventListener('openbitfun:acp-clients-changed', refreshClients);
    window.addEventListener('openbitfun:acp-requirements-changed', refreshClients);
    return () => {
      window.removeEventListener('openbitfun:acp-clients-changed', refreshClients);
      window.removeEventListener('openbitfun:acp-requirements-changed', refreshClients);
    };
  }, [loadCompatibility]);

  const productRuntimes = useMemo(
    () => buildEcosystemProductRuntimes(snapshot, acpClients).map((runtime): EcosystemProductRuntime => (
      runtime.group === 'more' && ((supplementalCounts?.[runtime.spec.ecosystemId] ?? 0) > 0
        || ecosystemDiscoveryCache(requestScope).identified.has(runtime.spec.ecosystemId))
        ? { ...runtime, group: 'identified' } : runtime
    )),
    [acpClients, snapshot, supplementalCounts, requestScope],
  );
  const selectedRuntime = productRuntimes.find(
    (runtime) => runtime.spec.id === selectedProductId,
  ) ?? productRuntimes[0];
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredRuntimes = productRuntimes.filter((runtime) => {
    if (!normalizedSearch) return true;
    const searchable = [
      runtime.spec.name,
      runtime.spec.id,
      runtime.spec.ecosystemId,
      runtime.spec.acpClientId,
      ...runtime.spec.searchTerms,
      ...runtime.capabilityIds,
    ].filter(Boolean).join(' ').toLowerCase();
    return searchable.includes(normalizedSearch);
  });

  useEffect(() => {
    setEditingSubagentClientId(null);
    setSavingSubagentClientId(null);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [selectedProductId]);

  const showDevelopmentNotice = useCallback((name: string) => {
    notification.info(t('comingSoon.notice', { name }), {
      title: t('comingSoon.title'),
      duration: 3200,
    });
  }, [notification, t]);

  const handleSelectProduct = useCallback((runtime: EcosystemProductRuntime) => {
    selectProduct(runtime.spec.id);
    if (runtime.spec.development) {
      showDevelopmentNotice(runtime.spec.name);
    }
  }, [selectProduct, showDevelopmentNotice]);

  const handleStartAcpClient = useCallback((client: AcpClientInfo) => {
    if (!workspace?.id) {
      notification.info(t('run.workspaceRequired'), { duration: 3200 });
      return;
    }
    if (!client.enabled || client.status === 'failed') {
      notification.info(t('run.configurationRequired', { name: client.name || client.id }), {
        duration: 3200,
      });
      setOwnerSurface('acp');
      return;
    }
    window.dispatchEvent(new CustomEvent('openbitfun:create-acp-session', {
      detail: { clientId: client.id },
    }));
    notification.info(t('run.starting', { name: client.name || client.id }), { duration: 2400 });
  }, [notification, setOwnerSurface, t, workspace?.id]);

  const handleConfigureSubagent = useCallback((client: AcpClientInfo) => {
    if (!client.subagent) return;
    setSubagentDraft({
      enabled: client.subagent.enabled,
      description: client.subagent.description ?? '',
      bestFor: client.subagent.bestFor ?? '',
    });
    setEditingSubagentClientId(client.id);
  }, []);

  const handleSaveSubagent = useCallback(async (client: AcpClientInfo) => {
    if (!client.subagent || savingSubagentClientId) return;
    setSavingSubagentClientId(client.id);
    try {
      await ACPClientAPI.updateClientSubagentConfig({
        clientId: client.id,
        enabled: subagentDraft.enabled,
        description: subagentDraft.description,
        bestFor: subagentDraft.bestFor,
      });
      notification.success(t('run.subagent.notifications.saved', {
        name: client.name || client.id,
      }));
      setEditingSubagentClientId(null);
      await loadCompatibility(false);
    } catch {
      notification.error(t('run.subagent.notifications.failed', {
        name: client.name || client.id,
      }));
    } finally {
      setSavingSubagentClientId(null);
    }
  }, [loadCompatibility, notification, savingSubagentClientId, subagentDraft, t]);

  if (!selectedRuntime) return null;

  const currentHost = workspace?.workspaceKind === WorkspaceKind.Remote
    ? t('host.remote', { name: workspace.sshHost || workspace.name })
    : peerDevice?.peerMode.active
      ? t('host.remote', { name: peerDevice.peerMode.deviceName })
      : isTauriRuntime() ? t('host.local') : t('host.remote', { name: window.location.hostname });
  const adapterLabel = selectedRuntime.adapterRevision
    ? t('header.adapterRevision', { revision: selectedRuntime.adapterRevision })
    : selectedRuntime.spec.acpClientId
      ? t('header.acpRuntime')
      : null;
  const sourceLocationFallback = snapshot?.discovery
    ? !snapshot.discovery.hasScanned
      ? t(snapshot.discovery.enabled ? 'loading' : 'import.states.notScanned')
      : loadIssues.includes('externalSources') ? t('import.states.discoveryUnavailable') : t('header.notDetected')
    : snapshot?.integrationPolicy.status === 'compatible'
    && !snapshot.integrationPolicy.effective.enabled
    ? t('import.states.discoveryDisabled')
    : loading || snapshot?.discoveryPending
      ? t('loading')
      : loadIssues.includes('externalSources')
        ? t('import.states.discoveryUnavailable')
        : t('header.notDetected');

  const renderProductSummary = (runtime: EcosystemProductRuntime): string => {
    const assetCount = totalDiscoveredAssets(runtime.capabilityCounts)
      + (supplementalCounts?.[runtime.spec.ecosystemId] ?? 0);
    if (runtime.spec.development) return t('productSummary.development');
    if (assetCount > 0) {
      return t('productSummary.assets', { count: formatNumber(assetCount) });
    }
    if (runtime.acpClients.length > 0) {
      return t('productSummary.acpClients', { count: formatNumber(runtime.acpClients.length) });
    }
    return t('productSummary.available');
  };

  const renderRun = () => (
    <div className="ecosystem-compatibility__view-stack">
      <section className="ecosystem-compatibility__section">
        <div className="ecosystem-compatibility__section-heading ecosystem-compatibility__section-heading--actions">
          <div>
            <div className="ecosystem-compatibility__section-title">
              <h2>{t('run.title')}</h2>
              {selectedRuntime.acpClients.length === 0 ? (
                <Tooltip
                  content={t('run.notConfiguredDescription', { name: selectedRuntime.spec.name })}
                  trigger="hover-focus"
                  placement="top"
                >
                  <StatusPill className="ecosystem-compatibility__run-status" tone="neutral" tabIndex={0}>
                    {t('run.notConfiguredTitle', { name: selectedRuntime.spec.name })}
                  </StatusPill>
                </Tooltip>
              ) : null}
            </div>
            <p>{t('run.description', { name: selectedRuntime.spec.name })}</p>
          </div>
          <Button
            className="ecosystem-compatibility__section-action"
            size="sm"
            variant="outline"
            aria-haspopup="dialog"
            aria-controls="ecosystem-acp-manager"
            onClick={() => setOwnerSurface('acp')}
          >
            {t('run.openManager')}
          </Button>
        </div>
        {selectedRuntime.acpClients.length > 0 ? (
          <div className="ecosystem-compatibility__runtime-list">
            {selectedRuntime.acpClients.map((client) => {
              const profile = client.subagent;
              const profileSupported = profile !== undefined;
              const hasProfile = Boolean(
                profile?.description?.trim() || profile?.bestFor?.trim(),
              );
              const profileState = !profileSupported
                ? 'unsupportedHost'
                : !client.enabled
                  ? 'clientDisabled'
                  : !profile.enabled
                    ? 'disabled'
                    : hasProfile
                      ? 'configured'
                      : 'defaultProfile';
              const editingProfile = editingSubagentClientId === client.id;
              const savingProfile = savingSubagentClientId === client.id;
              const displayName = client.name || client.id;

              return (
                <article className="ecosystem-compatibility__runtime-agent" key={client.id}>
                  <div className="ecosystem-compatibility__runtime-row">
                    <div className="ecosystem-compatibility__runtime-copy">
                      <strong><OverflowText>{displayName}</OverflowText></strong>
                      <StatusPill tone={client.status === 'failed' ? 'danger' : client.status === 'running' ? 'success' : 'neutral'}>
                        {t(`run.clientStatus.${client.status}`)}
                      </StatusPill>
                    </div>
                    <code><OverflowText>{client.toolName}</OverflowText></code>
                  </div>

                  <div className="ecosystem-compatibility__runtime-mode-grid">
                    <div className="ecosystem-compatibility__runtime-mode">
                      <span className="ecosystem-compatibility__runtime-mode-icon" aria-hidden="true">
                        <Icon name="side-chat" size="md" />
                      </span>
                      <div className="ecosystem-compatibility__runtime-mode-copy">
                        <strong>{t('run.session.title')}</strong>
                        <p>{t('run.session.description', { name: displayName })}</p>
                      </div>
                      <Button
                        className="ecosystem-compatibility__runtime-mode-action"
                        size="sm"
                        variant="outline"
                        onClick={() => handleStartAcpClient(client)}
                      >
                        {t('run.startSession')}
                      </Button>
                    </div>

                    <div className="ecosystem-compatibility__runtime-mode">
                      <span className="ecosystem-compatibility__runtime-mode-icon" aria-hidden="true">
                        <Icon name="user" size="md" />
                      </span>
                      <div className="ecosystem-compatibility__runtime-mode-copy">
                        <div className="ecosystem-compatibility__runtime-mode-title">
                          <strong>{t('run.subagent.title')}</strong>
                          <StatusPill tone={profileState === 'configured' ? 'success' : profileState === 'unsupportedHost' ? 'warning' : 'neutral'}>
                            {t(`run.subagent.states.${profileState}`)}
                          </StatusPill>
                        </div>
                        <p>{profile?.description || t('run.subagent.responsibilityFallback')}</p>
                        <small>{profile?.bestFor
                          ? t('run.subagent.bestForSummary', { value: profile.bestFor })
                          : t('run.subagent.bestForFallback')}</small>
                      </div>
                      <Button
                        className="ecosystem-compatibility__runtime-mode-action"
                        size="sm"
                        variant="outline"
                        disabled={!profileSupported}
                        title={!profileSupported
                          ? t('run.subagent.states.unsupportedHost')
                          : undefined}
                        onClick={() => handleConfigureSubagent(client)}
                      >
                        {t(hasProfile
                          ? 'run.subagent.editAction'
                          : 'run.subagent.configureAction')}
                      </Button>
                    </div>
                  </div>

                  {editingProfile ? (
                    <div className="ecosystem-compatibility__subagent-editor">
                      <div className="ecosystem-compatibility__subagent-editor-heading">
                        <div>
                          <strong>{t('run.subagent.editorTitle', { name: displayName })}</strong>
                          <p>{t('run.subagent.editorDescription')}</p>
                        </div>
                        <label className="ecosystem-compatibility__subagent-toggle">
                          <span>{t('run.subagent.enabledLabel')}</span>
                          <Switch
                            checked={subagentDraft.enabled}
                            disabled={savingProfile}
                            aria-label={t('run.subagent.enabledLabel')}
                            onChange={(event) => setSubagentDraft((current) => ({
                              ...current,
                              enabled: event.target.checked,
                            }))}
                          />
                        </label>
                      </div>

                      <div className="ecosystem-compatibility__subagent-fields">
                        <Textarea
                          label={t('run.subagent.responsibilityLabel')}
                          rows={3}
                          maxLength={ACP_SUBAGENT_PROFILE_MAX_LENGTH}
                          value={subagentDraft.description}
                          disabled={savingProfile}
                          placeholder={t('run.subagent.responsibilityPlaceholder')}
                          onChange={(event) => setSubagentDraft((current) => ({
                            ...current,
                            description: event.target.value,
                          }))}
                        />
                        <Textarea
                          label={t('run.subagent.bestForLabel')}
                          rows={3}
                          maxLength={ACP_SUBAGENT_PROFILE_MAX_LENGTH}
                          value={subagentDraft.bestFor}
                          disabled={savingProfile}
                          placeholder={t('run.subagent.bestForPlaceholder')}
                          onChange={(event) => setSubagentDraft((current) => ({
                            ...current,
                            bestFor: event.target.value,
                          }))}
                        />
                      </div>

                      <div className="ecosystem-compatibility__subagent-editor-footer">
                        <span>
                          <Icon name="info" size="sm" aria-hidden="true" />
                          {t('run.subagent.profileNote')}
                        </span>
                        <div>
                          <Button
                            size="sm"
                            variant="fill"
                            disabled={savingProfile}
                            onClick={() => setEditingSubagentClientId(null)}
                          >
                            {t('run.subagent.cancelAction')}
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            loading={savingProfile}
                            onClick={() => void handleSaveSubagent(client)}
                          >
                            {t(savingProfile
                              ? 'run.subagent.savingAction'
                              : 'run.subagent.saveAction')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );

  return (
    <div
      className="ecosystem-compatibility"
      data-testid="ecosystem-compatibility-scene"
      data-openbitfun-scene="ecosystem-compatibility"
      data-openbitfun-part="root"
    >
      <NavigationPanel
        className="ecosystem-compatibility__sidebar"
        aria-label={t('sidebar.label')}
        data-openbitfun-scene="ecosystem-compatibility"
        data-openbitfun-part="sidebar"
      >
        <NavigationPanelHeader className="ecosystem-compatibility__sidebar-header">
          <header
            className="ecosystem-compatibility__navigation-header"
            data-openbitfun-scene="ecosystem-compatibility"
            data-openbitfun-part="header"
          >
            <strong>{t('title')}</strong>
            <div className="ecosystem-compatibility__navigation-scope">
              <OverflowText>{workspacePath ? `${workspace?.name || t('discovery.workspaceLabel')} · ${currentHost}` : currentHost}</OverflowText>
            </div>
          </header>
          <div className="ecosystem-compatibility__search">
            <SearchField
              leadingIcon={<Icon name="search" aria-hidden />}
              size="sm"
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder={t('search.placeholder')}
              aria-label={t('search.label')}
            />
          </div>
          <div className="ecosystem-compatibility__compact-picker">
            <Select
              size="sm"
              value={selectedRuntime.spec.id}
              options={productRuntimes.map((runtime) => ({
                value: runtime.spec.id,
                label: runtime.spec.name,
                group: t(`groups.${runtime.group}`),
              }))}
              aria-label={t('sidebar.label')}
              onValueChange={(productId) => {
                const runtime = productRuntimes.find((candidate) => candidate.spec.id === productId);
                if (runtime) handleSelectProduct(runtime);
              }}
            />
          </div>
        </NavigationPanelHeader>

        <NavigationPanelBody>
          <div
            className="ecosystem-compatibility__product-groups"
            data-openbitfun-scene="ecosystem-compatibility"
            data-openbitfun-part="productList"
          >
            <NavigationPanelContent>
              {GROUP_ORDER.map((group) => {
                const runtimes = filteredRuntimes.filter((runtime) => runtime.group === group);
                if (runtimes.length === 0 && group !== 'identified') return null;
                return (
                  <NavigationPanelSection
                    key={group}
                    data-product-group={group}
                    title={group === 'identified' ? undefined : t(`groups.${group}`)}
                    aria-label={group === 'identified' ? t('groups.identified') : undefined}
                  >
                    {group === 'identified' ? (
                      <div className="ecosystem-compatibility__identified-heading">
                        <OverflowText className="ecosystem-compatibility__identified-label">
                          {t('groups.identified')}
                        </OverflowText>
                        <ExternalDiscoveryToggle
                          key={requestScope}
                          snapshot={snapshot}
                          onSnapshotChange={setSnapshot}
                          controlRef={discoveryControlRef}
                        />
                      </div>
                    ) : null}
                    {runtimes.map((runtime) => (
                      <NavigationPanelItem
                        key={runtime.spec.id}
                        className={group === 'more' ? 'ecosystem-compatibility__available-product' : undefined}
                        selected={runtime.spec.id === selectedRuntime.spec.id}
                        onClick={() => handleSelectProduct(runtime)}
                        data-product-id={runtime.spec.id}
                        title={`${runtime.spec.name} · ${renderProductSummary(runtime)}`}
                        leading={<EcosystemProductIcon productId={runtime.spec.id} size={22} />}
                      >
                        {runtime.spec.name}
                      </NavigationPanelItem>
                    ))}
                  </NavigationPanelSection>
                );
              })}
              {filteredRuntimes.length === 0 ? (
                <div className="ecosystem-compatibility__sidebar-empty">
                  {t('search.empty')}
                </div>
              ) : null}
            </NavigationPanelContent>
          </div>
        </NavigationPanelBody>
      </NavigationPanel>

      <main
        className="ecosystem-compatibility__main"
        data-openbitfun-scene="ecosystem-compatibility"
        data-openbitfun-part="main"
      >
        <ScrollArea
          ref={contentRef}
          className="ecosystem-compatibility__content"
          data-openbitfun-scene="ecosystem-compatibility"
          data-openbitfun-part="content"
        >
          <header
            className="ecosystem-compatibility__product-header"
          >
            <div className="ecosystem-compatibility__header-top">
              <div className="ecosystem-compatibility__product-identity">
                <span className="ecosystem-compatibility__product-logo" aria-hidden="true">
                  <EcosystemProductIcon productId={selectedRuntime.spec.id} size={38} />
                </span>
                <div>
                  <div className="ecosystem-compatibility__product-title-row">
                    <h1><OverflowText>{selectedRuntime.spec.name}</OverflowText></h1>
                  </div>
                  {adapterLabel ? <span className="ecosystem-compatibility__adapter-label">{adapterLabel}</span> : null}
                </div>
              </div>
              <div className="ecosystem-compatibility__header-actions">
                <IconButton
                  size="sm"
                  variant="quiet"
                  icon={<Icon name="refresh" size="sm" />}
                  aria-label={t('content.refresh')}
                  title={t('content.refresh')}
                  disabled={loading || contentRefreshDisabled}
                  onClick={() => void externalContentRef.current?.refresh()}
                />
              </div>
            </div>
            <dl className="ecosystem-compatibility__product-meta">
              <div>
                <dt>{t('header.sourceLocation')}</dt>
                <dd title={selectedRuntime.sourceLocation}>
                  {selectedRuntime.sourceLocation ?? sourceLocationFallback}
                </dd>
              </div>
              <div>
                <dt>{t('header.executionHost')}</dt>
                <dd>{currentHost}</dd>
              </div>
            </dl>
          </header>

          <div className="ecosystem-compatibility__body">
            {loading ? (
              <LoadingState className="ecosystem-compatibility__loading" role="status" size="sm">
                {t('loading')}
              </LoadingState>
            ) : null}
            {loadIssues.length > 0 ? (
              <div className="ecosystem-compatibility__load-notice" role="status">
                <Icon name="info" size="sm" aria-hidden="true" />
                <span>{t('partialLoad', {
                  sources: loadIssues.includes('externalSources') ? t('loadAreas.externalSources') : '',
                  acp: loadIssues.includes('acpClients') ? t('loadAreas.acpClients') : '',
                })}</span>
                <Button className="ecosystem-compatibility__load-retry" variant="outline" size="sm" onClick={() => void loadCompatibility(true)}>
                  {t('retry')}
                </Button>
              </div>
            ) : null}
            <div className="ecosystem-compatibility__unified-stack">
              {selectedRuntime.spec.development ? (
                <div className="ecosystem-compatibility__development-card" role="status">
                  <Icon name="user" size="lg" />
                  <div>
                    <strong>{t('comingSoon.title')}</strong>
                    <p>{t('comingSoon.notice', { name: selectedRuntime.spec.name })}</p>
                  </div>
                </div>
              ) : null}
              {selectedRuntime.spec.acpClientId || selectedRuntime.acpClients.length > 0 ? renderRun() : null}
              <ExternalAgentContent
                key={JSON.stringify([requestScope, selectedRuntime.spec.id])}
                scopeKey={requestScope}
                refreshControlRef={externalContentRef}
                onRefreshDisabledChange={setContentRefreshDisabled}
                runtime={selectedRuntime}
                snapshot={snapshot}
                catalogFailed={loadIssues.includes('externalSources')}
                onSupplementalCounts={onSupplementalCounts}
                onRefresh={() => loadCompatibility(true)}
              />
            </div>
          </div>
        </ScrollArea>
      </main>
      <Dialog
        id="ecosystem-acp-manager"
        className="ecosystem-compatibility__acp-dialog"
        open={ownerSurface === 'acp'}
        onOpenChange={() => {
          if (acpManagerRef.current) acpManagerRef.current.requestClose();
          else setOwnerSurface(null);
        }}
        size="xl"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{selectedRuntime.spec.name} · {t('run.managerLabel')}</DialogTitle>
            <DialogDescription>{t('run.managerScope')}</DialogDescription>
          </DialogHeading>
          <DialogHeaderActions><DialogClose /></DialogHeaderActions>
        </DialogHeader>
        <DialogBody>
          <Suspense fallback={<OwnerSurfaceLoading label={t('run.loadingManager')} />}>
            <AcpAgentsConfig
              key={JSON.stringify([requestScope, selectedRuntime.spec.id])}
              ref={acpManagerRef}
              clientIds={[...selectedRuntime.acpClients.map((client) => client.id), ...(selectedRuntime.spec.acpClientId ? [selectedRuntime.spec.acpClientId] : [])]}
              presentation="dialog"
              onClose={() => setOwnerSurface(null)}
            />
          </Suspense>
        </DialogBody>
      </Dialog>
    </div>
  );
};

export default EcosystemCompatibilityScene;
