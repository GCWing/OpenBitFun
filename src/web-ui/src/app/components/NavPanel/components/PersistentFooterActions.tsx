import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import React, { Suspense, useState, useCallback, useEffect, useRef } from 'react';

import { createOverlayPortal,
  Icon,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Tooltip,
  Dialog,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import { RetainedMountBoundary } from '@/shared/presence';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { activateProductAction } from '@/app/global-search/productActionActivator';
import { useToolbarModeContext } from '@/flow_chat/components/toolbar-mode/ToolbarModeContext';
import { remoteConnectAPI } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import NotificationButton from '../../TitleBar/NotificationButton';
import { RemoteConnectDisclaimer } from '../../RemoteConnectDialog/RemoteConnectDisclaimer';
import {
  getRemoteConnectDisclaimerAgreed,
  setRemoteConnectDisclaimerAgreed,
} from '../../RemoteConnectDialog/remoteConnectDisclaimerStorage';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { PeerConnectionStatus } from '@/infrastructure/peer-device/PeerConnectionStatus';
import DeviceStatusControl from './DeviceStatusControl';
import { UpdateIndicator } from '@/infrastructure/update/UpdateIndicator';
import { useHasAppUpdate } from '@/infrastructure/update/useHasAppUpdate';
import { UpdateDownloadIndicator } from '@/infrastructure/update/UpdateDownloadIndicator';
import { UpdateMenuItems } from '@/infrastructure/update/UpdateMenuItems';
import { useUpdateInstallStore } from '@/infrastructure/update/updateInstallStore';
import { useAccountIdentity } from '@/infrastructure/account-identity';
import { buildPublicFeedbackFormUrl } from '@/infrastructure/feedback/publicFeedbackForm';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { notificationService } from '@/shared/notification-system';
import { getVersionInfo } from '@/shared/utils/version';

const RemoteConnectDialog = lazyWithRecovery(() => import('../../RemoteConnectDialog'));

const PersistentFooterActions: React.FC = () => {
  const { t } = useI18n('common');
  const { enableToolbarMode } = useToolbarModeContext();
  const accountIdentity = useAccountIdentity();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [deviceOverviewOpen, setDeviceOverviewOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuPopoverRef = useRef<HTMLDivElement>(null);
  const menuLayout = useAnchoredPopoverPosition({
    open: menuOpen,
    anchorRef: menuTriggerRef,
    popoverRef: menuPopoverRef,
    preferredPlacement: 'top',
    alignment: 'end',
    gap: 6,
  });
  const hasAppUpdate = useHasAppUpdate();
  const updateVersion = useUpdateInstallStore(state => state.downloadVersion ?? state.availableUpdate?.latestVersion);
  const [showRemoteConnect, setShowRemoteConnect] = useState(false);
  const [remoteInitialGroup, setRemoteInitialGroup] = useState<'network' | 'bot' | 'account' | undefined>(undefined);
  const [showRemoteDisclaimer, setShowRemoteDisclaimer] = useState(false);
  const [hasAgreedRemoteDisclaimer, setHasAgreedRemoteDisclaimer] = useState<boolean>(
    () => getRemoteConnectDisclaimerAgreed(),
  );

  // Periodic token-expiry check. Only auto-open the dialog if the token has
  // actually expired while the app is running — not on startup. Lands on the
  // account group so the user can sign in again right away.
  useEffect(() => {
    const expiryCheck = setInterval(() => {
      remoteConnectAPI.accountTokenExpired().then((expired) => {
        if (expired) {
          setRemoteInitialGroup('account');
          setShowRemoteConnect(true);
        }
      });
    }, 60000);
    return () => clearInterval(expiryCheck);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuClosing(true);
    setTimeout(() => {
      setMenuOpen(false);
      setMenuClosing(false);
    }, 150);
  }, []);

  const toggleMenu = () => {
    if (menuOpen) {
      closeMenu();
    } else {
      setDeviceOverviewOpen(false);
      setMenuOpen(true);
    }
  };

  const handleDeviceOverviewOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen && menuOpen) {
      closeMenu();
    }
    setDeviceOverviewOpen(nextOpen);
  }, [closeMenu, menuOpen]);

  const handleOpenSettings = useCallback(() => {
    closeMenu();
    void activateProductAction('settings.open');
  }, [closeMenu]);

  const handleShowAbout = () => {
    closeMenu();
    window.dispatchEvent(new Event('nav:show-about'));
  };

  const handleOpenFeedback = useCallback(() => {
    closeMenu();
    const account = accountIdentity.status === 'signed-in' ? accountIdentity.me?.user : undefined;
    const url = buildPublicFeedbackFormUrl(import.meta.env.VITE_OPENBITFUN_FEEDBACK_FORM_URL, {
      uid: account?.accountId ?? account?.githubId,
      version: getVersionInfo().version,
      deviceInfo: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    });
    if (!url) {
      notificationService.error(t('nav.settingsMenu.feedbackUnavailable'));
      return;
    }
    void systemAPI.openExternal(url).catch(() => {
      notificationService.error(t('nav.settingsMenu.feedbackOpenFailed'));
    });
  }, [accountIdentity.me, accountIdentity.status, closeMenu, t]);

  const handleFloatingMode = () => {
    closeMenu();
    enableToolbarMode();
  };

  const handleRemoteConnect = useCallback((group?: 'account') => {
    setRemoteInitialGroup(group);
    if (hasAgreedRemoteDisclaimer || getRemoteConnectDisclaimerAgreed()) {
      setHasAgreedRemoteDisclaimer(true);
      setShowRemoteConnect(true);
      return;
    }

    setShowRemoteDisclaimer(true);
  }, [hasAgreedRemoteDisclaimer]);

  useEffect(() => {
    const handlePlaybookOpen = (event: Event) => {
      const requestedGroup = (event as CustomEvent<{ group?: 'network' | 'bot' | 'account' }>).detail?.group;
      setRemoteInitialGroup(requestedGroup);
      if (hasAgreedRemoteDisclaimer || getRemoteConnectDisclaimerAgreed()) {
        setHasAgreedRemoteDisclaimer(true);
        setShowRemoteConnect(true);
      } else {
        setShowRemoteDisclaimer(true);
      }
    };
    window.addEventListener('openbitfun:open-remote-connect', handlePlaybookOpen);
    return () => window.removeEventListener('openbitfun:open-remote-connect', handlePlaybookOpen);
  }, [hasAgreedRemoteDisclaimer]);

  const handleAgreeDisclaimer = useCallback(() => {
    setRemoteConnectDisclaimerAgreed();
    setHasAgreedRemoteDisclaimer(true);
    setShowRemoteDisclaimer(false);
    setShowRemoteConnect(true);
  }, []);

  return (
    <>
      <PeerConnectionStatus />
      <div className="openbitfun-nav-panel__footer" data-openbitfun-component="nav-panel" data-openbitfun-part="footer">
        <div className="openbitfun-nav-panel__footer-left">
          <DeviceStatusControl
            open={deviceOverviewOpen}
            onOpenChange={handleDeviceOverviewOpenChange}
            onManageDevices={handleRemoteConnect}
          />
        </div>

        <div className="openbitfun-nav-panel__footer-right">
          <UpdateDownloadIndicator />
          <div className="openbitfun-nav-panel__footer-menu-wrap">
            <Tooltip
              content={hasAppUpdate ? t('update.availableVersion', { version: updateVersion }) : t('actions.more')}
              placement="right"
              followCursor
              disabled={menuOpen}
            >
              <IconButton
                ref={menuTriggerRef}
                className={`openbitfun-nav-panel__footer-btn openbitfun-nav-panel__footer-btn--icon${menuOpen ? ' is-active' : ''}`}
                aria-label={hasAppUpdate ? t('update.moreAttention') : t('actions.more')}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={toggleMenu}
                data-testid="nav-footer-settings-item"
                data-openbitfun-component="nav-panel"
                data-openbitfun-part="settingsEntry"
                data-openbitfun-state={menuOpen ? 'open' : undefined}
                icon={<span className="openbitfun-update-indicator-anchor"><Icon name="gear" size="sm" aria-hidden="true" /><UpdateIndicator /></span>}
                size="sm"
                variant="quiet"
              />
            </Tooltip>

            {menuOpen && createOverlayPortal(
              <>
                <div
                  className="openbitfun-nav-panel__footer-backdrop"
                  onClick={closeMenu}
                />
                <Menu
                  ref={menuPopoverRef}
                  className={`openbitfun-nav-panel__footer-menu${menuClosing ? ' is-closing' : ''}`}
                  inlineSize="content"
                  aria-label={t('actions.more')}
                  data-testid="nav-settings-menu"
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return;
                    event.preventDefault();
                    closeMenu();
                    menuTriggerRef.current?.focus();
                  }}
                  style={{
                    top: `${menuLayout?.top ?? 0}px`,
                    left: `${menuLayout?.left ?? 0}px`,
                    visibility: menuLayout ? 'visible' : 'hidden',
                  }}
                >
                  <MenuItem
                    leading={<Icon name="floating-window" size="sm" aria-hidden="true" />}
                    onClick={handleFloatingMode}
                    data-testid="nav-settings-floating-item"
                  >
                    {t('nav.settingsMenu.floatingWindow')}
                  </MenuItem>
                  <NotificationButton menuItem onActivate={closeMenu} />
                  <MenuSeparator />
                  <UpdateMenuItems onCloseMenu={closeMenu} />
                  <MenuItem
                    leading={<Icon name="messages-square" size="sm" aria-hidden="true" />}
                    onClick={handleOpenFeedback}
                    data-testid="nav-settings-feedback-item"
                  >
                    {t('nav.settingsMenu.feedback')}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    leading={<Icon name="gear" size="sm" aria-hidden="true" />}
                    onClick={handleOpenSettings}
                    data-testid="nav-settings-open-item"
                  >
                    {t('nav.settingsMenu.openSettings')}
                  </MenuItem>
                  <MenuItem
                    leading={<Icon name="info" size="sm" aria-hidden="true" />}
                    onClick={handleShowAbout}
                    data-testid="nav-settings-about-item"
                  >
                    {t('nav.settingsMenu.about')}
                  </MenuItem>
                </Menu>
              </>,
              getAppearanceOverlayHost(),
              null,
              { open: !menuClosing, ownerRef: menuTriggerRef, surfaceRef: menuPopoverRef, onDismiss: closeMenu },
            )}
          </div>
        </div>
      </div>
      <RetainedMountBoundary present={showRemoteConnect}>
        <Suspense fallback={null}>
          <RemoteConnectDialog
            isOpen={showRemoteConnect}
            onClose={() => setShowRemoteConnect(false)}
            initialGroup={remoteInitialGroup}
          />
        </Suspense>
      </RetainedMountBoundary>
      <Dialog
        open={showRemoteDisclaimer}
        onOpenChange={(nextOpen) => { if (!nextOpen) setShowRemoteDisclaimer(false); }}
        size="lg"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('remoteConnect.disclaimerTitle')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <RemoteConnectDisclaimer
          agreed={hasAgreedRemoteDisclaimer}
          onClose={() => setShowRemoteDisclaimer(false)}
          onAgree={handleAgreeDisclaimer}
        />
      </Dialog>
    </>
  );
};

export default PersistentFooterActions;
