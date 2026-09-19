import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ForwardedRef,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react';
import { Loader2 } from 'lucide-react';
import { createOverlayPortal, Icon, Menu, MenuItem } from '@openbitfun/ui';

import type { AcpClientInfo } from '@/infrastructure/api/service-api/ACPClientAPI';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';

interface WorkspaceAcpSessionSubmenuProps {
  clients: readonly AcpClientInfo[];
  loading: boolean;
  onSelect: (client: AcpClientInfo) => void;
}

interface SubmenuLayout {
  left: number;
  placement: 'left' | 'right';
  top: number;
}

const SUBMENU_GAP = 5;
const SUBMENU_FALLBACK_WIDTH = 220;
const SUBMENU_FALLBACK_HEIGHT = 280;
const VIEWPORT_PADDING = 8;

const clamp = (value: number, min: number, max: number): number => (
  Math.min(Math.max(value, min), Math.max(min, max))
);

function assignRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref) {
    (ref as MutableRefObject<T | null>).current = value;
  }
}

const WorkspaceAcpSessionSubmenu = forwardRef<HTMLDivElement, WorkspaceAcpSessionSubmenuProps>(
  function WorkspaceAcpSessionSubmenu({ clients, loading, onSelect }, forwardedRef) {
    const { t } = useI18n('common');
    const [open, setOpen] = useState(false);
    const [layout, setLayout] = useState<SubmenuLayout | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const submenuRef = useRef<HTMLDivElement | null>(null);
    const focusSubmenuOnOpenRef = useRef(false);

    const setSubmenuRef = useCallback((node: HTMLDivElement | null) => {
      submenuRef.current = node;
      assignRef(forwardedRef, node);
    }, [forwardedRef]);

    const updateLayout = useCallback(() => {
      const trigger = triggerRef.current;
      const submenu = submenuRef.current;
      if (!trigger || !submenu) return;

      const triggerRect = trigger.getBoundingClientRect();
      const submenuRect = submenu.getBoundingClientRect();
      const submenuWidth = submenuRect.width
        || submenu.offsetWidth
        || submenu.scrollWidth
        || SUBMENU_FALLBACK_WIDTH;
      const submenuHeight = submenuRect.height
        || submenu.offsetHeight
        || submenu.scrollHeight
        || SUBMENU_FALLBACK_HEIGHT;
      const preferredLeft = triggerRect.right + SUBMENU_GAP;
      const opensRight = preferredLeft + submenuWidth <= window.innerWidth - VIEWPORT_PADDING;
      const nextLayout: SubmenuLayout = {
        left: clamp(
          opensRight ? preferredLeft : triggerRect.left - SUBMENU_GAP - submenuWidth,
          VIEWPORT_PADDING,
          window.innerWidth - submenuWidth - VIEWPORT_PADDING,
        ),
        placement: opensRight ? 'right' : 'left',
        top: clamp(
          triggerRect.top - 4,
          VIEWPORT_PADDING,
          window.innerHeight - submenuHeight - VIEWPORT_PADDING,
        ),
      };

      setLayout(current => current?.left === nextLayout.left
        && current.top === nextLayout.top
        && current.placement === nextLayout.placement
        ? current
        : nextLayout);
    }, []);

    useLayoutEffect(() => {
      if (!open) {
        setLayout(null);
        return;
      }

      updateLayout();
      const frame = window.requestAnimationFrame(updateLayout);
      const resizeObserver = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(updateLayout);
      if (triggerRef.current) resizeObserver?.observe(triggerRef.current);
      if (submenuRef.current) resizeObserver?.observe(submenuRef.current);
      window.addEventListener('resize', updateLayout);
      window.addEventListener('scroll', updateLayout, true);

      return () => {
        window.cancelAnimationFrame(frame);
        resizeObserver?.disconnect();
        window.removeEventListener('resize', updateLayout);
        window.removeEventListener('scroll', updateLayout, true);
      };
    }, [clients.length, loading, open, updateLayout]);

    const focusFirstSubmenuItem = useCallback(() => {
      submenuRef.current
        ?.querySelector<HTMLButtonElement>('[data-openbitfun-menu-item]:not(:disabled)')
        ?.focus();
    }, []);

    useEffect(() => {
      if (!open || !focusSubmenuOnOpenRef.current) return;
      focusSubmenuOnOpenRef.current = false;
      const frame = window.requestAnimationFrame(focusFirstSubmenuItem);
      return () => window.cancelAnimationFrame(frame);
    }, [focusFirstSubmenuItem, open]);

    useEffect(() => {
      if (!loading && clients.length === 0) setOpen(false);
    }, [clients.length, loading]);

    const openFromKeyboard = useCallback(() => {
      focusSubmenuOnOpenRef.current = true;
      if (open) {
        window.requestAnimationFrame(focusFirstSubmenuItem);
      } else {
        setOpen(true);
      }
    }, [focusFirstSubmenuItem, open]);

    const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      openFromKeyboard();
    };

    const handleSubmenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };

    if (!loading && clients.length === 0) return null;

    const label = t('nav.sessions.acpSessions');

    return (
      <>
        <MenuItem
          ref={triggerRef}
          className={`openbitfun-nav-panel__workspace-acp-menu-trigger${open ? ' is-open' : ''}`}
          leading={<Icon name="user" />}
          shortcut={<Icon name="chevron-right" size="sm" aria-hidden="true" />}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          onKeyDown={handleTriggerKeyDown}
          data-testid="nav-workspace-menu-acp-sessions"
        >
          {label}
        </MenuItem>

        {open && createOverlayPortal(
          <Menu
            ref={setSubmenuRef}
            className="openbitfun-nav-panel__workspace-item-menu-popover openbitfun-nav-panel__workspace-acp-submenu"
            aria-label={label}
            data-placement={layout?.placement}
            data-testid="nav-workspace-menu-acp-submenu"
            onKeyDown={handleSubmenuKeyDown}
            style={{
              left: `${layout?.left ?? 0}px`,
              top: `${layout?.top ?? 0}px`,
              visibility: layout ? 'visible' : 'hidden',
            }}
          >
            {loading ? (
              <MenuItem leading={<Loader2 size={13} aria-hidden="true" />} disabled>
                {t('app.loading')}
              </MenuItem>
            ) : clients.map(client => {
              const clientLabel = client.name || client.id;
              return (
                <MenuItem
                  key={client.id}
                  leading={<Icon name="user" />}
                  onClick={() => onSelect(client)}
                  data-testid="nav-workspace-menu-create-acp-session"
                  data-acp-client-id={client.id}
                >
                  {t('nav.sessions.newExternalAgentSessionShort', { agentName: clientLabel })}
                </MenuItem>
              );
            })}
          </Menu>,
          getAppearanceOverlayHost(),
        )}
      </>
    );
  },
);

export default WorkspaceAcpSessionSubmenu;
