import { useLayoutEffect, useRef, useState } from 'react';
import { Icon, MenuItem, MenuList } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import './SessionDeleteMenuItem.scss';

interface Props {
  sessionId: string;
  label: string;
  description: string;
  testId: string;
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
}

/** Replace the delete action with two controls in the same menu row. */
export default function SessionDeleteMenuItem(props: Props) {
  // A retained menu may be retargeted without closing. Its confirmation belongs
  // to one session and must not authorize the next row, even when returning.
  return <SessionDeleteConfirmation key={props.sessionId} {...props} />;
}

function SessionDeleteConfirmation({ sessionId, label, description, testId, disabled, onConfirm }: Props) {
  const { t } = useI18n('common');
  const [confirmation, setConfirmation] = useState<ReturnType<typeof getActiveSurfaceScope> | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useLayoutEffect(() => {
    if (confirmation) cancelRef.current?.focus();
    else if (restoreFocusRef.current) {
      deleteRef.current?.focus();
      restoreFocusRef.current = false;
    }
  }, [confirmation]);

  const cancel = () => {
    restoreFocusRef.current = true;
    setConfirmation(null);
  };

  const confirm = async () => {
    if (disabled || pendingRef.current || !confirmation) return;
    if (!confirmation.isCurrent()) {
      cancel();
      return;
    }
    pendingRef.current = true;
    setPending(true);
    try {
      await onConfirm();
    } finally {
      pendingRef.current = false;
      setPending(false);
      setConfirmation(null);
    }
  };

  if (!confirmation) return (
    <MenuItem
      ref={deleteRef}
      type="button"
      tone="danger"
      leading={<Icon name="delete" size="sm" />}
      disabled={disabled}
      title={description}
      data-testid={testId}
      data-session-id={sessionId}
      onClick={event => {
        event.stopPropagation();
        setConfirmation(getActiveSurfaceScope());
      }}
    >
      {label}
    </MenuItem>
  );

  return (
    <div
      data-openbitfun-component="sessions-section"
      data-openbitfun-part="deleteConfirmation"
    >
      <MenuList
        className="openbitfun-session-delete-menu__confirmation"
        role="group"
        aria-label={description}
        aria-busy={pending}
        data-testid={`${testId}-confirmation`}
        data-session-id={sessionId}
        onKeyDown={event => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            (event.key === 'ArrowLeft' ? cancelRef : confirmRef).current?.focus();
          }
        }}
      >
        <MenuItem
          ref={cancelRef}
          triggerClassName="openbitfun-session-delete-menu__button"
          disabled={disabled || pending}
          data-testid={`${testId}-cancel`}
          onClick={event => { event.stopPropagation(); cancel(); }}
        >
          {t('actions.cancel')}
        </MenuItem>
        <span className="openbitfun-session-delete-menu__divider" aria-hidden="true" />
        <MenuItem
          ref={confirmRef}
          triggerClassName="openbitfun-session-delete-menu__button"
          tone="danger"
          disabled={disabled || pending}
          title={description}
          data-testid={`${testId}-confirm`}
          onClick={event => { event.stopPropagation(); void confirm(); }}
        >
          {t('actions.confirm')}
        </MenuItem>
      </MenuList>
    </div>
  );
}
