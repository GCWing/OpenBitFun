import { subscribeOverlayInteraction, createOverlayPortal, OverflowText,
  Avatar,
  Button,
  Icon,
  Menu,
  MenuItem,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Github, Loader2, LogOut } from 'lucide-react';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';
import {
  AccountIdentityError,
  accountIdentityService,
  useAccountIdentity,
} from '@/infrastructure/account-identity';
import { useNotification } from '@/shared/notification-system';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import {
  calculateAccountIdentityMenuPosition,
  type AccountIdentityMenuPosition,
} from './marketAccountMenuPosition';
import './AccountIdentityControls.scss';

export interface AccountIdentityControlsProps {
  className?: string;
  loginOpen?: boolean;
  onLoginOpenChange?: (open: boolean) => void;
  onIdentityChanged?: () => void | Promise<void>;
}

export function AccountIdentityControls({
  className,
  loginOpen: controlledLoginOpen,
  onLoginOpenChange,
  onIdentityChanged,
}: AccountIdentityControlsProps) {
  const { t } = useI18n('scenes/miniapp');
  const notification = useNotification();
  const account = useAccountIdentity();
  const [internalLoginOpen, setInternalLoginOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<AccountIdentityMenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuPositionFrameRef = useRef<number | null>(null);
  const startedHere = useRef(false);
  const loginOpen = controlledLoginOpen ?? internalLoginOpen;

  const setLoginOpen = (open: boolean) => {
    if (controlledLoginOpen === undefined) setInternalLoginOpen(open);
    onLoginOpenChange?.(open);
  };

  const updateMenuPosition = useCallback(() => {
    if (!menuTriggerRef.current || !menuPanelRef.current) return;
    setMenuPosition(
      calculateAccountIdentityMenuPosition(
        menuTriggerRef.current.getBoundingClientRect(),
        menuPanelRef.current.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, []);

  const scheduleMenuPositionUpdate = useCallback(() => {
    if (menuPositionFrameRef.current !== null) return;
    menuPositionFrameRef.current = requestAnimationFrame(() => {
      menuPositionFrameRef.current = null;
      updateMenuPosition();
    });
  }, [updateMenuPosition]);

  useLayoutEffect(() => {
    if (!menuOpen) {
      return;
    }

    updateMenuPosition();
    window.addEventListener('resize', scheduleMenuPositionUpdate, { passive: true });
    window.addEventListener('scroll', scheduleMenuPositionUpdate, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener('resize', scheduleMenuPositionUpdate);
      window.removeEventListener('scroll', scheduleMenuPositionUpdate, { capture: true });
      if (menuPositionFrameRef.current !== null) {
        cancelAnimationFrame(menuPositionFrameRef.current);
        menuPositionFrameRef.current = null;
      }
    };
  }, [menuOpen, scheduleMenuPositionUpdate, updateMenuPosition]);

  useEffect(() => {
    let removeOverlayPointerdown0: (() => void) | undefined;
    let removeOverlayKeydown1: (() => void) | undefined;
    if (!menuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !menuPanelRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) return;
      setMenuOpen(false);
      menuTriggerRef.current?.focus();
    };
    removeOverlayPointerdown0 = subscribeOverlayInteraction(menuPanelRef, 'pointerdown', closeOnOutsideClick);
    removeOverlayKeydown1 = subscribeOverlayInteraction(menuPanelRef, 'keydown', closeOnEscape);
    return () => {
      removeOverlayPointerdown0?.();
      removeOverlayKeydown1?.();
    };
  }, [menuOpen]);

  useEffect(() => {
    if (account.me && loginOpen) setLoginOpen(false);
    // Only identity changes should close the dialog. The controlled callback is
    // intentionally excluded to avoid reopening on callback identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.me, loginOpen]);

  const closeLogin = () => {
    if (startedHere.current) accountIdentityService.cancelSignIn();
    startedHere.current = false;
    setLoginOpen(false);
  };

  const signIn = async () => {
    if (account.status === 'authorizing') {
      try { await accountIdentityService.reopenSignIn(); }
      catch (error) { notification.error(t('market.messages.authFailed', { error: String(error) })); }
      return;
    }
    startedHere.current = true;
    try {
      await accountIdentityService.signIn();
      startedHere.current = false;
      setLoginOpen(false);
      await onIdentityChanged?.();
      notification.success(t('market.messages.signedIn'));
    } catch (error) {
      if (error instanceof AccountIdentityError && error.code === 'cancelled') return;
      notification.error(error instanceof AccountIdentityError && error.code === 'expired'
        ? t('market.messages.authExpired')
        : t('market.messages.authFailed', { error: String(error) }));
    }
  };

  const signOut = async () => {
    setMenuOpen(false);
    try {
      await accountIdentityService.logout();
      await onIdentityChanged?.();
      notification.success(t('market.messages.signedOut'));
    } catch (error) {
      notification.error(t('market.messages.actionFailed', { error: String(error) }));
    }
  };

  const errorText = account.lastError
    ? account.lastError.code === 'expired'
      ? t('market.messages.authExpired')
      : t('market.messages.authFailed', { error: account.lastError.message })
    : undefined;

  return (
    <div
      className={['market-account-controls', className].filter(Boolean).join(' ')}
      data-openbitfun-component="market-account-controls"
      data-openbitfun-part="root"
      data-openbitfun-state={account.status}
    >
      {account.me ? (
        <div className="market-account-controls__menu-root" ref={menuRef}>
          <button data-overflow-trigger
            ref={menuTriggerRef}
            type="button"
            className="market-account-controls__identity-trigger"
            data-openbitfun-component="market-account-controls"
            data-openbitfun-part="identityTrigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('market.account.menuLabel', { login: account.me.email ?? account.me.user.login })}
            onClick={() => setMenuOpen(open => !open)}
          >
            <Avatar key={account.me.email ?? account.me.user.login} size="sm" src={account.me.user.avatarUrl} alt={account.me.email ?? account.me.user.login} aria-label={account.me.email ?? account.me.user.login}>
              {(account.me.email ?? account.me.user.login).trim().charAt(0).toUpperCase() || <Icon name="user" />}
            </Avatar>
            <OverflowText className="market-account-controls__identity-name">{account.me.email ?? `@${account.me.user.login}`}</OverflowText>
            <Icon name="chevron-down" size="xs" aria-hidden="true" />
          </button>
          {menuOpen && createOverlayPortal(
            <Menu
              ref={menuPanelRef}
              className="market-account-controls__menu"
              aria-label={t('market.account.menuLabel', { login: account.me.email ?? account.me.user.login })}
              style={{
                top: `${menuPosition?.top ?? 0}px`,
                left: `${menuPosition?.left ?? 0}px`,
                visibility: menuPosition ? 'visible' : 'hidden',
              }}
            >
              <div
                className="market-account-controls__profile"
                data-openbitfun-component="market-account-controls"
                data-openbitfun-part="profile"
              >
                <Avatar key={account.me.email ?? account.me.user.login} size="md" src={account.me.user.avatarUrl} alt={account.me.email ?? account.me.user.login} aria-label={account.me.email ?? account.me.user.login}>
              {(account.me.email ?? account.me.user.login).trim().charAt(0).toUpperCase() || <Icon name="user" />}
            </Avatar>
                <div>
                  <strong><OverflowText>{account.me.email ?? `@${account.me.user.login}`}</OverflowText></strong>
                  <OverflowText>{t('market.account.githubAccount')}</OverflowText>
                </div>
              </div>
              <MenuItem
                leading={<LogOut size={14} aria-hidden="true" />}
                onClick={() => void signOut()}
              >
                {t('market.signOut')}
              </MenuItem>
            </Menu>,
            getAppearanceOverlayHost(),
          )}
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={!account.resolved}
          onClick={() => setLoginOpen(true)}
        >
          {!account.resolved || account.status === 'authorizing'
            ? <Loader2 size={14} className="market-account-controls__spinner" />
            : <Github size={14} />}
          {t('market.signIn')}
        </Button>
      )}

      <Dialog
        open={loginOpen && !account.me}
        onOpenChange={(nextOpen) => { if (!nextOpen) closeLogin(); }}
        size="sm"
        closeOnPointerOutside={account.status !== 'authorizing'}
        data-testid="market-account-login-dialog"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('market.account.dialogTitle')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
        <div
          className="market-account-login"
          data-openbitfun-component="market-account-controls"
          data-openbitfun-part="login"
        >
          <div className="market-account-login__mark" aria-hidden="true">
            <Github size={28} />
          </div>
          <div className="market-account-login__copy">
            <strong>{t('market.account.dialogHeading')}</strong>
            <p>{t('market.account.dialogDescription')}</p>
          </div>
          {account.status === 'authorizing' && (
            <div
              className="market-account-login__waiting"
              role="status"
              data-openbitfun-component="market-account-controls"
              data-openbitfun-part="waiting"
            >
              <Loader2 size={16} className="market-account-controls__spinner" />
              <span>{t('market.account.waiting')}</span>
            </div>
          )}
          {errorText && account.status !== 'authorizing' && (
            <p
              className="market-account-login__error"
              role="alert"
              data-openbitfun-component="market-account-controls"
              data-openbitfun-part="error"
            >
              {errorText}
            </p>
          )}
          <div
            className="market-account-login__actions"
            data-openbitfun-component="market-account-controls"
            data-openbitfun-part="actions"
          >
            <Button variant="fill" onClick={closeLogin}>
              {t('market.account.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void signIn()}
            >
              {account.status === 'authorizing'
                ? <Loader2 size={14} className="market-account-controls__spinner" />
                : <Github size={14} />}
              {account.status === 'authorizing'
                ? t('market.account.reopen')
                : t('market.account.continue')}
            </Button>
          </div>
        </div>
              </DialogBody>
      </Dialog>
    </div>
  );
}
