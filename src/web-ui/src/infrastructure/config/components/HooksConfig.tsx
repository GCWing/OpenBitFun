import {
  Button,
  ConfirmDialog,
  Icon,
  Switch,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { WorkspaceKind } from '@/shared/types';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  externalHooksAPI,
  type ExternalHookImportMutation,
  type ExternalHookImportPlan,
  type ExternalHookImportSnapshot,
  type ExternalHookSource,
} from '@/infrastructure/api/service-api/ExternalHooksAPI';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { configManager } from '../services/ConfigManager';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection,
  ConfigLoadingState,
  ConfigRetryState,
} from './common';

const log = createLogger('HooksConfig');

const CODEX_HOOKS_DOC_URL = 'https://learn.chatgpt.com/docs/hooks';

/** Enablement gates only. Hook declarations live in hooks.json. */
interface AgentHooksConfigShape {
  enabled: boolean;
  project_hooks_enabled: boolean;
}

const DEFAULT_HOOKS_CONFIG: AgentHooksConfigShape = {
  enabled: true,
  project_hooks_enabled: false,
};

function normalizeHooksConfig(
  config: Partial<AgentHooksConfigShape> | null | undefined
): AgentHooksConfigShape {
  return {
    ...DEFAULT_HOOKS_CONFIG,
    ...(config ?? {}),
  };
}

export interface HooksConfigProps {
  embedded?: boolean;
}

const HooksConfig: React.FC<HooksConfigProps> = ({ embedded = false }) => {
  const { t } = useTranslation('settings/hooks');
  const { error: notifyError, success: notifySuccess } = useNotification();
  const { workspace, workspacePath } = useCurrentWorkspace();
  const remoteWorkspace = workspace?.workspaceKind === WorkspaceKind.Remote
    || Boolean(workspace?.connectionId);

  const [loading, setLoading] = useState(true);
  const [configLoadFailed, setConfigLoadFailed] = useState(false);
  const [config, setConfig] = useState<AgentHooksConfigShape>(DEFAULT_HOOKS_CONFIG);
  const [savingKey, setSavingKey] = useState<keyof AgentHooksConfigShape | null>(null);
  const [importSnapshot, setImportSnapshot] = useState<ExternalHookImportSnapshot | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reviewPlan, setReviewPlan] = useState<ExternalHookImportPlan | null>(null);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<
    | { kind: 'remove'; importId: string }
    | { kind: 'reset'; scope: ExternalHookSource['scope'] }
    | null
  >(null);
  const [projectHooksEnableConfirmOpen, setProjectHooksEnableConfirmOpen] = useState(false);
  const requestSequence = useRef(0);
  const mountedRef = useRef(true);

  const loadData = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setConfigLoadFailed(false);
    setImportError(null);
    const [configResult, importResult] = await Promise.allSettled([
      configManager.getConfig<Partial<AgentHooksConfigShape>>('app.hooks'),
      remoteWorkspace
        ? Promise.resolve(null)
        : externalHooksAPI.getImportSnapshot(workspace?.id, false),
    ]);
    if (!mountedRef.current || sequence !== requestSequence.current) return;
    if (configResult.status === 'fulfilled') {
      setConfig(normalizeHooksConfig(configResult.value));
    } else {
      log.error('Failed to load hooks config', configResult.reason);
      setConfigLoadFailed(true);
    }
    if (importResult.status === 'fulfilled') {
      setImportSnapshot(importResult.value);
    } else {
      log.error('Failed to load imported Hooks', importResult.reason);
      setImportSnapshot(null);
      setImportError(t('imports.loadFailed'));
    }
    setLoading(false);
  }, [remoteWorkspace, t, workspace?.id]);

  useEffect(() => {
    mountedRef.current = true;
    void loadData();
    return () => {
      mountedRef.current = false;
      requestSequence.current += 1;
    };
  }, [loadData]);

  const refreshImports = useCallback(async () => {
    if (remoteWorkspace) return;
    const sequence = ++requestSequence.current;
    setImportLoading(true);
    setImportError(null);
    try {
      const snapshot = await externalHooksAPI.getImportSnapshot(
        workspace?.id,
        true,
      );
      if (mountedRef.current && sequence === requestSequence.current) {
        setImportSnapshot(snapshot);
      }
    } catch (error) {
      if (!mountedRef.current || sequence !== requestSequence.current) return;
      log.error('Failed to refresh imported Hooks', error);
      setImportError(t('imports.refreshFailed'));
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) {
        setImportLoading(false);
      }
    }
  }, [remoteWorkspace, t, workspace?.id]);

  const updateConfig = useCallback(
    async <K extends keyof AgentHooksConfigShape>(key: K, value: AgentHooksConfigShape[K]) => {
      const previous = config;
      const next = { ...config, [key]: value };
      setSavingKey(key);
      setConfig(next);
      try {
        await configManager.setConfig('app.hooks', next);
        if (!mountedRef.current) return;
        notifySuccess(t('messages.saved'));
      } catch (error) {
        if (!mountedRef.current) return;
        log.error('Failed to save hooks config', { key, error });
        setConfig(previous);
        notifyError(error instanceof Error ? error.message : t('messages.saveFailed'));
      } finally {
        if (mountedRef.current) setSavingKey(null);
      }
    },
    [config, notifyError, notifySuccess, t]
  );

  const openCodexHooksDoc = useCallback(() => {
    void systemAPI.openExternal(CODEX_HOOKS_DOC_URL).catch((error: unknown) => {
      log.error('Failed to open the Codex hooks documentation', error);
    });
  }, []);

  const previewImport = useCallback(async (source: ExternalHookSource) => {
    const key = `${source.key.providerId}:${source.key.sourceId}`;
    setBusyKey(key);
    setPlanNotice(null);
    try {
      const plan = await externalHooksAPI.planImport(workspace?.id, source.key);
      if (!mountedRef.current) return;
      setReviewPlan(plan);
    } catch (error) {
      if (!mountedRef.current) return;
      log.error('Failed to prepare Hook import review', error);
      notifyError(t('imports.planFailed'));
    } finally {
      if (mountedRef.current) setBusyKey(null);
    }
  }, [notifyError, t, workspace?.id]);

  const applyReviewedPlan = useCallback(async () => {
    if (!reviewPlan) return;
    setBusyKey('apply');
    try {
      const result = await externalHooksAPI.applyImport(
        workspace?.id,
        reviewPlan,
      );
      if (!mountedRef.current) return;
      if (result.outcome.kind === 'stale') {
        setReviewPlan(result.outcome.refreshedPlan);
        setPlanNotice(t('imports.stale'));
      } else {
        setImportSnapshot(result.outcome.snapshot);
        setReviewPlan(null);
        setPlanNotice(null);
        const imported = result.outcome.snapshot.imports.find((item) => (
          item.source.key.providerId === reviewPlan.source.key.providerId
          && item.source.key.sourceId === reviewPlan.source.key.sourceId
        ));
        let message = 'imports.applied';
        if (imported?.enabled === false) {
          message = 'imports.appliedDisabled';
        } else if (!config.enabled) {
          message = 'imports.appliedMasterDisabled';
        }
        notifySuccess(t(message));
      }
    } catch (error) {
      if (!mountedRef.current) return;
      log.error('Failed to apply reviewed Hook import', error);
      notifyError(t('imports.applyFailed'));
    } finally {
      if (mountedRef.current) setBusyKey(null);
    }
  }, [config.enabled, notifyError, notifySuccess, reviewPlan, t, workspace?.id]);

  const mutateImport = useCallback(async (
    action: ExternalHookImportMutation,
    optimisticImportId?: string,
    optimisticEnabled?: boolean,
  ) => {
    if (!importSnapshot) return;
    let authoritative = importSnapshot;
    if (optimisticImportId && optimisticEnabled !== undefined) {
      setImportSnapshot({
        ...importSnapshot,
        imports: importSnapshot.imports.map((item) => (
          item.importId === optimisticImportId
            ? { ...item, enabled: optimisticEnabled }
            : item
        )),
      });
    }
    setBusyKey('mutation');
    try {
      let next: ExternalHookImportSnapshot;
      try {
        next = await externalHooksAPI.mutateImport(
          workspace?.id,
          authoritative.revision,
          action,
        );
      } catch (error) {
        if ((error as { code?: string })?.code !== 'stale_revision') throw error;
        const refreshed = await externalHooksAPI.getImportSnapshot(
          workspace?.id,
          false,
        );
        if (!mountedRef.current) return;
        authoritative = refreshed;
        setImportSnapshot(refreshed);
        notifyError(t('imports.stateChanged'));
        return;
      }
      if (!mountedRef.current) return;
      setImportSnapshot(next);
      notifySuccess(t('imports.updated'));
    } catch (error) {
      if (!mountedRef.current) return;
      setImportSnapshot(authoritative);
      log.error('Failed to update imported Hooks', error);
      notifyError(t('imports.updateFailed'));
    } finally {
      if (mountedRef.current) setBusyKey(null);
    }
  }, [importSnapshot, notifyError, notifySuccess, t, workspace?.id]);

  const confirmMutation = useCallback(() => {
    if (!confirmation) return;
    const action: ExternalHookImportMutation = confirmation.kind === 'remove'
      ? { kind: 'remove', importId: confirmation.importId }
      : { kind: 'reset_corrupt_store', scope: confirmation.scope };
    setConfirmation(null);
    void mutateImport(action);
  }, [confirmation, mutateImport]);

  const corruptDiagnostics = importSnapshot?.diagnostics.filter((diagnostic) => (
    diagnostic.code.startsWith('external_hook.import_store_corrupt.')
  )) ?? [];
  const reviewUpdatesExistingImport = reviewPlan !== null && importSnapshot?.imports.some((item) => (
    item.source.key.providerId === reviewPlan.source.key.providerId
    && item.source.key.sourceId === reviewPlan.source.key.sourceId
  ));

  if (loading || configLoadFailed) {
    if (embedded) {
      return loading ? (
        <ConfigLoadingState label={t('loading')} />
      ) : (
        <ConfigRetryState
          message={t('messages.loadFailedLocked')}
          retryLabel={t('messages.retry')}
          onRetry={() => void loadData()}
        />
      );
    }
    return (
      <ConfigPageLayout>
        <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />
        <ConfigPageContent>
          {loading ? (
            <ConfigLoadingState label={t('loading')} />
          ) : (
            <ConfigRetryState
              message={t('messages.loadFailedLocked')}
              retryLabel={t('messages.retry')}
              onRetry={() => void loadData()}
            />
          )}
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  const content = (
    <>
      <ConfigPageContent>
        <ConfigPageSection title={t('activation.title')} description={t('activation.description')}>
          <ConfigPageRow
            label={t('fields.enabled.label')}
            align="center"
          >
            <Switch
              checked={config.enabled}
              onChange={(event) => void updateConfig('enabled', event.target.checked)}
              disabled={savingKey !== null}
            />
          </ConfigPageRow>

          <ConfigPageRow
            label={t('fields.projectHooks.label')}
            description={t('fields.projectHooks.description')}
            align="center"
          >
            <Switch
              checked={config.project_hooks_enabled}
              onChange={(event) => {
                if (event.target.checked) setProjectHooksEnableConfirmOpen(true);
                else void updateConfig('project_hooks_enabled', false);
              }}
              disabled={savingKey !== null || !config.enabled}
            />
          </ConfigPageRow>
        </ConfigPageSection>


        <ConfigPageSection title={t('locations.title')} description={t('locations.description')}>
          <ConfigPageRow
            label={t('locations.userFile.label')}
            description={t('locations.userFile.description')}
            align="center"
          >
            {null}
          </ConfigPageRow>

          <ConfigPageRow
            label={t('locations.projectFile.label')}
            description={t('locations.projectFile.description')}
            align="center"
          >
            {null}
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('imports.title')}
          description={config.enabled ? t('imports.description') : t('imports.masterDisabled')}
          extra={remoteWorkspace ? null : (
            <Button
              variant="outline"
              size="sm"
              loading={importLoading}
              disabled={busyKey !== null}
              onClick={() => void refreshImports()}
              leadingIcon={<Icon name="refresh" size="sm" />}
            >

              {t('imports.refresh')}
            </Button>
          )}
        >
          {remoteWorkspace ? (
            <ConfigPageRow label={t('imports.remoteUnsupported')} align="center">
              {null}
            </ConfigPageRow>
          ) : importError ? (
            <ConfigPageRow label={importError} align="center">
              {null}
            </ConfigPageRow>
          ) : importSnapshot ? (
            <>
              {importSnapshot.imports.map((item) => (
                <ConfigPageRow
                  key={item.importId}
                  label={item.source.displayName}
                  description={t(`imports.state.${item.state}`, {
                    location: item.source.locationHint,
                  })}
                  align="center"
                >
                  <Switch
                    aria-label={t('imports.toggle', { name: item.source.displayName })}
                    checked={item.enabled}
                    disabled={!config.enabled || busyKey !== null}
                    onChange={(event) => void mutateImport(
                      { kind: 'set_enabled', importId: item.importId, enabled: event.target.checked },
                      item.importId,
                      event.target.checked,
                    )}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyKey !== null || item.state === 'source_missing'}
                    onClick={() => void previewImport(item.source)}
                  >
                    {t('imports.update')}
                  </Button>
                  <Button
                    variant="fill"
                    tone="danger"
                    size="sm"
                    disabled={busyKey !== null}
                    onClick={() => setConfirmation({ kind: 'remove', importId: item.importId })}
                  >
                    {t('imports.remove')}
                  </Button>
                </ConfigPageRow>
              ))}

              {corruptDiagnostics.map((diagnostic) => {
                  const scope = diagnostic.code.endsWith('.user_global')
                    ? 'user_global'
                    : 'project';
                  return (
                    <ConfigPageRow
                      key={diagnostic.code}
                      label={t('imports.storeInvalid')}
                      description={diagnostic.message}
                      align="center"
                    >
                      <Button
                        variant="fill"
                        tone="danger"
                        size="sm"
                        disabled={busyKey !== null}
                        onClick={() => setConfirmation({ kind: 'reset', scope })}
                      >
                        {t('imports.reset')}
                      </Button>
                    </ConfigPageRow>
                  );
                })}

              {importSnapshot.imports.length === 0
                && corruptDiagnostics.length === 0 ? (
                  <ConfigPageRow
                    className="openbitfun-hooks-config__empty"
                    label={<span data-hooks-empty="true">{t('imports.empty')}</span>}
                    multiline
                  >
                    {null}
                  </ConfigPageRow>
                ) : null}
            </>
          ) : (
            <ConfigLoadingState label={t('imports.loading')} />
          )}
        </ConfigPageSection>

        <ConfigPageSection
          title={t('compatibility.title')}
          description={t('compatibility.description')}
        >
          <ConfigPageRow
            label={t('compatibility.reference.label')}
            align="center"
          >
            <Button variant="outline" size="sm" onClick={openCodexHooksDoc} leadingIcon={<Icon name="arrow-up-right" size="sm" />}>

              {t('compatibility.reference.open')}
            </Button>
          </ConfigPageRow>
        </ConfigPageSection>
      </ConfigPageContent>

      <Dialog
        open={reviewPlan !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && busyKey !== 'apply') {
            setReviewPlan(null);
            setPlanNotice(null);
          }
        }}
        size="lg"
        closeOnPointerOutside={busyKey !== 'apply'}
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('imports.reviewTitle', { name: reviewPlan?.source.displayName ?? '' })}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
        {reviewPlan ? (
          <div>
            {planNotice ? <p role="status">{planNotice}</p> : null}
            <p>{t('imports.reviewWarning')}</p>
            {reviewPlan.handlers.map((handler) => (
              <section key={handler.stableKey}>
                <h4>{handler.event}{handler.matcher ? ` · ${handler.matcher}` : ''}</h4>
                <pre>{handler.command}</pre>
                {handler.commandWindows ? <pre>{handler.commandWindows}</pre> : null}
                <p>{t('imports.timeout', { seconds: handler.timeoutSeconds ?? 60 })}</p>
                {handler.dependencies.map((dependency) => (
                  <p key={`${dependency.kind}:${dependency.kind === 'managed'
                    ? dependency.relativePath
                    : dependency.location}`}>
                    {t(`imports.dependency.${dependency.kind}`)}: {
                      dependency.kind === 'managed'
                        ? dependency.relativePath
                        : dependency.location
                    }
                  </p>
                ))}
              </section>
            ))}
            {reviewPlan.skipped.map((skipped) => (
              <p key={skipped.reasonCode}>
                {t('imports.skipped', { reason: skipped.reasonCode, count: skipped.count })}
              </p>
            ))}
          </div>
        ) : null}
        </DialogBody>
        {reviewPlan ? (
          <DialogFooter separator>
            <Button
              variant="fill"
              disabled={busyKey === 'apply'}
              onClick={() => {
                setReviewPlan(null);
                setPlanNotice(null);
              }}
            >
              {t('imports.cancel')}
            </Button>
            <Button variant="primary"
              loading={busyKey === 'apply'}
              disabled={reviewPlan.handlers.length === 0}
              onClick={() => void applyReviewedPlan()}
            >
              {t(reviewUpdatesExistingImport ? 'imports.confirmUpdate' : 'imports.confirm')}
            </Button>
          </DialogFooter>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={() => setConfirmation(null)}
        onConfirm={confirmMutation}
        title={confirmation?.kind === 'reset'
          ? t('imports.resetTitle')
          : t('imports.removeTitle')}
        message={confirmation?.kind === 'reset'
          ? t('imports.resetWarning')
          : t('imports.removeSourceUntouched')}
        confirmText={confirmation?.kind === 'reset'
          ? t('imports.resetConfirm')
          : t('imports.removeConfirm')}
        confirmDanger
      />
      <ConfirmDialog
        open={projectHooksEnableConfirmOpen}
        onOpenChange={(open) => { if (!open) setProjectHooksEnableConfirmOpen(false); }}
        onConfirm={() => {
          setProjectHooksEnableConfirmOpen(false);
          void updateConfig('project_hooks_enabled', true);
        }}
        title={t('projectHooksRisk.title')}
        message={t('projectHooksRisk.message', {
          workspace: workspacePath || t('projectHooksRisk.currentWorkspace'),
        })}
        confirmText={t('projectHooksRisk.confirm')}
        type="warning"
      />
    </>
  );

  if (embedded) {
    return (
      <div className="openbitfun-hooks-config openbitfun-hooks-config--embedded">
        {content}
      </div>
    );
  }

  return (
    <ConfigPageLayout>
      <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />
      {content}
    </ConfigPageLayout>
  );
};

export default HooksConfig;
