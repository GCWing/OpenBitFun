import { useId, useRef, useState } from 'react';
import { Wifi } from 'lucide-react';
import { Icon, IconButton, MenuPopover, Switch, Tooltip, type MenuEntry } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';

interface ModelPoolCardActionsProps {
  modelLabel: string;
  enabled: boolean;
  isTesting: boolean;
  connectionTestSupported: boolean;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
  onEnabledChange: (enabled: boolean) => void;
}

export function ModelPoolCardActions({
  modelLabel,
  enabled,
  isTesting,
  connectionTestSupported,
  onEdit,
  onTest,
  onDelete,
  onEnabledChange,
}: ModelPoolCardActionsProps) {
  const { t } = useI18n('settings/models');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const moreLabel = t('pool.moreActions', { model: modelLabel });
  const testLabel = !connectionTestSupported
    ? t('messages.testUnsupportedOnHost')
    : isTesting ? t('messages.testing') : t('actions.test');
  const menuItems: MenuEntry[] = [
    { id: 'delete', label: t('actions.delete'), icon: <Icon name="delete" size="sm" />, tone: 'danger', onSelect: onDelete },
  ];

  return (
    <div
      className="openbitfun-model-settings__pool-card-controls"
      data-openbitfun-component="model-settings"
      data-openbitfun-part="modelActions"
      data-menu-open={menuOpen || undefined}
      role="group"
      aria-label={modelLabel}
    >
      <Tooltip content={testLabel} trigger="hover-focus">
        <IconButton
          size="sm"
          variant="quiet"
          aria-label={testLabel}
          loading={isTesting}
          disabled={!connectionTestSupported}
          onClick={onTest}
          icon={<Icon glyph={Wifi} size="sm" />}
        />
      </Tooltip>
      <Tooltip content={t('actions.edit')} trigger="hover-focus">
        <IconButton
          size="sm"
          variant="quiet"
          aria-label={t('actions.edit')}
          onClick={onEdit}
          icon={<Icon name="edit" size="sm" />}
        />
      </Tooltip>
      <Tooltip content={moreLabel} trigger="hover-focus" disabled={menuOpen}>
        <IconButton
          ref={menuAnchorRef}
          size="sm"
          variant="quiet"
          aria-label={moreLabel}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => setMenuOpen(open => !open)}
          icon={<Icon name="more" size="sm" />}
        />
      </Tooltip>
      <MenuPopover
        id={menuId}
        aria-label={moreLabel}
        anchorRef={menuAnchorRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={menuItems}
        placement="bottom"
      />
      <Switch
        aria-label={t('pool.enableModel', { model: modelLabel })}
        checked={enabled}
        onChange={event => onEnabledChange(event.target.checked)}
      />
    </div>
  );
}
