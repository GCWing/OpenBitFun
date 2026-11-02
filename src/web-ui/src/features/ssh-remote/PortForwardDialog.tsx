/**
 * Remote Port Forwarding Dialog
 *
 * A forward exists because the user asked for it: either here, or by
 * Ctrl/Cmd+clicking a loopback link in a remote terminal (`openTerminalLink`),
 * which lands in the same list. Nothing is forwarded in the background.
 *
 * Detection runs on open, though — knowing what the remote is listening on is
 * not the same as forwarding it, and making people type a port number they
 * would otherwise have to go look up is friction with nothing behind it. One
 * click on a detected port creates the mapping; the form below stays for the
 * cases detection cannot cover (a specific local port, a non-loopback remote
 * host).
 *
 * The rows keep the remote port and the local address in separate columns
 * because they routinely differ: the remote port is what the user thinks in,
 * the local port is an allocation that moves when the number is taken.
 */

import { OverflowText,
  Button,
  Checkbox,
  FieldGroup,
  FormSection,
  Icon,
  IconButton,
  Input,
  Tooltip,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { createLogger } from '@/shared/utils/logger';
import { AlertTriangle, Network } from 'lucide-react';
import { sshApi } from './sshApi';
import type { PortForward, RemoteListeningPort } from './types';
import './PortForwardDialog.scss';

const log = createLogger('PortForwardDialog');

/**
 * How often the rows refresh their counters while the dialog is open.
 *
 * The backend keeps the numbers in atomics and snapshots on demand, so polling
 * costs one cheap command; anything faster just makes the digits flicker.
 */
const REFRESH_INTERVAL_MS = 2000;

interface PortForwardDialogProps {
  open: boolean;
  connectionId: string;
  connectionName?: string;
  onClose: () => void;
}

/** Parse a port field, distinguishing "empty" from "invalid". */
function parsePortInput(value: string): { port?: number; valid: boolean } {
  const trimmed = value.trim();
  if (!trimmed) return { valid: true };
  if (!/^\d+$/.test(trimmed)) return { valid: false };
  const port = Number(trimmed);
  if (port < 1 || port > 65535) return { valid: false };
  return { port, valid: true };
}

/** Address to hand a browser. A wildcard bind is only reachable here via loopback. */
function localAddressOf(forward: PortForward): string {
  const host =
    forward.localHost === '0.0.0.0'
      ? '127.0.0.1'
      : forward.localHost === '::'
        ? '[::1]'
        : forward.localHost;
  return `${host}:${forward.localPort}`;
}

export const PortForwardDialog: React.FC<PortForwardDialogProps> = ({
  open,
  connectionId,
  connectionName,
  onClose,
}) => {
  const { t } = useI18n('common');

  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [remotePort, setRemotePort] = useState('');
  const [localPort, setLocalPort] = useState('');
  const [label, setLabel] = useState('');
  const [exposeOnLan, setExposeOnLan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPort, setBusyPort] = useState<number | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [detectedPorts, setDetectedPorts] = useState<RemoteListeningPort[] | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const remotePortInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setForwards(await sshApi.listPortForwards(connectionId));
    } catch (err) {
      log.error('Failed to list port forwards', err);
    }
  }, [connectionId]);

  const detect = useCallback(async () => {
    setIsDetecting(true);
    try {
      setDetectedPorts(await sshApi.listRemoteListeningPorts(connectionId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDetectedPorts([]);
    } finally {
      setIsDetecting(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  // Detect once per opening. Re-detecting on every poll would fight the user's
  // cursor, and a listing captured minutes ago is worse than no listing.
  useEffect(() => {
    if (!open) return;
    void detect();
  }, [open, detect]);

  useEffect(() => {
    if (open) return;
    setDetectedPorts(null);
    setError(null);
  }, [open]);

  const remotePortParsed = useMemo(() => parsePortInput(remotePort), [remotePort]);
  const localPortParsed = useMemo(() => parsePortInput(localPort), [localPort]);
  const canSubmit =
    !isStarting &&
    remotePortParsed.valid &&
    remotePortParsed.port !== undefined &&
    localPortParsed.valid;

  const startForward = useCallback(
    async (request: {
      remotePort: number;
      localPort?: number;
      label?: string;
      exposeOnLan?: boolean;
    }) => {
      setError(null);
      try {
        await sshApi.startPortForward({
          connectionId,
          remotePort: request.remotePort,
          localPort: request.localPort,
          exposeOnLan: request.exposeOnLan ?? false,
          label: request.label,
        });
        await refresh();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [connectionId, refresh]
  );

  const handleAdd = useCallback(async () => {
    if (remotePortParsed.port === undefined || !localPortParsed.valid) return;
    setIsStarting(true);
    const ok = await startForward({
      remotePort: remotePortParsed.port,
      localPort: localPortParsed.port,
      label: label.trim() || undefined,
      exposeOnLan,
    });
    setIsStarting(false);
    if (ok) {
      setRemotePort('');
      setLocalPort('');
      setLabel('');
      remotePortInputRef.current?.focus();
    }
  }, [exposeOnLan, label, localPortParsed, remotePortParsed.port, startForward]);

  /** One click on a detected port is still the user asking for the mapping. */
  const handleForwardDetected = useCallback(
    async (port: RemoteListeningPort) => {
      setBusyPort(port.port);
      await startForward({ remotePort: port.port, label: port.process ?? undefined });
      setBusyPort(null);
    },
    [startForward]
  );

  const handleStop = useCallback(
    async (forwardId: string) => {
      try {
        await sshApi.stopPortForward(forwardId);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh]
  );

  const handleOpen = useCallback((forward: PortForward) => {
    void systemAPI
      .openExternal(`http://${localAddressOf(forward)}`)
      .catch((err) => log.error('Failed to open forwarded address', err));
  }, []);

  const handleCopy = useCallback((forward: PortForward) => {
    void systemAPI
      .setClipboard(localAddressOf(forward))
      .catch((err) => log.error('Failed to copy forwarded address', err));
  }, []);

  const forwardedRemotePorts = useMemo(
    () => new Set(forwards.map((forward) => forward.remotePort)),
    [forwards]
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      size="lg"
      data-testid="ssh-port-forward-dialog"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{t('ssh.portForward.title')}{connectionName ? (
          <span className="port-forward-dialog__target">{connectionName}</span>
        ) : undefined}</DialogTitle>
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody>
        <div className="port-forward-dialog__modal">
      <div
        className="port-forward-dialog"
        data-openbitfun-component="ssh-remote"
        data-openbitfun-part="portForward"
      >
        <div
          className="port-forward-dialog__intro"
          data-openbitfun-component="ssh-remote"
          data-openbitfun-part="portForwardIntro"
        >
          <Network size={18} aria-hidden="true" />
          <p>{t('ssh.portForward.intro')}</p>
        </div>

        {error && (
          <div
            className="port-forward-dialog__error"
            role="alert"
            data-openbitfun-component="ssh-remote"
            data-openbitfun-part="portForwardError"
          >
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {/* Discovery first: it answers "which port?" without making anyone look it up. */}
        <FormSection
          className="port-forward-dialog__section"
          title={t('ssh.portForward.detectedTitle')}
          actions={(
            <Tooltip content={t('ssh.portForward.detect')}>
              <IconButton
                type="button"
                size="sm"
                disabled={isDetecting}
                aria-label={t('ssh.portForward.detect')}
                data-testid="ssh-port-forward-detect"
                onClick={() => void detect()}
                icon={<Icon name="refresh" size="sm" className={isDetecting ? 'port-forward-dialog__spin' : undefined} aria-hidden="true" />}
              />
            </Tooltip>
          )}
        >
          <div className="port-forward-dialog__section-body">
            {isDetecting && detectedPorts === null ? (
              <p className="port-forward-dialog__empty">{t('ssh.portForward.detecting')}</p>
            ) : detectedPorts && detectedPorts.length > 0 ? (
              <div className="port-forward-dialog__chips">
                {detectedPorts.map((port) => {
                  const alreadyForwarded = forwardedRemotePorts.has(port.port);
                  return (
                    <button
                      key={`${port.port}-${port.bindAddress}`}
                      type="button"
                      className="port-forward-dialog__chip"
                      data-state={alreadyForwarded ? 'forwarded' : 'idle'}
                      disabled={alreadyForwarded || busyPort === port.port}
                      title={
                        alreadyForwarded
                          ? t('ssh.portForward.detectedAlreadyForwarded')
                          : t('ssh.portForward.detectedUse')
                      }
                      onClick={() => void handleForwardDetected(port)}
                      data-testid="ssh-port-forward-chip"
                      data-port={port.port}
                    >
                      {alreadyForwarded ? (
                        <Icon name="check-line" size="xs" aria-hidden="true" />
                      ) : (
                        <Icon name="plus" size="xs" aria-hidden="true" />
                      )}
                      <span className="port-forward-dialog__chip-port">{port.port}</span>
                      {port.process && (
                        <span className="port-forward-dialog__chip-process">{port.process}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="port-forward-dialog__empty">{t('ssh.portForward.detectedEmpty')}</p>
            )}
          </div>
        </FormSection>

        <FormSection
          className="port-forward-dialog__section"
          data-openbitfun-component="ssh-remote"
          data-openbitfun-part="portForwardTable"
          title={t('ssh.portForward.activeTitle')}
        >

          {forwards.length === 0 ? (
            <div className="port-forward-dialog__section-body">
              <p className="port-forward-dialog__empty">{t('ssh.portForward.empty')}</p>
            </div>
          ) : (
            <div className="port-forward-dialog__rows">
              {forwards.map((forward) => (
                <div
                  key={forward.id}
                  className="port-forward-dialog__row"
                  data-testid="ssh-port-forward-row"
                >
                  <div className="port-forward-dialog__row-copy">
                    <code className="port-forward-dialog__remote">
                      {forward.remoteHost !== '127.0.0.1'
                        ? `${forward.remoteHost}:${forward.remotePort}`
                        : forward.remotePort}
                    </code>
                    <span className="port-forward-dialog__arrow" aria-hidden="true">
                      →
                    </span>
                    <code className="port-forward-dialog__local">{localAddressOf(forward)}</code>
                    <span className="port-forward-dialog__meta">
                      {forward.label && (
                        <OverflowText className="port-forward-dialog__label">{forward.label}</OverflowText>
                      )}
                      {forward.lastError ? (
                        <span
                          className="port-forward-dialog__status port-forward-dialog__status--warn"
                          title={forward.lastError}
                        >
                          <AlertTriangle size={12} aria-hidden="true" />
                          {t('ssh.portForward.statusWarning')}
                        </span>
                      ) : (
                        <span className="port-forward-dialog__status">
                          {t('ssh.portForward.statusActive', {
                            active: forward.activeConnections,
                          })}
                        </span>
                      )}
                    </span>
                    {forward.requestedLocalPort !== undefined &&
                      forward.requestedLocalPort !== null && (
                        <span className="port-forward-dialog__note port-forward-dialog__note--warn">
                          {t('ssh.portForward.portMoved', {
                            requested: forward.requestedLocalPort,
                            bound: forward.localPort,
                          })}
                        </span>
                      )}
                    {forward.localHost === '0.0.0.0' && (
                      <span className="port-forward-dialog__note">
                        {t('ssh.portForward.exposedOnLanBadge')}
                      </span>
                    )}
                  </div>

                  <div className="port-forward-dialog__row-actions">
                    <Tooltip content={t('ssh.portForward.openInBrowser')}>
                      <IconButton
                        type="button"
                        size="sm"
                        aria-label={t('ssh.portForward.openInBrowser')}
                        onClick={() => handleOpen(forward)}
                        icon={<Icon name="arrow-up-right" size="sm" aria-hidden="true" />}
                      />
                    </Tooltip>
                    <Tooltip content={t('ssh.portForward.copyAddress')}>
                      <IconButton
                        type="button"
                        size="sm"
                        aria-label={t('ssh.portForward.copyAddress')}
                        onClick={() => handleCopy(forward)}
                        icon={<Icon name="duplicate" size="sm" aria-hidden="true" />}
                      />
                    </Tooltip>
                    <Tooltip content={t('ssh.portForward.stop')}>
                      <IconButton
                        type="button"
                        size="sm"
                        aria-label={t('ssh.portForward.stop')}
                        onClick={() => void handleStop(forward.id)}
                        data-testid="ssh-port-forward-stop"
                        icon={<Icon name="xmark" size="sm" aria-hidden="true" />}
                      />
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </FormSection>

        {/* The escape hatch: a specific local port, or a host detection cannot see. */}
        <FormSection className="port-forward-dialog__section" title={t('ssh.portForward.manualTitle')}>
          <div className="port-forward-dialog__section-body">
            <FieldGroup
              appearance="plain"
              dividers={false}
              className="port-forward-dialog__form"
              data-openbitfun-component="ssh-remote"
              data-openbitfun-part="portForwardForm"
            >
              <label className="port-forward-dialog__field">
                <span>{t('ssh.portForward.remotePortLabel')}</span>
                <Input
                  ref={remotePortInputRef}
                  value={remotePort}
                  placeholder="3000"
                  invalid={!remotePortParsed.valid}
                  onChange={(event) => setRemotePort(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canSubmit) void handleAdd();
                  }}
                  data-testid="ssh-port-forward-remote-port"
                  size="sm"
                />
              </label>

              <label className="port-forward-dialog__field">
                <span>{t('ssh.portForward.localPortLabel')}</span>
                <Input
                  value={localPort}
                  placeholder={t('ssh.portForward.localPortPlaceholder')}
                  invalid={!localPortParsed.valid}
                  onChange={(event) => setLocalPort(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canSubmit) void handleAdd();
                  }}
                  data-testid="ssh-port-forward-local-port"
                  size="sm"
                />
              </label>

              <label className="port-forward-dialog__field port-forward-dialog__field--grow">
                <span>{t('ssh.portForward.labelLabel')}</span>
                <Input
                  value={label}
                  placeholder={t('ssh.portForward.labelPlaceholder')}
                  onChange={(event) => setLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canSubmit) void handleAdd();
                  }}
                  size="sm"
                />
              </label>

              <Button
                variant="outline"
                size="sm"
                disabled={!canSubmit}
                onClick={() => void handleAdd()}
                data-testid="ssh-port-forward-add"
              >
                {t('ssh.portForward.add')}
              </Button>
            </FieldGroup>

            <Checkbox
              size="sm"
              checked={exposeOnLan}
              onChange={(event) => setExposeOnLan(event.target.checked)}
              label={t('ssh.portForward.exposeOnLan')}
              description={t('ssh.portForward.exposeOnLanHint')}
            />
          </div>
        </FormSection>
      </div>
            </div>
            </DialogBody>
    </Dialog>
  );
};

export default PortForwardDialog;
