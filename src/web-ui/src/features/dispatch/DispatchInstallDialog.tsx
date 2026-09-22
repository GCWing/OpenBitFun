import { useDeviceDirectory, resolveDeviceName } from '@/infrastructure/account/deviceDirectory';
import {
  Alert,
  Button,
  Checkbox,
  Icon,
  Input,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Disclosure,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import { Loader2 } from 'lucide-react';
import { dispatchApi } from './dispatchApi';
import type {
  DispatchSelection,
  DispatchSshProbe,
  DispatchTargetOption,
} from './types';
import {
  BASE_DISPATCH_CAPABILITIES,
  DISPATCH_PROTOCOL_VERSION,
} from './dispatchPreflight';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { gitAPI } from '@/infrastructure/api/service-api/GitAPI';
import type { WorktreeSettings } from '@/infrastructure/api/service-api/WorktreeAPI';
import './DispatchInstallDialog.scss';

const log = createLogger('DispatchInstallDialog');
const DIALOG_TITLE_ID = 'dispatch-install-dialog-title';
type TargetPreparationPhase = 'installing' | 'provisioning' | 'cancelling';


interface DispatchInstallDialogProps {
  open: boolean;
  target: DispatchTargetOption | null;
  sourceWorkspacePath?: string;
  sourceWorkspaceId?: string;
  onClose: () => void;
  onReady: (selection: DispatchSelection) => void;
}

export const DispatchInstallDialog: React.FC<DispatchInstallDialogProps> = ({
  open,
  target,
  sourceWorkspacePath,
  sourceWorkspaceId,
  onClose,
  onReady,
}) => {
  useDeviceDirectory();
  const { t } = useI18n('common');
  const [includeUncommitted, setIncludeUncommitted] = useState(false);
  const [baseRef, setBaseRef] = useState('HEAD');
  const [baseRefError, setBaseRefError] = useState<string | null>(null);
  const [validatingBaseRef, setValidatingBaseRef] = useState(false);
  const [worktreeSettingsLoading, setWorktreeSettingsLoading] = useState(true);
  const [probe, setProbe] = useState<DispatchSshProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState(false);
  const [preparationPhase, setPreparationPhase] = useState<TargetPreparationPhase | null>(null);
  const [preparationOutcome, setPreparationOutcome] = useState<'synced' | 'cli-only' | null>(null);
  const [provisionRetryAvailable, setProvisionRetryAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const installActiveRef = useRef(false);
  const includeUncommittedTouchedRef = useRef(false);

  const connectionId = target?.connectionId?.trim() ?? '';
  const deviceId = target?.deviceId?.trim() ?? '';
  const targetId = target?.kind === 'device' ? deviceId : connectionId;

  const runProbe = useCallback(async () => {
    if (!targetId || !target || target.kind === 'local') return;
    // The target's own directories are irrelevant now: dispatch checks out its
    // own worktree there, so the probe only reports CLI and model readiness.
    const path = '';
    const generation = ++generationRef.current;
    setProbing(true);
    setProbeError(false);
    try {
      const result = await dispatchApi.probeTarget(
        target.kind === 'device'
          ? { kind: 'device', deviceId: targetId, workspacePath: path }
          : { kind: 'ssh', connectionId: targetId, workspacePath: path },
      );
      if (generation === generationRef.current) {
        setProbe(result);
      }
    } catch (nextError) {
      if (generation === generationRef.current) {
        setProbe(null);
        setProbeError(true);
        log.warn('Failed to check dispatch target readiness', {
          targetKind: target.kind,
          targetId,
          error: nextError,
        });
      }
    } finally {
      if (generation === generationRef.current) {
        setProbing(false);
      }
    }
  }, [target, targetId]);

  useEffect(() => {
    if (!open || !targetId) return;
    includeUncommittedTouchedRef.current = false;
    setIncludeUncommitted(false);
    setBaseRef('HEAD');
    setBaseRefError(null);
    setValidatingBaseRef(false);
    setWorktreeSettingsLoading(true);
    setProbe(null);
    setProbeError(false);
    setPreparationPhase(null);
    setPreparationOutcome(null);
    setProvisionRetryAvailable(false);
    installActiveRef.current = false;
    setError(null);
    void runProbe();
  }, [open, runProbe, targetId]);

  // Dispatch uses the same baseline creation path as the regular worktree
  // control, so its initial copy-local-changes choice follows that setting.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setWorktreeSettingsLoading(true);
    void configAPI.getConfig('app.worktrees', { skipRetryOnNotFound: true })
      .then(settings => {
        if (!cancelled && !includeUncommittedTouchedRef.current) {
          const configured = settings as Partial<WorktreeSettings> | undefined;
          setIncludeUncommitted(configured?.copyLocalChanges === true);
        }
      })
      .catch(nextError => {
        log.warn('Failed to read worktree settings for dispatch', {
          error: nextError,
        });
        if (!cancelled && !includeUncommittedTouchedRef.current) {
          setIncludeUncommitted(false);
        }
      })
      .finally(() => {
        if (!cancelled) setWorktreeSettingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, targetId]);

  // Retires every in-flight probe, model sync, and revision check, so a result
  // that lands after the dialog moved on cannot write to a closed dialog.
  const invalidatePendingWork = useCallback(() => {
    generationRef.current += 1;
  }, []);

  useEffect(() => {
    if (!open || !targetId) return;
    return () => {
      invalidatePendingWork();
      if (installActiveRef.current && connectionId) {
        void dispatchApi.installCliCancel(connectionId).catch(nextError => {
          log.warn('Failed to cancel target preparation during dialog cleanup', {
            connectionId,
            error: nextError,
          });
        });
      }
    };
  }, [connectionId, invalidatePendingWork, open, targetId]);

  const prepareTarget = useCallback(async () => {
    if (!connectionId || !probe?.release || preparationPhase) return;
    const generation = ++generationRef.current;
    setPreparationPhase('installing');
    setPreparationOutcome(null);
    setProvisionRetryAvailable(false);
    setError(null);
    let installStarted = false;
    let installCompleted = false;
    try {
      await dispatchApi.installCliStart(connectionId, probe.release);
      installStarted = true;
      installActiveRef.current = true;
      let cursor = 0;
      for (;;) {
        if (generation !== generationRef.current) return;
        const poll = await dispatchApi.installCliPoll(connectionId, cursor);
        cursor = poll.cursor;
        if (poll.status === 'succeeded') break;
        if (poll.status === 'failed') {
          // Carry the installer's own tail into the error: without it the only
          // record of the failure is a generic message, and the remote state
          // that would explain it is cleaned up before anyone can look.
          const detail = poll.output.trim();
          throw new Error(
            detail
              ? `Target CLI installation failed: ${detail}`
              : 'Target CLI installation failed with no installer output',
          );
        }
        await new Promise(resolve => globalThis.setTimeout(resolve, 750));
      }
      installCompleted = true;
      installActiveRef.current = false;
      if (generation !== generationRef.current) return;
      setPreparationPhase('provisioning');
      const result = await dispatchApi.provisionTarget(connectionId);
      if (generation !== generationRef.current) return;
      setPreparationOutcome(
        result.accountStatus === 'synced' && result.daemonInstalled ? 'synced' : 'cli-only',
      );
      setProvisionRetryAvailable(false);
    } catch (nextError) {
      installActiveRef.current = false;
      if (generation !== generationRef.current) return;
      setProvisionRetryAvailable(installCompleted);
      setError(t('dispatch.prepareFailed'));
      log.warn('Failed to prepare SSH dispatch target', {
        connectionId,
        installStarted,
        error: nextError,
      });
    } finally {
      if (generation === generationRef.current) {
        setPreparationPhase(null);
        await runProbe();
      }
    }
  }, [connectionId, preparationPhase, probe?.release, runProbe, t]);

  const retryProvisioning = useCallback(async () => {
    if (!connectionId || preparationPhase) return;
    const generation = ++generationRef.current;
    setPreparationPhase('provisioning');
    setPreparationOutcome(null);
    setProvisionRetryAvailable(false);
    setError(null);
    try {
      const result = await dispatchApi.provisionTarget(connectionId);
      if (generation !== generationRef.current) return;
      setPreparationOutcome(
        result.accountStatus === 'synced' && result.daemonInstalled ? 'synced' : 'cli-only',
      );
    } catch (nextError) {
      if (generation !== generationRef.current) return;
      setProvisionRetryAvailable(true);
      setError(t('dispatch.prepareFailed'));
      log.warn('Failed to retry SSH target account provisioning', {
        connectionId,
        error: nextError,
      });
    } finally {
      if (generation === generationRef.current) {
        setPreparationPhase(null);
        await runProbe();
      }
    }
  }, [connectionId, preparationPhase, runProbe, t]);

  const cancelPreparation = useCallback(async () => {
    if (!connectionId || preparationPhase !== 'installing') return;
    ++generationRef.current;
    setPreparationPhase('cancelling');
    try {
      await dispatchApi.installCliCancel(connectionId);
      setError(t('dispatch.prepareCancelled'));
    } catch (nextError) {
      setError(t('dispatch.prepareCancelFailed'));
      log.warn('Failed to cancel SSH target preparation', {
        connectionId,
        error: nextError,
      });
    } finally {
      installActiveRef.current = false;
      setPreparationPhase(null);
      await runProbe();
    }
  }, [connectionId, preparationPhase, runProbe, t]);

  const closeDialog = useCallback(() => {
    if (preparationPhase) return;
    invalidatePendingWork();
    onClose();
  }, [invalidatePendingWork, onClose, preparationPhase]);

  const handleModalClose = useCallback(() => {
    // Keep Escape, the close button, and backdrop clicks from silently
    // abandoning a target mutation that is already under way.
    if (preparationPhase) return;
    closeDialog();
  }, [closeDialog, preparationPhase]);

  const protocol = probe?.protocol;
  const requiredCapabilities = [...BASE_DISPATCH_CAPABILITIES];
  const missingCapabilities = protocol
    ? requiredCapabilities.filter(capability => !protocol.capabilities.includes(capability))
    : requiredCapabilities;
  const protocolCompatible =
    protocol?.protocolVersion === DISPATCH_PROTOCOL_VERSION &&
    missingCapabilities.length === 0;
  const cliReady =
    !!probe?.cliInstalled &&
    !!protocol &&
    !probe.protocolError &&
    protocolCompatible;
  // The source workspace is owned by ID; the path only labels its checkout.
  const workspaceReady = !!sourceWorkspaceId?.trim() || !!sourceWorkspacePath?.trim();
  /** A compatible signed release makes one-click preparation available. */
  const installPending =
    !cliReady
    && target?.kind === 'ssh'
    && !!probe?.installSupported
    && !probe?.prebuiltIncompatible;
  /**
   * The published binary is the only way a target gets a CLI. When none fits,
   * say so here rather than letting submit fail on an unusable target.
   */
  const installUnavailable = !cliReady && target?.kind === 'ssh' && !!probe && !installPending;
  /**
   * Model readiness is deliberately absent: the model is chosen in the
   * composer like any local session, and submission pushes this device's model
   * configuration to a target that cannot serve the choice. Gating here would
   * ask the user to solve a problem the backend already solves.
   */
  const ready = workspaceReady && cliReady;
  const targetMutationInProgress = preparationPhase !== null;

  const confirmTarget = async () => {
    if (
      !target
      || target.kind === 'local'
      || !targetId
      || !ready
    ) return;
    const normalizedSourcePath = sourceWorkspacePath?.trim() || '';
    const normalizedBaseRef = baseRef.trim() || 'HEAD';
    const generation = generationRef.current;
    setValidatingBaseRef(true);
    setBaseRefError(null);
    try {
      await gitAPI.resolveRevision({ workspaceId: sourceWorkspaceId ?? '', repositoryPath: normalizedSourcePath }, normalizedBaseRef);
    } catch (nextError) {
      if (generation === generationRef.current) {
        log.warn('Failed to resolve dispatch base revision', {
          repositoryPath: normalizedSourcePath,
          revision: normalizedBaseRef,
          error: nextError,
        });
        setBaseRefError(t('dispatch.baseRefInvalid', { ref: normalizedBaseRef }));
      }
      return;
    } finally {
      if (generation === generationRef.current) {
        setValidatingBaseRef(false);
      }
    }
    if (generation !== generationRef.current) return;
    // The target chooses where its worktree lands, so nothing is sent here.
    const normalizedPath = '';
    const request = target.kind === 'device'
      ? {
          kind: 'device' as const,
          deviceId: targetId,
          workspacePath: normalizedPath,
        }
      : {
          kind: 'ssh' as const,
          connectionId: targetId,
          workspacePath: normalizedPath,
        };
    onReady({
      request,
      target: {
        ...request,
        workspacePath: normalizedPath,
        displayName: target.displayName,
      },
      includeUncommitted,
      baseRef: normalizedBaseRef,
      modelCatalog: protocol?.modelCatalog,
      availableModels: protocol?.availableModels,
      defaultModel: protocol?.defaultModel,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) handleModalClose(); }}
      size="md"
      closeOnPointerOutside={!targetMutationInProgress}
      aria-labelledby={DIALOG_TITLE_ID}
      data-testid="dispatch-install-dialog"
    >
      <div
        className="dispatch-install-dialog"
        data-openbitfun-component="dispatch-install-dialog"
        data-openbitfun-part="root"
      >
        <DialogHeader
          data-openbitfun-component="dispatch-install-dialog"
          data-openbitfun-part="header"
        >
          <DialogHeading>
            <DialogTitle id={DIALOG_TITLE_ID}>
              {t('dispatch.configureTitle', { target: target?.kind === 'device' && target.deviceId ? resolveDeviceName(target.deviceId, target.displayName) : target?.displayName ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('dispatch.configureSubtitle')}</DialogDescription>
          </DialogHeading>
          {!targetMutationInProgress && <DialogClose />}
        </DialogHeader>

        <DialogBody
          className="dispatch-install-dialog__body"
          data-openbitfun-component="dispatch-install-dialog"
          data-openbitfun-part="body"
        >
          {error ? (
            <Alert tone="error" message={error} closable onClose={() => setError(null)} />
          ) : null}
          {preparationOutcome ? (
            <Alert
              tone="success"
              message={t(
                preparationOutcome === 'synced'
                  ? 'dispatch.prepareSucceededWithAccount'
                  : 'dispatch.prepareSucceededCliOnly',
              )}
            />
          ) : null}
          {baseRefError ? (
            <Alert
              tone="error"
              message={baseRefError}
              closable
              onClose={() => setBaseRefError(null)}
            />
          ) : null}

          <section className="dispatch-install-dialog__section">
            <h3 className="dispatch-install-dialog__section-title">
              {t('dispatch.readinessTitle')}
            </h3>
            {probing || (!probe && !probeError) ? (
              <div className="dispatch-install-dialog__pending" role="status">
                <Loader2 size={14} className="dispatch-install-dialog__spin" />
                {t('dispatch.checkingTarget')}
              </div>
            ) : null}
            {probeError ? (
              <div className="dispatch-install-dialog__retry">
                <span className="dispatch-install-dialog__hint">
                  {t('dispatch.probeFailed')}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={probing}
                  onClick={() => void runProbe()}
                  leadingIcon={<Icon name="refresh" size="sm" aria-hidden />}
                >

                  {t('dispatch.retryCheck')}
                </Button>
              </div>
            ) : null}
            {probe ? (
              <div className="dispatch-install-dialog__checks">
                <div
                  className="dispatch-install-dialog__check-row"
                  data-state={
                    cliReady ? 'ok' : installPending || preparationPhase ? 'pending' : 'blocked'
                  }
                >
                  <span>{t('dispatch.cliStatus')}</span>
                  <strong>
                    {preparationPhase === 'installing'
                      ? t('dispatch.installingCli')
                      : preparationPhase === 'provisioning'
                        ? t('dispatch.provisioningDaemon')
                        : preparationPhase === 'cancelling'
                          ? t('dispatch.cancellingPreparation')
                          : cliReady
                      ? t('dispatch.cliReady', { version: protocol?.cliVersion })
                      : installPending
                        ? t('dispatch.cliCanDeploy')
                        : probe.cliInstalled
                          ? t('dispatch.cliUpdateRequired')
                          : t('dispatch.cliUnavailable')}
                  </strong>
                </div>
              </div>
            ) : null}
            {installPending && probe?.release ? (
              <>
                <div className="dispatch-install-dialog__retry">
                  <span className="dispatch-install-dialog__hint">
                    {t('dispatch.oneClickDeployDescription')}
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={targetMutationInProgress || probing}
                    onClick={() => void prepareTarget()}
                  >
                    {preparationPhase ? (
                      <Loader2 size={14} className="dispatch-install-dialog__spin" />
                    ) : (
                      <Icon name="arrow-down" size="sm" aria-hidden />
                    )}
                    {preparationPhase === 'installing'
                      ? t('dispatch.installingCli')
                      : preparationPhase === 'provisioning'
                        ? t('dispatch.provisioningDaemon')
                        : t('dispatch.oneClickDeploy')}
                  </Button>
                </div>
                <Disclosure
                  className="dispatch-install-dialog__details"
                  summary={t('dispatch.installDetails')}
                >
                  <dl>
                    <div><dt>{t('dispatch.version')}</dt><dd>{probe.release.version}</dd></div>
                    <div><dt>{t('dispatch.downloadUrl')}</dt><dd>{probe.release.url}</dd></div>
                    <div><dt>{t('dispatch.integrity')}</dt><dd>{probe.release.sha256}</dd></div>
                  </dl>
                </Disclosure>
              </>
            ) : null}
            {installUnavailable ? (
              <Alert tone="warning" message={t('dispatch.installUnavailable')} />
            ) : null}
            {cliReady && provisionRetryAvailable ? (
              <div className="dispatch-install-dialog__retry">
                <span className="dispatch-install-dialog__hint">
                  {t('dispatch.retryProvisionDescription')}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={targetMutationInProgress || probing}
                  onClick={() => void retryProvisioning()}
                >
                  {preparationPhase === 'provisioning' ? (
                    <Loader2 size={14} className="dispatch-install-dialog__spin" />
                  ) : (
                    <Icon name="refresh" size="sm" aria-hidden />
                  )}
                  {t('dispatch.retryProvision')}
                </Button>
              </div>
            ) : null}
            {target?.kind === 'device' && probe && !cliReady ? (
              <div className="dispatch-install-dialog__retry">
                <span className="dispatch-install-dialog__hint">
                  {t('dispatch.deviceUpdateRequired')}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={probing}
                  onClick={() => void runProbe()}
                  leadingIcon={<Icon name="refresh" size="sm" aria-hidden />}
                >

                  {t('dispatch.retryCheck')}
                </Button>
              </div>
            ) : null}
          </section>

          <section className="dispatch-install-dialog__section">
            <h3 className="dispatch-install-dialog__section-title">
              {t('dispatch.deliveryTitle')}
            </h3>
            <div className="dispatch-install-dialog__field">
              <span className="dispatch-install-dialog__field-label">
                {t('dispatch.baselineSource')}
              </span>
              <code className="dispatch-install-dialog__path">{sourceWorkspacePath}</code>
            </div>
            <span className="dispatch-install-dialog__hint">
              {t('dispatch.baselineDescription')}
            </span>
            <label className="dispatch-install-dialog__field dispatch-install-dialog__base-ref">
              <span className="dispatch-install-dialog__field-label">
                {t('dispatch.baseRef')}
              </span>
              <Input
                type="text"
                size="md"
                value={baseRef}
                disabled={targetMutationInProgress || validatingBaseRef}
                spellCheck={false}
                onValueChange={value => {
                  setBaseRef(value);
                  setBaseRefError(null);
                }}
                placeholder="HEAD"
              />
              <span className="dispatch-install-dialog__hint">
                {t('dispatch.baseRefHint')}
              </span>
            </label>
            <Checkbox
              className="dispatch-install-dialog__toggle"
              checked={includeUncommitted}
              disabled={targetMutationInProgress || validatingBaseRef}
              onCheckedChange={checked => {
                includeUncommittedTouchedRef.current = true;
                setIncludeUncommitted(checked);
              }}
              label={t('dispatch.includeUncommitted')}
              description={t('dispatch.includeUncommittedHint')}
            />
          </section>
        </DialogBody>

        <div
          className="dispatch-install-dialog__actions"
          data-openbitfun-component="dispatch-install-dialog"
          data-openbitfun-part="actions"
        >
          <DialogFooter>
          <Button
            variant="fill"
            size="sm"
            disabled={
              preparationPhase === 'provisioning'
              || preparationPhase === 'cancelling'
            }
            onClick={
              preparationPhase === 'installing'
                ? () => void cancelPreparation()
                : closeDialog
            }
          >
            {preparationPhase === 'installing'
              ? t('dispatch.cancelPreparation')
              : preparationPhase === 'cancelling'
                ? t('dispatch.cancellingPreparation')
                : t('dispatch.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={
              !ready
              || targetMutationInProgress
              || probing
              || validatingBaseRef
              || worktreeSettingsLoading
            }
            onClick={() => void confirmTarget()}
          >
            {validatingBaseRef ? (
              <Loader2 size={14} className="dispatch-install-dialog__spin" />
            ) : null}
            {t('dispatch.useTarget')}
          </Button>
          </DialogFooter>
        </div>
      </div>
    </Dialog>
  );
};
