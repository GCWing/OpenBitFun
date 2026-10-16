import { Button, Icon, MenuItem, MenuPopover, Tooltip, type MenuItemProps } from '@openbitfun/ui';
import { forwardRef, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';

interface MiniAppLaunchActionsProps {
  onOpenTab: () => void;
  onOpenWindow: () => void;
  disabled?: boolean;
  windowSupported: boolean;
  busy?: boolean;
  presentation?: 'buttons' | 'menu';
}

const LaunchMenuItem = forwardRef<HTMLButtonElement, MenuItemProps & { 'data-menu-id'?: string }>(function LaunchMenuItem(props, ref) {
  const { t } = useI18n('scenes/miniapp');
  return <Tooltip content={t('presentation.unsupported')} disabled={props['data-menu-id'] !== 'window' || !props.disabled}>
    <MenuItem {...props} ref={ref} />
  </Tooltip>;
});

const launchMenuParts = { item: LaunchMenuItem };

export function MiniAppLaunchActions({ onOpenTab, onOpenWindow, disabled, windowSupported, busy, presentation = 'buttons' }: MiniAppLaunchActionsProps) {
  const { t } = useI18n('scenes/miniapp');
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const open = menuOpen && !disabled && !busy;
  if (presentation === 'menu') return <>
    <Button ref={anchorRef} size="sm" variant="outline" disabled={disabled || busy}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setMenuOpen(value => !value)}
      trailingIcon={<Icon name="chevron-down" size="sm" />}>
      {t('detail.start')}
    </Button>
    <MenuPopover anchorRef={anchorRef} open={open} onClose={() => setMenuOpen(false)}
      aria-label={t('detail.start')} parts={launchMenuParts} items={[
        { id: 'tab', label: t('presentation.openTab'), onSelect: onOpenTab },
        { id: 'window', label: t('presentation.openWindow'), disabled: !windowSupported, onSelect: onOpenWindow },
      ]} />
  </>;
  return <>
    <Button size="sm" variant="outline" disabled={disabled || busy} onClick={onOpenTab}>
      {t('presentation.openTab')}
    </Button>
    <Tooltip content={t('presentation.unsupported')} disabled={windowSupported}>
      <Button size="sm" variant="outline" disabled={disabled || busy || !windowSupported} onClick={onOpenWindow}>
        {t('presentation.openWindow')}
      </Button>
    </Tooltip>
  </>;
}
