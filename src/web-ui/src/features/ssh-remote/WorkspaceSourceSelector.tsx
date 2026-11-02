import { useEffect, useId, type ReactNode } from 'react';
import { Button, OverflowText, SegmentedControl } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { DeviceSystemGlyph } from '@/app/components/NavPanel/components/DeviceSystemGlyph';
import { useDeviceDirectory, resolveDeviceNameFrom } from '@/infrastructure/account/deviceDirectory';
import {
  workspaceSourceCoordinates, workspaceSourceFor,
  type WorkspaceEnvironment, type WorkspaceLocation, type WorkspaceSource,
} from './workspaceSource';
import './WorkspaceSourceSelector.scss';
import { useWslSupport } from './useWslSupport';

interface WorkspaceSourceSelectorProps {
  value: WorkspaceSource;
  onValueChange?: (source: WorkspaceSource) => void;
  disabled?: boolean;
  /** Connection-only surfaces cannot open the host's ordinary directory picker. */
  allowHostDirectory?: boolean;
  locationOptions?: ReactNode;
  showCurrentDevice?: boolean;
  environmentOptions?: ReactNode;
  locationActions?: ReactNode;
  environmentActions?: ReactNode;
  showEnvironment?: boolean;
  onWslSupportChange?: (supported: boolean) => void;
}

export function WorkspaceSourceSelector({
  value, onValueChange, disabled, allowHostDirectory = true, locationOptions, environmentOptions, locationActions, environmentActions, showEnvironment = true, showCurrentDevice = true, onWslSupportChange,
}: WorkspaceSourceSelectorProps) {
  const { t } = useI18n('common');
  const peer = usePeerDeviceModeOptional();
  const directory = useDeviceDirectory();
  const locationId = useId();
  const environmentId = useId();
  const { location, environment } = workspaceSourceCoordinates(value);
  const wsl = useWslSupport(location === 'current' && showEnvironment);
  const wslSupported = wsl.status === 'supported';
  const showWslHint = location === 'current' && (wsl.status === 'checking' || wsl.status === 'unavailable');
  useEffect(() => { onWslSupportChange?.(wslSupported); }, [onWslSupportChange, wslSupported]);
  const wslHintId = useId();
  const peerActive = peer?.peerMode.active === true;
  const deviceId = peer?.peerMode.active ? peer.peerMode.deviceId : undefined;
  const metadata = directory.devices.find(device => device.device_id === deviceId);
  const fallbackName = peer?.peerMode.active ? peer.peerMode.deviceName : '';
  const deviceName = deviceId ? resolveDeviceNameFrom(directory.devices, deviceId, fallbackName) : fallbackName;
  const deviceKind = metadata?.device_kind;
  const deviceOs = metadata?.device_os;
  return <div className="workspace-source-selector" data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceSelector">
    <div className="workspace-source-selector__field" data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceField">
      <div className="workspace-source-selector__heading">
      <span id={locationId} className="workspace-source-selector__label" data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceLabel">{t('workspaceSource.location')}</span>
      <SegmentedControl className="workspace-source-selector__control" size="sm" distribution="content" aria-labelledby={locationId}
        value={location} disabled={disabled}
        options={[
          { value: 'current', label: t('workspaceSource.currentHost') },
          { value: 'other', label: t('workspaceSource.otherHost') },
        ]}
        onValueChange={value => {
          const next = value as WorkspaceLocation;
          const nextEnvironment = next === 'other' && environment === 'wsl' ? 'system'
            : next === 'current' && environment === 'system' && !allowHostDirectory ? 'container' : environment;
          onValueChange?.(workspaceSourceFor(next, nextEnvironment));
        }} />
      {locationActions && <div className="workspace-source-selector__actions">{locationActions}</div>}
      </div>
      {location === 'current' && peerActive && showCurrentDevice && <div className="workspace-source-selector__device" role="status"
        data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceHint">
        {deviceName && <DeviceSystemGlyph size="sm" device={{ kind: deviceKind === 'cli' ? 'execution-host' : 'desktop', name: deviceName, os: deviceOs ?? undefined, hostKind: deviceKind === 'cli' ? 'cli' : 'desktop' }} />}
        <OverflowText>{deviceName}</OverflowText>
      </div>}
      {locationOptions}
    </div>
    {showEnvironment && <div className="workspace-source-selector__field" data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceField">
      <div className="workspace-source-selector__heading">
      <span id={environmentId} className="workspace-source-selector__label" data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceLabel">{t('workspaceSource.environment')}</span>
      <SegmentedControl className="workspace-source-selector__control" size="sm" distribution="content" aria-labelledby={environmentId}
        value={environment} disabled={disabled} aria-describedby={showWslHint ? wslHintId : undefined}
        options={[
          { value: 'system', label: t('workspaceSource.system'), disabled: location === 'current' && !allowHostDirectory },
          { value: 'container', label: t('workspaceSource.container') },
          { value: 'wsl', label: t('workspaceSource.wsl'), disabled: location === 'other' || !wslSupported },
        ]}
        onValueChange={value => onValueChange?.(workspaceSourceFor(location, value as WorkspaceEnvironment))} />
      {environmentActions && <div className="workspace-source-selector__actions">{environmentActions}</div>}
      </div>
      {showWslHint && <div id={wslHintId} className="workspace-source-selector__device" role="status">
        <span>{t(wsl.status === 'checking' ? 'workspaceSource.checkingWsl'
          : 'ssh.remote.wslDiscoveryFailed')}</span>
        {wsl.status === 'unavailable' && <Button size="sm" variant="quiet" disabled={disabled} onClick={wsl.retry}>{t('workspaceSource.refreshOptions')}</Button>}
      </div>}
      {environmentOptions}
    </div>}
  </div>;
}
