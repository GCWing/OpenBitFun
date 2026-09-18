import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { Alert, Switch, Tooltip } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { externalSourcesAPI, type ExternalSourceCatalogSnapshot } from '@/infrastructure/api/service-api/ExternalSourcesAPI';

interface Props {
  snapshot: ExternalSourceCatalogSnapshot | null;
  onSnapshotChange: (snapshot: ExternalSourceCatalogSnapshot) => void;
  controlRef?: Ref<HTMLDivElement>;
}

/** Controls catalog discovery without changing runtime or import authorization. */
export default function ExternalDiscoveryToggle({ snapshot, onSnapshotChange, controlRef }: Props) {
  const { t } = useI18n('scenes/ecosystem-compatibility');
  const { workspace } = useCurrentWorkspace();
  const labelId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(false);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const discovery = snapshot?.discovery;
  const enabled = discovery?.enabled ?? false;
  const canChange = discovery?.canChange === true && typeof discovery.preferenceRevision === 'number';
  const description = !snapshot
    ? t('discovery.loadingDescription')
    : !canChange
      ? t('discovery.readOnlyDescription')
      // The mutation scopes by workspace ID, so the description must agree with it.
      : `${t(enabled ? 'discovery.enabledDescription' : 'discovery.disabledDescription')} ${t(workspace?.id ? 'discovery.workspaceScope' : 'discovery.userScope')}`;

  async function change(enabled: boolean) {
    if (!canChange || !snapshot || pending.current) return;
    const surface = getActiveSurfaceScope();
    const isCurrent = () => alive.current && surface.isCurrent();
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const next = await externalSourcesAPI.setAutomaticDiscovery(
        workspace?.id, enabled, discovery!.preferenceRevision,
      );
      if (isCurrent()) onSnapshotChange(next);
    } catch {
      if (!isCurrent()) return;
      setError(true);
      try {
        const current = await externalSourcesAPI.getDiscoverySnapshot(workspace?.id, false);
        if (isCurrent()) onSnapshotChange(current);
      } catch { /* Preserve the last confirmed state and keep the error visible. */ }
    } finally {
      if (alive.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <Tooltip content={description} trigger="hover-focus" placement="bottom">
      <div
        ref={controlRef}
        className="ecosystem-compatibility__discovery-control"
        data-external-discovery-control
        role="group"
        tabIndex={canChange ? -1 : 0}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
      >
        <label className="ecosystem-compatibility__discovery-switch">
          <span id={labelId}>{t('discovery.toggleLabel')}</span>
          <Switch
            checked={enabled}
            disabled={busy || !canChange}
            aria-labelledby={labelId}
            aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
            aria-busy={busy}
            onChange={(event) => void change(event.target.checked)}
          />
        </label>
        <span id={descriptionId} hidden>{description}</span>
        {error ? <Alert id={errorId} className="ecosystem-compatibility__notice ecosystem-compatibility__discovery-error" role="alert" showIcon={false} message={t('discovery.saveFailed')} /> : null}
      </div>
    </Tooltip>
  );
}
