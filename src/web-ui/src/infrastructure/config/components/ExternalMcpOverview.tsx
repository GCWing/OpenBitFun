import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Button, Checkbox, IconButton, ScrollArea, Tooltip } from '@openbitfun/ui';

import { useTranslation } from 'react-i18next';

import { openEcosystemCompatibility } from '@/app/scenes/ecosystem-compatibility/ecosystemCompatibilityStore';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import {
  type ExternalMcpActivation,
  type ExternalMcpCatalogEntry,
  type ExternalMcpImportPlanV1,
  ExternalSourceApiError,
  type ExternalSourceCatalogSnapshot,
  type ExternalSourceScope,
  externalSourcesAPI,
} from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import { createLogger } from '@/shared/utils/logger';
import { WorkspaceKind } from '@/shared/types/global-state';
import { ConfigCollectionItem, ConfigPageSection } from './common';
import { externalSourceRequestScopeKey } from './externalSourceRequestScope';

const log = createLogger('ExternalMcpOverview');
const DISCOVERY_POLL_DELAYS_MS = [750, 1_500, 3_000, 5_000] as const;

function sourceKey(providerId: string, sourceId: string): string {
  return `${providerId}\u0000${sourceId}`;
}

function statusTone(activation: ExternalMcpActivation): string {
  switch (activation.state) {
    case 'active':
      return 'is-healthy';
    case 'approval_required':
    case 'starting':
    case 'configuration_changed':
      return 'is-pending';
    case 'conflict':
    case 'unsupported':
    case 'runtime_unavailable':
      return 'is-error';
    default:
      return 'is-muted';
  }
}

function scopeRank(scope: ExternalSourceScope | undefined): number {
  switch (scope) {
    case 'project':
    case 'workspace_local':
    case 'remote_project':
      return 0;
    case 'user_global':
    case 'remote_user':
      return 1;
    default:
      return 2;
  }
}

type ExternalMcpSourceState = 'stale' | 'degraded' | null;

function sourceState(
  source: ExternalSourceCatalogSnapshot['sources'][number] | undefined,
): ExternalMcpSourceState {
  if (!source) return null;
  if (source.lifecycle === 'using_last_valid_version') return 'stale';
  if (
    ['restricted', 'degraded', 'unavailable'].includes(source.lifecycle)
    || ['partial', 'degraded', 'unavailable'].includes(source.record.health)
    || (source.record.diagnostics ?? []).some((diagnostic) => diagnostic.severity !== 'info')
  ) {
    return 'degraded';
  }
  return null;
}

function safeLoadErrorFacts(error: unknown): Record<string, unknown> {
  if (error instanceof ExternalSourceApiError) {
    const correlationId = error.correlationId?.trim();
    return {
      error_type: 'external_source_api',
      code: error.code,
      correlation_id: correlationId && /^[a-z0-9_-]{1,64}$/i.test(correlationId)
        ? correlationId
        : undefined,
      retryable: error.retryable,
    };
  }
  return {
    error_type: error instanceof Error ? 'error' : 'unknown',
    code: 'internal',
    correlation_id: undefined,
    retryable: false,
  };
}

const ExternalMcpDetail: React.FC<{
  label: string;
  value: string;
  code?: boolean;
}> = ({ label, value, code = false }) => (
  <div className="openbitfun-mcp-tools__server-detail-item" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="detailItem">
    <span className="openbitfun-mcp-tools__server-detail-label" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="detailLabel">{label}:</span>
    {code ? (
      <code className="openbitfun-mcp-tools__server-detail-value" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="detailValue">{value}</code>
    ) : (
      <span className="openbitfun-mcp-tools__server-detail-value" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="detailValue">{value}</span>
    )}
  </div>
);

const ExternalMcpOverview: React.FC = () => {
  const { t } = useTranslation('settings/mcp');
  const { t: tShared } = useTranslation('shared');
  const { workspace, workspacePath } = useCurrentWorkspace();
  const peerDevice = usePeerDeviceModeOptional();
  const requestIdRef = useRef(0);
  const importRequestIdRef = useRef(0);
  const peerDeviceId = peerDevice?.peerMode.active ? peerDevice.peerMode.deviceId : undefined;
  const importSupported = !peerDeviceId && workspace?.workspaceKind !== WorkspaceKind.Remote;
  const requestScope = externalSourceRequestScopeKey({
    peerDeviceId,
    workspaceId: workspace?.id,
    workspaceKind: workspace?.workspaceKind,
    remoteConnectionId: workspace?.connectionId,
    remoteHost: workspace?.sshHost,
    workspacePath,
  });
  const [snapshotState, setSnapshotState] = useState<{
    scope: string;
    snapshot: ExternalSourceCatalogSnapshot | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [importPlan, setImportPlan] = useState<ExternalMcpImportPlanV1 | null>(null);
  const [selectedImportCandidateIds, setSelectedImportCandidateIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [importBusy, setImportBusy] = useState(false);
  const [importNotice, setImportNotice] = useState<'applied' | 'stale' | 'empty' | 'failed' | null>(null);
  const snapshot = snapshotState?.scope === requestScope ? snapshotState.snapshot : null;
  const scopedLoading = loading || snapshotState?.scope !== requestScope;

  const loadSnapshot = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const nextSnapshot = await externalSourcesAPI.getSnapshot(workspace?.id);
      if (requestId === requestIdRef.current) {
        setSnapshotState({ scope: requestScope, snapshot: nextSnapshot });
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setSnapshotState((current) => (
          current?.scope === requestScope && current.snapshot
            ? current
            : { scope: requestScope, snapshot: null }
        ));
        setLoadFailed(true);
        log.warn('Failed to load external MCP summary', safeLoadErrorFacts(error));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [requestScope, workspace?.id]);

  useEffect(() => {
    void loadSnapshot();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadSnapshot]);

  useEffect(() => {
    importRequestIdRef.current += 1;
    setImportPlan(null);
    setSelectedImportCandidateIds(new Set());
    setImportNotice(null);
    setImportBusy(false);
  }, [requestScope]);

  useEffect(() => {
    if (!snapshot?.discoveryPending) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const schedulePoll = () => {
      const delay = DISCOVERY_POLL_DELAYS_MS[
        Math.min(attempt, DISCOVERY_POLL_DELAYS_MS.length - 1)
      ];
      timer = window.setTimeout(async () => {
        await loadSnapshot();
        if (cancelled) return;
        attempt += 1;
        schedulePoll();
      }, delay);
    };
    schedulePoll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadSnapshot, snapshot?.discoveryPending]);

  const sourceByKey = useMemo(() => new Map(
    (snapshot?.sources ?? []).map((source) => [
      sourceKey(source.record.key.providerId, source.record.key.sourceId),
      source,
    ]),
  ), [snapshot?.sources]);

  const ecosystemLabels = useMemo(() => new Map(
    (snapshot?.integrationPolicy.registeredEcosystems ?? []).map((ecosystem) => [
      ecosystem.ecosystemId,
      ecosystem.displayName,
    ]),
  ), [snapshot?.integrationPolicy.registeredEcosystems]);

  const entries = useMemo(() => [...(snapshot?.mcpServers ?? [])].sort((left, right) => {
    const leftSource = sourceByKey.get(sourceKey(
      left.definition.id.source.providerId,
      left.definition.id.source.sourceId,
    ));
    const rightSource = sourceByKey.get(sourceKey(
      right.definition.id.source.providerId,
      right.definition.id.source.sourceId,
    ));
    return scopeRank(leftSource?.record.scope) - scopeRank(rightSource?.record.scope)
      || left.definition.name.localeCompare(right.definition.name);
  }), [snapshot?.mcpServers, sourceByKey]);
  const mcpEntryByCandidateId = useMemo(() => new Map(
    (snapshot?.mcpServers ?? []).map((entry) => [entry.candidateId, entry]),
  ), [snapshot?.mcpServers]);

  const hostReadOnly = snapshot !== null
    && !snapshot.hostCapabilities.canMutatePolicy
    && !snapshot.hostCapabilities.canManageSources
    && !snapshot.hostCapabilities.canApproveRuntime;
  const hasMcpDiagnostics = (snapshot?.diagnostics ?? []).some((diagnostic) => (
    diagnostic.severity !== 'info'
    && (!diagnostic.assetKind || diagnostic.assetKind === 'source' || diagnostic.assetKind === 'mcp')
  ));
  const eligibleImportItems = (importPlan?.items ?? []).filter((item) => (
    item.disposition === 'eligible' || item.disposition === 'automatic_rename'
  ));
  const selectedImportItems = eligibleImportItems.filter((item) => (
    selectedImportCandidateIds.has(item.candidateId)
  ));

  const previewImport = async () => {
    if (!importSupported) return;
    const requestId = ++importRequestIdRef.current;
    setImportBusy(true);
    setImportNotice(null);
    try {
      const plan = await externalSourcesAPI.planMcpImport(workspace?.id);
      if (requestId !== importRequestIdRef.current) return;
      const hasEligible = plan.items.some((item) => (
        item.disposition === 'eligible' || item.disposition === 'automatic_rename'
      ));
      setImportPlan(hasEligible ? plan : null);
      setSelectedImportCandidateIds(new Set(
        plan.items
          .filter((item) => (
            item.disposition === 'eligible' || item.disposition === 'automatic_rename'
          ))
          .map((item) => item.candidateId),
      ));
      if (!hasEligible) setImportNotice('empty');
    } catch (error) {
      if (requestId !== importRequestIdRef.current) return;
      setImportNotice('failed');
      log.warn('Failed to preview external MCP import', safeLoadErrorFacts(error));
    } finally {
      if (requestId === importRequestIdRef.current) setImportBusy(false);
    }
  };

  const applyImport = async () => {
    if (!importSupported || !importPlan || selectedImportItems.length === 0) return;
    const requestId = ++importRequestIdRef.current;
    setImportBusy(true);
    setImportNotice(null);
    try {
      const result = await externalSourcesAPI.applyMcpImport(
        workspace?.id,
        importPlan,
        selectedImportItems.map((item) => ({ candidateId: item.candidateId })),
      );
      if (requestId !== importRequestIdRef.current) return;
      if (result.outcome.status === 'stale') {
        const refreshedPlan = result.outcome.refreshedPlan;
        const refreshedEligibleIds = new Set(
          refreshedPlan.items
            .filter((item) => (
              item.disposition === 'eligible' || item.disposition === 'automatic_rename'
            ))
            .map((item) => item.candidateId),
        );
        setSelectedImportCandidateIds((current) => new Set(
          [...current].filter((candidateId) => refreshedEligibleIds.has(candidateId)),
        ));
        setImportPlan(refreshedPlan);
        setImportNotice('stale');
      } else {
        setImportPlan(null);
        setSelectedImportCandidateIds(new Set());
        setImportNotice('applied');
      }
    } catch (error) {
      if (requestId !== importRequestIdRef.current) return;
      setImportNotice('failed');
      log.warn('Failed to apply external MCP import', safeLoadErrorFacts(error));
    } finally {
      if (requestId === importRequestIdRef.current) setImportBusy(false);
    }
  };

  const cancelImport = () => {
    setImportPlan(null);
    setSelectedImportCandidateIds(new Set());
    setImportNotice(null);
  };

  const toggleImportCandidate = (candidateId: string) => {
    if (importBusy) return;
    setSelectedImportCandidateIds((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  };

  const scopeLabel = (scope: ExternalSourceScope | undefined): string => {
    switch (scope) {
      case 'user_global': return t('external.scope.userGlobal');
      case 'project': return t('external.scope.project');
      case 'workspace_local': return tShared('features.workspace');
      case 'remote_user': return t('external.scope.remoteUser');
      case 'remote_project': return t('external.scope.remoteProject');
      default: return t('external.unknown');
    }
  };

  const activationLabel = (activation: ExternalMcpActivation): string => {
    switch (activation.state) {
      case 'approval_required': return t('external.status.approvalRequired');
      case 'starting': return t('external.status.starting');
      case 'active': return t('external.status.active');
      case 'declined': return t('external.status.declined');
      case 'conflict': return t('external.status.conflict');
      case 'covered': return t('external.status.covered');
      case 'source_disabled': return t('external.status.sourceDisabled');
      case 'configuration_changed': return t('external.status.configurationChanged');
      case 'unsupported': return t('external.status.unsupported');
      case 'runtime_unavailable': return t('external.status.runtimeUnavailable');
      case 'removed': return t('external.status.removed');
      default: return t('external.unknown');
    }
  };

  const renderEntry = (entry: ExternalMcpCatalogEntry) => {
    const source = sourceByKey.get(sourceKey(
      entry.definition.id.source.providerId,
      entry.definition.id.source.sourceId,
    ));
    const sourceRecord = source?.record;
    const ecosystemLabel = sourceRecord
      ? ecosystemLabels.get(sourceRecord.ecosystemId) ?? sourceRecord.ecosystemId
      : entry.definition.id.source.providerId;
    const sourceStatus = sourceState(source);
    const badges = (
      <>
        <span className="openbitfun-collection-item__badge openbitfun-mcp-tools__external-source-badge">
          {ecosystemLabel}
        </span>
        <span className="openbitfun-collection-item__badge">
          {scopeLabel(sourceRecord?.scope)}
        </span>
        {sourceStatus ? (
          <span className={`openbitfun-mcp-tools__status-badge ${sourceStatus === 'degraded' ? 'is-error' : ''}`} data-openbitfun-component="external-mcp-overview" data-openbitfun-part="statusBadge" data-openbitfun-state={sourceStatus === 'degraded' ? 'error' : 'stale'}>
            {t(`external.status.${sourceStatus}`)}
          </span>
        ) : null}
      </>
    );
    const details = (
      <div className="openbitfun-mcp-tools__server-details" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="serverDetails">
        <ExternalMcpDetail label={t('external.details.source')} value={sourceRecord?.displayName ?? ecosystemLabel} />
        <ExternalMcpDetail label={t('external.details.scope')} value={scopeLabel(sourceRecord?.scope)} />
        <ExternalMcpDetail
          label={t('external.details.location')}
          value={sourceRecord?.location ?? t('external.unknown')}
          code
        />
        <ExternalMcpDetail
          label={t('external.details.transport')}
          value={entry.definition.transport === 'local_stdio'
            ? t('external.transport.localStdio')
            : t('external.transport.streamableHttp')}
        />
      </div>
    );
    return (
      <ConfigCollectionItem
        key={entry.candidateId}
        data-testid="external-mcp-item"
        label={entry.definition.name}
        badge={badges}
        badgePlacement="below"
        control={(
          <span className={`openbitfun-mcp-tools__status-badge ${statusTone(entry.activationState)}`}>
            {activationLabel(entry.activationState)}
          </span>
        )}
        details={details}
      />
    );
  };

  return (
    <ConfigPageSection
      className="openbitfun-mcp-tools__external-section"
      data-openbitfun-component="external-mcp-overview"
      data-openbitfun-part="root"
      title={t('external.title')}
      titleSuffix={snapshot ? (
        <span className="openbitfun-mcp-tools__external-summary" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="summary">
          {snapshot.discoveryPending ? (
            <span className="openbitfun-mcp-tools__status-badge is-pending" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="statusBadge" data-openbitfun-state="pending">
              {t('external.status.checking')}
            </span>
          ) : null}
          {hostReadOnly ? (
            <span className="openbitfun-mcp-tools__status-badge is-muted" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="statusBadge" data-openbitfun-state="muted">
              {t('external.status.readOnly')}
            </span>
          ) : null}
          {loadFailed && snapshot ? (
            <span className="openbitfun-mcp-tools__status-badge is-pending" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="statusBadge" data-openbitfun-state="pending">
              {t('external.status.stale')}
            </span>
          ) : null}
          {hasMcpDiagnostics ? (
            <span className="openbitfun-mcp-tools__status-badge is-error" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="statusBadge" data-openbitfun-state="error">
              {t('external.status.degraded')}
            </span>
          ) : null}
        </span>
      ) : undefined}
      extra={(
        <>
          {loadFailed ? (
            <Tooltip content={t('external.retry')}>
              <IconButton
                size="sm"
                onClick={() => void loadSnapshot()}
                aria-label={t('external.retry')}
                icon={<Icon name="refresh" size="lg" />}
              />
            </Tooltip>
          ) : null}
          <Tooltip content={t('external.manage')}>
            <IconButton
              size="sm"
              onClick={() => openEcosystemCompatibility({ ownerSurface: 'external-sources' })}
              aria-label={t('external.manage')}
              icon={<Icon name="extension" size="lg" />}
            />
          </Tooltip>
        </>
      )}
    >
      {entries.length > 0 && !hostReadOnly && importSupported ? (
        <div className="openbitfun-mcp-tools__import" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="import" data-testid="external-mcp-import">
          {importPlan ? (
            <div className="openbitfun-mcp-tools__import-plan" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="importPlan">
              <p>{t('external.import.confirm', { count: selectedImportItems.length })}</p>
              <ScrollArea className="openbitfun-mcp-tools__import-list" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="importList">
              <ul>
                {eligibleImportItems.map((item) => {
                  const catalogEntry = mcpEntryByCandidateId.get(item.candidateId);
                  const source = catalogEntry ? sourceByKey.get(sourceKey(
                    catalogEntry.definition.id.source.providerId,
                    catalogEntry.definition.id.source.sourceId,
                  )) : undefined;
                  const ecosystemLabel = source
                    ? ecosystemLabels.get(source.record.ecosystemId) ?? source.record.ecosystemId
                    : catalogEntry?.definition.id.source.providerId ?? t('external.unknown');
                  const candidateScopeLabel = scopeLabel(source?.record.scope);
                  return (
                    <li key={item.candidateId}>
                      <div className="openbitfun-mcp-tools__import-option" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="importOption">
                        <Checkbox
                          className="openbitfun-mcp-tools__import-control"
                          checked={selectedImportCandidateIds.has(item.candidateId)}
                          disabled={importBusy}
                          onCheckedChange={() => toggleImportCandidate(item.candidateId)}
                          aria-label={`${item.displayName}, ${ecosystemLabel}, ${candidateScopeLabel}`}
                          label={(
                            <span className="openbitfun-mcp-tools__import-option-content" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="importOptionContent">
                              <span>
                                {item.displayName} → {item.proposedNativeId}
                              </span>
                              <span className="openbitfun-mcp-tools__import-option-meta" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="importOptionMeta">
                                <span className="openbitfun-collection-item__badge openbitfun-mcp-tools__external-source-badge">
                                  {ecosystemLabel}
                                </span>
                                <span className="openbitfun-collection-item__badge">
                                  {candidateScopeLabel}
                                </span>
                              </span>
                            </span>
                          )}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              </ScrollArea>
              <div className="openbitfun-mcp-tools__import-actions" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="importActions">
                <Button variant="primary" size="sm" disabled={importBusy || selectedImportItems.length === 0} onClick={() => void applyImport()}>
                  {t('external.import.apply')}
                </Button>
                <Button variant="fill" size="sm" disabled={importBusy} onClick={cancelImport}>
                  {t('external.import.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="primary" size="sm" disabled={importBusy} onClick={() => void previewImport()}>
              {t('external.import.preview')}
            </Button>
          )}
          {importNotice ? <p role="status">{t(`external.import.${importNotice}`)}</p> : null}
        </div>
      ) : null}
      {scopedLoading && !snapshot ? (
        <div className="openbitfun-collection-empty" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="empty"><p>{t('external.loading')}</p></div>
      ) : loadFailed && !snapshot ? (
        <div className="openbitfun-collection-empty" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="empty" role="status"><p>{t('external.unavailable')}</p></div>
      ) : snapshot?.discoveryPending && entries.length === 0 ? (
        <div className="openbitfun-collection-empty" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="empty" role="status"><p>{t('external.loading')}</p></div>
      ) : entries.length === 0 ? (
        <div className="openbitfun-collection-empty" data-openbitfun-component="external-mcp-overview" data-openbitfun-part="empty"><p>{t('external.empty')}</p></div>
      ) : entries.map(renderEntry)}
    </ConfigPageSection>
  );
};

export default ExternalMcpOverview;
