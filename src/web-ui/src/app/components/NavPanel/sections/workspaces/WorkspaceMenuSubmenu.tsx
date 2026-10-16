import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createOverlayPortal, Icon, Menu, MenuItem, subscribeOverlayInteraction } from '@openbitfun/ui';

import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';

interface WorkspaceMenuSubmenuProps {
  label: string;
  leading: ReactNode;
  children: ReactNode;
  triggerTestId: string;
  submenuTestId: string;
  layoutRevision?: string;
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

const WorkspaceMenuSubmenu = forwardRef<HTMLDivElement, WorkspaceMenuSubmenuProps>(
  function WorkspaceMenuSubmenu({ label, leading, children, triggerTestId, submenuTestId, layoutRevision }, forwardedRef) {
    const [open, setOpen] = useState(false);
    const [layout, setLayout] = useState<SubmenuLayout | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const submenuRef = useRef<HTMLDivElement | null>(null);
    const focusSubmenuOnOpenRef = useRef(false);
    const submenuId = useId();

    const setSubmenuRef = useCallback((node: HTMLDivElement | null) => {
      submenuRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
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
    }, [layoutRevision, open, updateLayout]);

    const containsTarget = useCallback((target: Node | null) => Boolean(target
      && (triggerRef.current?.contains(target) || submenuRef.current?.contains(target))), []);

    useEffect(() => {
      if (!open) return;
      return subscribeOverlayInteraction(triggerRef, 'mousedown', event => {
        if (!containsTarget(event.target as Node | null)) setOpen(false);
      });
    }, [containsTarget, open]);

    const handleBlur = (event: FocusEvent<HTMLElement>) => {
      if (!containsTarget(event.relatedTarget)) setOpen(false);
    };

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

    const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      focusSubmenuOnOpenRef.current = true;
      if (open) window.requestAnimationFrame(focusFirstSubmenuItem);
      else setOpen(true);
    };

    const handleSubmenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };

    return (
      <>
        <MenuItem
          ref={triggerRef}
          className={`openbitfun-nav-panel__workspace-submenu-trigger${open ? ' is-open' : ''}`}
          leading={leading}
          shortcut={<Icon name="chevron-right" size="sm" aria-hidden="true" />}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? submenuId : undefined}
          onClick={() => setOpen(current => !current)}
          onKeyDown={handleTriggerKeyDown}
          onBlur={handleBlur}
          data-testid={triggerTestId}
        >
          {label}
        </MenuItem>

        {open && createOverlayPortal(
          <Menu
            ref={setSubmenuRef}
            id={submenuId}
            className="openbitfun-nav-panel__workspace-item-menu-popover openbitfun-nav-panel__workspace-submenu"
            inlineSize="content"
            aria-label={label}
            data-placement={layout?.placement}
            data-testid={submenuTestId}
            onKeyDown={handleSubmenuKeyDown}
            onBlur={handleBlur}
            style={{
              left: `${layout?.left ?? 0}px`,
              top: `${layout?.top ?? 0}px`,
              visibility: layout ? 'visible' : 'hidden',
            }}
          >
            {children}
          </Menu>,
          getAppearanceOverlayHost(),
          undefined,
          { ownerRef: triggerRef },
        )}
      </>
    );
  },
);

export default WorkspaceMenuSubmenu;
