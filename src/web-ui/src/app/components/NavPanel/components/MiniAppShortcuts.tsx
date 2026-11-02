import { ConfirmDialog, Icon, IconButton, NavigationPanelItem, Tooltip } from '@openbitfun/ui';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n';
import { isRemoteWorkspace } from '@/shared/types';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useMiniAppStore } from '@/app/scenes/miniapps/miniAppStore';
import { useMiniAppNavigation } from '@/app/scenes/miniapps/miniAppNavigationStore';
import { useMiniAppLaunch } from '@/app/scenes/miniapps/hooks/useMiniAppLaunch';
import { getMiniAppSceneId } from '@/app/scenes/miniapps/miniAppActivity';
import { renderMiniAppIcon } from '@/app/scenes/miniapps/utils/miniAppIcons';
import { pickLocalizedString } from '@/app/scenes/miniapps/utils/pickLocalizedString';

function MiniAppShortcutItems({ scope, pinnedAppIds, setPinned }: ReturnType<typeof useMiniAppNavigation>) {
  const { t, currentLanguage } = useI18n('scenes/miniapp');
  const { workspace } = useCurrentWorkspace();
  const apps = useMiniAppStore(state => state.apps);
  const catalogSurfaceId = useMiniAppStore(state => state.catalogSurfaceId);
  const activeTabId = useSceneStore(state => state.activeTabId);
  const launch = useMiniAppLaunch();
  const shortcuts = catalogSurfaceId === scope.surfaceId
    ? pinnedAppIds.flatMap(id => apps.find(app => app.id === id) ?? [])
    : [];

  return <>
    {shortcuts.map(app => {
      const name = pickLocalizedString(app, currentLanguage, 'name');
      const selected = activeTabId === getMiniAppSceneId(app.id);
      const workspaceUnsupported = Boolean(workspace && isRemoteWorkspace(workspace)
        && [...(app.permissions.fs?.read ?? []), ...(app.permissions.fs?.write ?? [])].includes('{workspace}'));
      const removeLabel = t('navigation.removeApp', { name });
      return <Tooltip key={app.id} content={workspaceUnsupported ? t('market.detail.remoteWorkspaceUnsupported') : name}
        placement="right" followCursor>
        <NavigationPanelItem
          className={`openbitfun-nav-panel__top-action-item openbitfun-nav-panel__top-action-item--root openbitfun-nav-panel__miniapp-shortcut${selected ? ' is-active' : ''}`}
          triggerClassName={`openbitfun-nav-panel__top-action-btn${selected ? ' is-active' : ''}`}
          data-openbitfun-component="nav-panel"
          data-openbitfun-part="topAction"
          data-openbitfun-state={selected ? 'active' : ''}
          data-testid="nav-miniapp-shortcut"
          data-miniapp-id={app.id}
          aria-label={name}
          selected={selected}
          disabled={workspaceUnsupported || launch.busyAppIds.includes(app.id)}
          onClick={() => void launch.openApp(app.id)}
          leading={<span className="openbitfun-nav-panel__top-action-icon-slot">{renderMiniAppIcon(app.icon || 'box', 'sm')}</span>}
          actionContent={<Tooltip content={removeLabel}>
            <IconButton className="openbitfun-nav-panel__miniapp-shortcut-remove" size="xs" variant="quiet" aria-label={removeLabel}
              icon={<Icon name="xmark" size="xs" />} onClick={() => setPinned(app.id, false)} />
          </Tooltip>}
        >
          {name}
        </NavigationPanelItem>
      </Tooltip>;
    })}
    <ConfirmDialog
      open={Boolean(launch.transfer)}
      onOpenChange={open => { if (!open) launch.cancelTransfer(); }}
      title={t('presentation.openTab')}
      message={t('presentation.transferWarning')}
      confirmText={t('presentation.openTab')}
      cancelText={t('confirmDelete.cancel')}
      onConfirm={() => void launch.confirmTransfer()}
    />
  </>;
}

export default function MiniAppShortcuts() {
  const navigation = useMiniAppNavigation();
  return <MiniAppShortcutItems key={navigation.scope.epoch} {...navigation} />;
}
