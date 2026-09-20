import { useDeviceDirectory, resolveDeviceName } from '@/infrastructure/account/deviceDirectory';
import React, {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FolderGit2, Laptop, Loader2, MonitorSmartphone, Server } from 'lucide-react';

import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Icon, Menu, MenuItem, MenuSection, MenuSeparator, Tooltip } from '@openbitfun/ui';
import { SSHConnectionDialog } from '@/features/ssh-remote/SSHConnectionDialog';
import { useAccountLoginState } from '@/infrastructure/account/useAccountLoginState';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { DispatchInstallDialog } from './DispatchInstallDialog';
import type {
  DispatchSelection,
  DispatchTarget,
  DispatchTargetOption,
} from './types';
import { useDispatchTargets } from './useDispatchTargets';
import './DispatchTargetPicker.scss';

interface DispatchTargetPickerProps {
  target: DispatchTarget;
  sourceWorkspacePath?: string;
  sourceWorkspaceId?: string;
  locked: boolean;
  disabled?: boolean;
  localWorktreeControl?: {
    enabled: boolean;
    locked: boolean;
    label: string;
    description: string;
    onChange: (enabled: boolean) => void;
  };
  onSelectLocal?: () => void;
  onSelectTarget: (selection: DispatchSelection) => void;
}

const RemoteConnectDialog = lazy(
  () => import('@/app/components/RemoteConnectDialog'),
);

export const DispatchTargetPicker: React.FC<DispatchTargetPickerProps> = ({
  target,
  sourceWorkspacePath,
  sourceWorkspaceId,
  locked,
  disabled = false,
  localWorktreeControl,
  onSelectLocal,
  onSelectTarget,
}) => {
  useDeviceDirectory();
  const { t } = useI18n('flow-chat');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [configureTarget, setConfigureTarget] = useState<DispatchTargetOption | null>(null);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const { loggedIn } = useAccountLoginState();
  const { targets, loading, error, refresh } = useDispatchTargets(open);
  const menuLayout = useAnchoredPopoverPosition({
    open,
    anchorRef: triggerRef,
    popoverRef: menuRef,
    preferredPlacement: 'top',
    alignment: 'end',
    gap: 7,
    layoutRevision: `${targets.length}:${loading}:${error ?? ''}`,
  });

  const localDisplayLabel = localWorktreeControl?.enabled
    ? localWorktreeControl.label
    : t('chatInput.dispatch.local');
  const displayLabel = target.kind === 'local'
    ? localDisplayLabel
    : target.kind === 'device' ? resolveDeviceName(target.deviceId, target.displayName) : target.displayName;
  const tooltip = locked
    ? t('chatInput.dispatch.locked', { target: displayLabel })
    : t('chatInput.dispatch.current', { target: displayLabel });

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const targetNode = event.target as Node;
      if (
        !rootRef.current?.contains(targetNode)
        && !menuRef.current?.contains(targetNode)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const removeOverlayPointerdown0 = subscribeOverlayInteraction(menuRef, 'pointerdown', handlePointerDown);
    const removeOverlayKeydown1 = subscribeOverlayInteraction(menuRef, 'keydown', handleKeyDown);
    return () => {
      removeOverlayPointerdown0?.();
      removeOverlayKeydown1?.();
    };
  }, [open]);

  const sshTargets = useMemo(
    () => targets.filter(
      (item): item is DispatchTargetOption & { kind: 'ssh'; connectionId: string } =>
        item.kind === 'ssh' && !!item.connectionId,
    ),
    [targets],
  );
  const deviceTargets = useMemo(
    () => targets.filter(
      (item): item is DispatchTargetOption & { kind: 'device'; deviceId: string } =>
        item.kind === 'device' && !!item.deviceId,
    ),
    [targets],
  );

  const selectLocalMode = (worktreeEnabled: boolean) => {
    setOpen(false);
    onSelectLocal?.();
    if (
      localWorktreeControl
      && localWorktreeControl.enabled !== worktreeEnabled
    ) {
      localWorktreeControl.onChange(worktreeEnabled);
    }
  };

  const localDirectorySelected =
    target.kind === 'local' && !localWorktreeControl?.enabled;
  const localWorktreeSelected =
    target.kind === 'local' && !!localWorktreeControl?.enabled;

  const menu = open ? (
    <Menu
      ref={menuRef}
      className="dispatch-target-picker__menu"
      data-openbitfun-component="dispatch-target-picker"
      data-openbitfun-part="menu"
      data-openbitfun-placement={menuLayout?.placement ?? 'top'}
      style={{
        top: `${menuLayout?.top ?? 0}px`,
        left: `${menuLayout?.left ?? 0}px`,
        visibility: menuLayout ? 'visible' : 'hidden',
      }}
      aria-label={t('chatInput.dispatch.menuLabel')}
      data-testid="dispatch-target-menu"
      autoFocusFirstItem
    >
      <MenuSection
        className="dispatch-target-picker__local-section"
        title={t('chatInput.dispatch.localSection')}
      >
        <Tooltip content={t('chatInput.dispatch.localDescription')} placement="right">
          <MenuItem data-overflow-trigger
            role="menuitemradio"
            checked={localDirectorySelected}
            className="dispatch-target-picker__option-row"
            data-openbitfun-component="dispatch-target-picker"
            data-openbitfun-part="option"
            data-testid="dispatch-target-local-option"
            disabled={localWorktreeControl?.locked}
            leading={<Laptop size={15} aria-hidden />}
            metadata={localDirectorySelected ? <Icon name="check-line" size="sm" aria-hidden /> : null}
            onClick={() => selectLocalMode(false)}
          >
            <span className="dispatch-target-picker__option-copy">
              <strong><OverflowText>{t('chatInput.dispatch.local')}</OverflowText></strong>
            </span>
          </MenuItem>
        </Tooltip>
        {localWorktreeControl ? (
          <Tooltip content={localWorktreeControl.description} placement="right">
            <MenuItem data-overflow-trigger
              role="menuitemradio"
              checked={localWorktreeSelected}
              className="dispatch-target-picker__option-row"
              data-openbitfun-component="dispatch-target-picker"
              data-openbitfun-part="option"
              data-testid="dispatch-target-new-worktree-option"
              disabled={localWorktreeControl.locked}
              leading={<FolderGit2 size={15} aria-hidden />}
              metadata={localWorktreeSelected ? <Icon name="check-line" size="sm" aria-hidden /> : null}
              onClick={() => selectLocalMode(true)}
            >
              <span className="dispatch-target-picker__option-copy">
                <strong><OverflowText>{localWorktreeControl.label}</OverflowText></strong>
              </span>
            </MenuItem>
          </Tooltip>
        ) : null}
      </MenuSection>

      <MenuSeparator />
      <MenuSection title={t('chatInput.dispatch.deviceSection')}>
        {!loggedIn ? (
          <MenuItem
            leading={<MonitorSmartphone size={14} aria-hidden />}
            onClick={() => {
              setOpen(false);
              setAccountDialogOpen(true);
            }}
          >
            {t('chatInput.dispatch.signInDevices')}
          </MenuItem>
        ) : null}
        {loggedIn && !loading && deviceTargets.length === 0 ? (
          <div className="dispatch-target-picker__status">
            {t('chatInput.dispatch.noDeviceTargets')}
          </div>
        ) : null}
        {deviceTargets.map(option => {
          const selected = target.kind === 'device' && target.deviceId === option.deviceId;
          const online = option.online !== false;
          // A confirmed-incompatible device stays listed so the reason is legible,
          // but it is never offered as a selectable dispatch target.
          const incompatible = option.incompatible === true;
          return (
            <MenuItem data-overflow-trigger
              key={option.deviceId}
              role="menuitemradio"
              checked={selected}
              className="dispatch-target-picker__option-row"
              disabled={!online || incompatible}
              leading={<MonitorSmartphone size={15} aria-hidden />}
              metadata={selected ? <Icon name="check-line" size="sm" aria-hidden /> : null}
              onClick={() => {
                if (incompatible) return;
                setOpen(false);
                setConfigureTarget(option);
              }}
            >
              <span className="dispatch-target-picker__option-copy">
                <strong><OverflowText>{option.displayName}</OverflowText></strong>
                <small><OverflowText>
                  {incompatible
                    ? t('chatInput.dispatch.deviceIncompatible')
                    : online
                      ? t('chatInput.dispatch.deviceDescription')
                      : t('chatInput.dispatch.deviceOffline')}
                </OverflowText></small>
              </span>
            </MenuItem>
          );
        })}
      </MenuSection>

      <MenuSeparator />
      <MenuSection title={t('chatInput.dispatch.sshSection')}>
        {loading ? (
          <div className="dispatch-target-picker__status">
            <Loader2 size={14} className="dispatch-target-picker__spin" />
            {t('chatInput.dispatch.loading')}
          </div>
        ) : null}
        {!loading && error ? (
          <MenuItem
            leading={<Icon name="refresh" size="sm" aria-hidden />}
            onClick={() => void refresh()}
          >
            {t('chatInput.dispatch.targetLoadFailed')}
          </MenuItem>
        ) : null}
        {!loading && !error && sshTargets.length === 0 ? (
          <div className="dispatch-target-picker__status">
            {t('chatInput.dispatch.noSshTargets')}
          </div>
        ) : null}
        {sshTargets.map(option => {
          const selected = target.kind === 'ssh' && target.connectionId === option.connectionId;
          return (
            <MenuItem data-overflow-trigger
              key={option.connectionId}
              role="menuitemradio"
              checked={selected}
              className="dispatch-target-picker__option-row"
              leading={<Server size={15} aria-hidden />}
              metadata={selected ? <Icon name="check-line" size="sm" aria-hidden /> : null}
              onClick={() => {
                setOpen(false);
                setConfigureTarget(option);
              }}
            >
              <span className="dispatch-target-picker__option-copy">
                <strong><OverflowText>{option.displayName}</OverflowText></strong>
                <small><OverflowText>{option.description || t('chatInput.dispatch.sshDescription')}</OverflowText></small>
              </span>
            </MenuItem>
          );
        })}
      </MenuSection>

      <MenuSeparator />
      <MenuItem
        leading={<Icon name="plus" size="sm" aria-hidden />}
        onClick={() => {
          setOpen(false);
          setSshDialogOpen(true);
        }}
      >
        {t('chatInput.dispatch.addSsh')}
      </MenuItem>
    </Menu>
  ) : null;

  return (
    <>
      <div
        ref={rootRef}
        className="dispatch-target-picker"
        data-openbitfun-component="dispatch-target-picker"
        data-openbitfun-part="root"
      >
        <Tooltip content={tooltip} placement="top">
          <button data-overflow-trigger
            ref={triggerRef}
            type="button"
            className="dispatch-target-picker__trigger"
            data-openbitfun-component="dispatch-target-picker"
            data-openbitfun-part="trigger"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={tooltip}
            disabled={disabled || locked}
            data-testid="chat-input-dispatch-trigger"
            data-dispatch-kind={target.kind}
            onClick={event => {
              event.stopPropagation();
              setOpen(current => !current);
            }}
          >
            {target.kind === 'local'
              ? localWorktreeControl?.enabled
                ? <FolderGit2 size={12} />
                : <Laptop size={12} />
              : target.kind === 'device'
                ? <MonitorSmartphone size={12} />
                : <Server size={12} />}
            <span><OverflowText>{displayLabel}</OverflowText></span>
          </button>
        </Tooltip>
        {menu && createOverlayPortal(menu, getAppearanceOverlayHost())}
      </div>

      <DispatchInstallDialog
        open={!!configureTarget}
        target={configureTarget}
        sourceWorkspaceId={sourceWorkspaceId} sourceWorkspacePath={sourceWorkspacePath}
        onClose={() => setConfigureTarget(null)}
        onReady={selection => {
          setConfigureTarget(null);
          onSelectTarget(selection);
        }}
      />

      <SSHConnectionDialog
        open={sshDialogOpen}
        onClose={() => {
          setSshDialogOpen(false);
          void refresh();
        }}
      />
      {accountDialogOpen ? (
        <Suspense fallback={null}>
          <RemoteConnectDialog
            isOpen={accountDialogOpen}
            initialGroup="account"
            onClose={() => {
              setAccountDialogOpen(false);
              void refresh();
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
};
