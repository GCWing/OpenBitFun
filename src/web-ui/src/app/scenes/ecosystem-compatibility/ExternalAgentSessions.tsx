import { useEffect, useId, useRef, useState } from 'react';
import { Alert, Switch } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { externalSessionImportAPI, type ExternalSessionEcosystem } from '@/infrastructure/api/service-api/ExternalSessionImportAPI';
import { EXTERNAL_SESSION_NAMES } from '@/shared/types/external-session';
import { RemovedExternalSessions } from './RemovedExternalSessions';

interface Props {
  ecosystemId?: ExternalSessionEcosystem;
  onBusyChange?: (busy: boolean) => void;
  refreshVersion?: number;
}

const CONFIG_PATH = 'app.external_session_discovery';

/** Only the serving host reads source history, when its workspace is opened. */
export default function ExternalAgentSessions({ ecosystemId = 'codex', onBusyChange, refreshVersion = 0 }: Props) {
  const { t } = useI18n('scenes/ecosystem-compatibility');
  const labelId = useId();
  const descriptionId = useId();
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removedBusy, setRemovedBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const pending = useRef(false);
  const sourceName = EXTERNAL_SESSION_NAMES[ecosystemId];

  useEffect(() => {
    const version = ++request.current;
    const surface = getActiveSurfaceScope();
    const current = () => request.current === version && surface.isCurrent();
    setAvailable(false);
    setBusy(true);
    setError(undefined);
    void configAPI.getConfig(CONFIG_PATH, { skipRetryOnNotFound: true }).then(async (settings) => {
      if (!current()) return;
      // Missing fields identify older hosts: never turn a local UI preference
      // into an apparent capability on a peer that cannot perform discovery.
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        setError('sessions.autoDiscovery.unsupported');
        return;
      }
      // Older hosts accept arbitrary preference keys but cannot read new source
      // formats. The existing read-only lifecycle operation validates the source
      // on that host before this UI enables its discovery switch.
      if (ecosystemId !== 'codex' && ecosystemId !== 'zcode') {
        await externalSessionImportAPI.listRemoved(ecosystemId);
        if (!current()) return;
      }
      setEnabled(settings[ecosystemId] === true);
      setAvailable(true);
    }).catch((error) => { if (current()) setError(
      error?.code === 'unsupported' || error?.code === 'incompatible_version'
        ? 'sessions.autoDiscovery.unsupported' : 'sessions.autoDiscovery.loadFailed',
    ); })
      .finally(() => { if (current()) setBusy(false); });
    return () => { request.current += 1; };
  }, [ecosystemId, refreshVersion]);

  useEffect(() => { onBusyChange?.(busy || removedBusy); }, [busy, removedBusy, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);

  async function change(next: boolean) {
    if (!available || pending.current || busy) return;
    const version = request.current;
    const surface = getActiveSurfaceScope();
    const current = () => request.current === version && surface.isCurrent();
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await configManager.setConfig(`${CONFIG_PATH}.${ecosystemId}`, next);
      if (current()) setEnabled(next);
    } catch {
      if (current()) setError('sessions.autoDiscovery.saveFailed');
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  return (
    <div className="ecosystem-compatibility__unified-stack">
    <section className="ecosystem-compatibility__section" aria-labelledby={labelId}>
      <div className="ecosystem-compatibility__section-heading">
      <label className="ecosystem-compatibility__discovery-switch">
        <span id={labelId}>{t('sessions.autoDiscovery.label', { name: sourceName })}</span>
        <Switch checked={enabled} disabled={!available || busy} aria-busy={busy}
          aria-labelledby={labelId} aria-describedby={descriptionId}
          onChange={(event) => void change(event.target.checked)} />
      </label>
      <p id={descriptionId}>{t('sessions.autoDiscovery.description', { name: sourceName })}</p>
      </div>
      {error ? <Alert role="alert" message={t(error)} /> : null}
    </section>
    <RemovedExternalSessions ecosystemId={ecosystemId} refreshVersion={refreshVersion} onBusyChange={setRemovedBusy} />
    </div>
  );
}
