import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, OverflowText, StatusPill } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { computerUseControlAPI, type ComputerUseGrant, type ComputerUsePermissionKind, type ComputerUsePermissionReceipt,
  type ComputerUsePermissions as PermissionStatus } from '@/infrastructure/api/service-api/ComputerUseControlAPI';

/** The query path only probes. Each request button is a distinct user gesture. */
export function ComputerUsePermissions({ showGrants = false }: { showGrants?: boolean }) {
  const { t } = useI18n('common');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [status, setStatus] = useState<{ epoch: number; value: PermissionStatus }>();
  const [receipt, setReceipt] = useState<ComputerUsePermissionReceipt>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [grants, setGrants] = useState<ComputerUseGrant[]>();
  const current = status?.epoch === scope.epoch ? status.value : undefined;
  const refresh = async () => {
    const response = await computerUseControlAPI.permissions();
    if (!scope.isCurrent()) return;
    if (!response.permissions) throw new Error(t('computerSharing.updateHost'));
    setStatus({ epoch: scope.epoch, value: response.permissions });
  };
  useEffect(() => {
    let disposed = false;
    setStatus(undefined); setReceipt(undefined); setGrants(undefined); setError(undefined); setBusy(false);
    void computerUseControlAPI.permissions().then(response => {
      if (disposed || !scope.isCurrent()) return;
      if (response.permissions) setStatus({ epoch: scope.epoch, value: response.permissions });
      else setError(t('computerSharing.updateHost'));
    }).catch(error => { if (!disposed && scope.isCurrent()) setError(String(error)); });
    return () => { disposed = true; };
  }, [scope, t]);
  const perform = async (work: () => Promise<void>) => {
    if (!scope.isCurrent()) return;
    setBusy(true); setError(undefined);
    try { await work(); } catch (error) { if (scope.isCurrent()) setError(String(error)); }
    finally { if (scope.isCurrent()) setBusy(false); }
  };
  const request = (kind: ComputerUsePermissionKind) => perform(async () => {
    const next = await computerUseControlAPI.requestPermission(kind);
    if (!scope.isCurrent()) return;
    setReceipt(next);
    await refresh();
  });
  return <div className="computer-control-card__permissions" data-openbitfun-component="computer-control" data-openbitfun-part="permissions">
    <div className="computer-control-card__row">
      <strong>{t('computerSharing.permissions')}</strong>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(refresh)}>{t('computerSharing.refresh')}</Button>
    </div>
    {current?.permissions.map(permission => <div className="computer-control-card__permission" key={permission.kind}>
      <div className="computer-control-card__row">
        <span>{t(`computerSharing.permissionNames.${permission.kind}`)}</span>
        <StatusPill tone={permission.state === 'granted' || permission.state === 'not_required' ? 'success' : 'neutral'}>
          {t(`computerSharing.permissionStates.${permission.state}`)}
        </StatusPill>
      </div>
      <p>{t(`computerSharing.permissionHelp.${permission.kind}`)}</p>
      <div className="computer-control-card__row">
        {permission.requestable && permission.state !== 'granted' && <Button size="sm" variant="outline" disabled={busy}
          onClick={() => void request(permission.kind)}>{t('computerSharing.requestPermission')}</Button>}
        {permission.settings_url && <Button size="sm" variant="text" disabled={busy}
          onClick={() => void perform(() => computerUseControlAPI.openPermissionSettings(permission.kind))}>{t('computerSharing.openSettings')}</Button>}
      </div>
    </div>)}
    {current?.executable && <details><summary>{t('computerSharing.permissionOwner')}</summary><OverflowText>{current.executable}</OverflowText></details>}
    {receipt && <p role="status">{t(receipt.current_granted ? 'computerSharing.permissionGranted'
      : receipt.request_api_invoked ? 'computerSharing.permissionRequested' : 'computerSharing.permissionSession')}
      {receipt.restart_may_be_required && <> {t('computerSharing.restartPermission')}</>}</p>}
    {showGrants && <details onToggle={event => {
      if (event.currentTarget.open && !grants) void perform(async () => {
        const next = await computerUseControlAPI.grants(); if (scope.isCurrent()) setGrants(next);
      });
    }}><summary>{t('computerSharing.rememberedGrants')}</summary>
      {grants?.length === 0 && <p>{t('computerSharing.noGrants')}</p>}
      {grants?.map(grant => <div className="computer-control-card__permission" key={`${grant.identity.executable}:${grant.identity.input_mode}:${grant.identity.executable_sha256}`}>
        <OverflowText>{grant.application_name}</OverflowText>
        <OverflowText>{grant.identity.executable}</OverflowText>
        <span>{t(grant.identity.input_mode === 'foreground' ? 'computerSharing.modeForeground' : 'computerSharing.modeBackground')}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(async () => {
          const warning = await computerUseControlAPI.forgetGrant(grant.identity);
          if (!scope.isCurrent()) return;
          const next = await computerUseControlAPI.grants();
          if (scope.isCurrent()) { setGrants(next); if (warning) setError(warning); }
        })}>{t('computerSharing.forgetGrant')}</Button>
      </div>)}
    </details>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
