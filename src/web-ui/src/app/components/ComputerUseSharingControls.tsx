import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Checkbox, Select } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { computerUseControlAPI, type ComputerUseControlSnapshot, type ComputerUseShareTarget } from '@/infrastructure/api/service-api/ComputerUseControlAPI';
import { ComputerUsePermissions } from './ComputerUsePermissions';

export function ComputerUseSharingControls({ snapshot, onSnapshot, onMutation }: {
  snapshot: ComputerUseControlSnapshot;
  onSnapshot: (snapshot: ComputerUseControlSnapshot) => void;
  onMutation: () => void;
}) {
  const { t } = useI18n('common');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [targets, setTargets] = useState<ComputerUseShareTarget[]>([]);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState(snapshot.sharing?.requested_mode ?? 'background');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [remember, setRemember] = useState(false);
  const selecting = snapshot.sharing?.phase === 'selecting';
  const refreshTargets = async () => {
    const next = await computerUseControlAPI.targets();
    if (!scope.isCurrent()) return;
    setTargets(next); setSelected('');
  };
  useEffect(() => {
    let disposed = false;
    setTargets([]); setSelected(''); setError(undefined); setBusy(false); setRemember(false);
    setMode(snapshot.sharing?.requested_mode ?? 'background');
    if (selecting) void computerUseControlAPI.targets().then(next => {
      if (!disposed && scope.isCurrent()) setTargets(next);
    }).catch(error => { if (!disposed && scope.isCurrent()) setError(String(error)); });
    return () => { disposed = true; };
    // The target selection belongs to one resource generation on one device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, snapshot.generation, selecting]);
  const perform = async (work: () => Promise<void>) => {
    if (!scope.isCurrent()) return;
    setBusy(true); setError(undefined); onMutation();
    try { await work(); } catch (error) { if (scope.isCurrent()) setError(String(error)); }
    finally { if (scope.isCurrent()) setBusy(false); }
  };
  const target = targets.find(target => target.selection_id === selected);
  return <div className="computer-control-card__sharing" data-openbitfun-component="computer-control" data-openbitfun-part="sharing">
    {selecting && <>
      <p>{t('computerSharing.selectDescription')}</p>
      <Select size="sm" aria-label={t('computerSharing.application')} value={selected} disabled={busy}
        placeholder={t('computerSharing.selectApp')} onValueChange={value => setSelected(String(value))}
        options={targets.map(target => ({ value: target.selection_id, label: target.selection_required ? t('computerSharing.portalPicker')
          : `${target.application}${target.title ? ` — ${target.title}` : ''}`, disabled: !!target.unavailable_reason }))} />
      <Select size="sm" aria-label={t('computerSharing.mode')} value={mode} disabled={busy}
        onValueChange={value => setMode(value as ComputerUseControlSnapshot['mode'])}
        options={[{ value: 'background', label: t('computerSharing.modeBackground') },
          { value: 'observe', label: t('computerSharing.modeObserve') },
          { value: 'foreground', label: t('computerSharing.modeForeground') }]} />
      {mode === 'foreground' && <p role="note">{t('computerSharing.foregroundNotice')}</p>}
      {target && !target.background_pointer && <p role="note">{t(target.background_semantic ? 'computerSharing.semanticOnly' : 'computerSharing.portalOnly')}</p>}
      <div className="computer-control-card__row">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(refreshTargets)}>{t('computerSharing.refresh')}</Button>
        <Button size="sm" variant="primary" disabled={busy || !target || !!target.unavailable_reason || target.selection_required && mode === 'background'}
          onClick={() => void perform(async () => {
            const next = await computerUseControlAPI.startShare(snapshot.generation, selected, mode);
            if (scope.isCurrent()) onSnapshot(next);
          })}>{t(busy ? 'computerSharing.starting' : 'computerSharing.startSharing')}</Button>
      </div>
    </>}
    {snapshot.sharing?.phase === 'shared' && snapshot.sharing.requested_mode !== 'observe' && <>
      <p>{t(snapshot.sharing.control_enabled ? 'computerSharing.controlGranted' : 'computerSharing.observeFirst')}</p>
      {!snapshot.sharing.control_enabled && !snapshot.target?.startsWith('portal:') && <Checkbox
        checked={remember} onChange={event => setRemember(event.target.checked)} disabled={busy}
        label={t('computerSharing.remember')} />}
      <Button size="sm" variant={snapshot.sharing.control_enabled ? 'outline' : 'primary'} disabled={busy}
        onClick={() => void perform(async () => {
          const next = await computerUseControlAPI.control(snapshot, !snapshot.sharing?.control_enabled, remember);
          if (scope.isCurrent()) onSnapshot(next);
        })}>{t(snapshot.sharing.control_enabled ? 'computerSharing.revokeControl' : 'computerSharing.allowControl')}</Button>
      {snapshot.sharing.remembered && <p>{t('computerSharing.remembered')}</p>}
      {snapshot.sharing.grant_note && <p role="alert">{snapshot.sharing.grant_note}</p>}
    </>}
    <details><summary>{t('computerSharing.permissions')}</summary><ComputerUsePermissions /></details>
    {error && <p role="alert">{error}</p>}
  </div>;
}
