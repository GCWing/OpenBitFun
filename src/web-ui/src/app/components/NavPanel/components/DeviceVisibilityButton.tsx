import { Icon, IconButton } from '@openbitfun/ui';
import { Eye, EyeOff } from 'lucide-react';
import { useDeviceVisibilityPreferences } from '@/app/navigation/deviceVisibilityPreferences';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';

/** Both device pickers edit the same controller-local sidebar preference. */
export function DeviceVisibilityButton({ surfaceId, name, compact = false, disabled = false }: {
  surfaceId: DeviceSurfaceId;
  name: string;
  compact?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n('common');
  const visible = useDeviceVisibilityPreferences(state => state.hidden[surfaceId] !== true);
  const setVisible = useDeviceVisibilityPreferences(state => state.setVisible);
  const label = t(visible ? 'nav.devices.hideInSidebar' : 'nav.devices.showInSidebar', { name });
  return (
    <IconButton
      className={compact ? 'account-panel__device-action account-panel__device-visibility' : 'openbitfun-device-overview__visibility-control'}
      variant={compact ? 'quiet' : 'primary'}
      size={compact ? 'xs' : 'md'}
      shape="circle"
      icon={<Icon glyph={visible ? Eye : EyeOff} size={compact ? 'xs' : 'md'} />}
      aria-label={label}
      aria-pressed={visible}
      title={label}
      disabled={disabled}
      data-testid="device-sidebar-visibility"
      data-device-surface={surfaceId}
      onClick={event => {
        event.stopPropagation();
        setVisible(surfaceId, !visible);
      }}
    />
  );
}
