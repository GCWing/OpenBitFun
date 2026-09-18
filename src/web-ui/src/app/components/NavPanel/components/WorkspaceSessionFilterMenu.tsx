import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw } from 'lucide-react';

import { useI18n } from '@/infrastructure/i18n';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { useSubmenuIntent } from '@/shared/utils/useSubmenuIntent';
import { Icon, Menu, MenuItem, MenuSection, MenuSeparator, Tooltip } from '@openbitfun/ui';
import {
  DEFAULT_WORKSPACE_SESSION_VIEW,
  hasWorkspaceSessionFilters,
  type WorkspaceSessionEnvironment,
  type WorkspaceSessionOrdering,
  type WorkspaceSessionShow,
  type WorkspaceSessionSource,
  type WorkspaceSessionStatus,
  type WorkspaceSessionWorktree,
  useWorkspaceSessionViewStore,
} from '../workspaceSessionView';

type Submenu = 'ordering' | 'show' | 'status' | 'worktree' | 'environment' | 'source';

interface SingleChoiceMenu<T extends string> {
  kind: 'single';
  value: T;
  options: readonly T[];
  choose: (value: T) => void;
}

interface MultiChoiceMenu<T extends string> {
  kind: 'multi';
  hidden: readonly T[];
  options: readonly T[];
  toggle: (value: T) => void;
}

type MenuDefinition = SingleChoiceMenu<string> | MultiChoiceMenu<string>;

const MAIN_MENU_WIDTH = 220;
const SUBMENU_WIDTH = 220;
const MENU_GAP = 5;
const VIEWPORT_PADDING = 8;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

const WorkspaceSessionFilterMenu: React.FC = () => {
  const { t } = useI18n('common');
  const view = useWorkspaceSessionViewStore();
  const [open, setOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<Submenu | null>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [submenuPosition, setSubmenuPosition] = useState({ top: 0, left: 0, ready: false });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const {
    closeNow: closeSubmenuNow,
    keepOpen: keepSubmenuOpen,
    openNow: openSubmenuNow,
    requestClose: requestSubmenuClose,
  } = useSubmenuIntent<Submenu>({
    activeId: activeSubmenu,
    onActiveIdChange: setActiveSubmenu,
    parentRef: menuRef,
    submenuRef,
    enabled: open,
  });

  const isCustomized = view.ordering !== DEFAULT_WORKSPACE_SESSION_VIEW.ordering
    || view.show !== DEFAULT_WORKSPACE_SESSION_VIEW.show
    || hasWorkspaceSessionFilters(view.filters);

  const updatePosition = useCallback(() => {
    const anchor = buttonRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const measuredHeight = menuRef.current?.offsetHeight ?? 422;
    const preferredRight = anchor.right + MENU_GAP;
    const canOpenRight = preferredRight + MAIN_MENU_WIDTH <= window.innerWidth - VIEWPORT_PADDING;
    setMenuPosition({
      top: clamp(anchor.top - 6, VIEWPORT_PADDING, window.innerHeight - measuredHeight - VIEWPORT_PADDING),
      left: clamp(
        canOpenRight ? preferredRight : anchor.left - MENU_GAP - MAIN_MENU_WIDTH,
        VIEWPORT_PADDING,
        window.innerWidth - MAIN_MENU_WIDTH - VIEWPORT_PADDING,
      ),
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setActiveSubmenu(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    requestAnimationFrame(updatePosition);
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target) || submenuRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && close();
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [close, open, updatePosition]);

  const definitions = useMemo<Record<Submenu, MenuDefinition>>(() => ({
    ordering: {
      kind: 'single', value: view.ordering, options: ['updated', 'status', 'created', 'name'] as WorkspaceSessionOrdering[], choose: value => view.setOrdering(value as WorkspaceSessionOrdering),
    },
    show: {
      kind: 'single', value: view.show, options: ['all', 'unread', 'attention'] as WorkspaceSessionShow[], choose: value => view.setShow(value as WorkspaceSessionShow),
    },
    status: {
      kind: 'multi', hidden: view.filters.hiddenStatuses, options: ['running', 'attention', 'error', 'completed', 'idle'] as WorkspaceSessionStatus[], toggle: value => view.toggleHiddenStatus(value as WorkspaceSessionStatus),
    },
    worktree: {
      kind: 'multi', hidden: view.filters.hiddenWorktrees, options: ['main', 'worktree'] as WorkspaceSessionWorktree[], toggle: value => view.toggleHiddenWorktree(value as WorkspaceSessionWorktree),
    },
    environment: {
      kind: 'multi', hidden: view.filters.hiddenEnvironments, options: ['local', 'remote', 'detached'] as WorkspaceSessionEnvironment[], toggle: value => view.toggleHiddenEnvironment(value as WorkspaceSessionEnvironment),
    },
    source: {
      kind: 'multi', hidden: view.filters.hiddenSources, options: ['openbitfun', 'external'] as WorkspaceSessionSource[], toggle: value => view.toggleHiddenSource(value as WorkspaceSessionSource),
    },
  }), [view]);

  const definition = activeSubmenu ? definitions[activeSubmenu] : null;

  useLayoutEffect(() => {
    if (!activeSubmenu) {
      setSubmenuPosition(position => position.ready ? { ...position, ready: false } : position);
      return;
    }

    const updateSubmenuPosition = () => {
      const trigger = menuRef.current?.querySelector<HTMLButtonElement>(
        `[data-submenu-id="${activeSubmenu}"]`,
      );
      const submenu = submenuRef.current;
      if (!trigger || !submenu) return;

      const triggerBounds = trigger.getBoundingClientRect();
      const submenuWidth = submenu.offsetWidth || SUBMENU_WIDTH;
      const submenuHeight = submenu.offsetHeight;
      const preferredLeft = triggerBounds.right + MENU_GAP;
      const left = preferredLeft + submenuWidth <= window.innerWidth - VIEWPORT_PADDING
        ? preferredLeft
        : triggerBounds.left - MENU_GAP - submenuWidth;
      setSubmenuPosition({
        top: clamp(
          triggerBounds.top,
          VIEWPORT_PADDING,
          window.innerHeight - submenuHeight - VIEWPORT_PADDING,
        ),
        left: clamp(
          left,
          VIEWPORT_PADDING,
          window.innerWidth - submenuWidth - VIEWPORT_PADDING,
        ),
        ready: true,
      });
    };

    updateSubmenuPosition();
    const frame = requestAnimationFrame(updateSubmenuPosition);
    return () => cancelAnimationFrame(frame);
  }, [activeSubmenu, menuPosition]);

  const focusSubmenuTrigger = useCallback((submenu: Submenu) => {
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>(
        `[data-submenu-id="${submenu}"]`,
      )?.focus();
    });
  }, []);

  const closeSubmenu = useCallback(() => {
    if (!activeSubmenu) return;
    const submenu = activeSubmenu;
    closeSubmenuNow();
    focusSubmenuTrigger(submenu);
  }, [activeSubmenu, closeSubmenuNow, focusSubmenuTrigger]);

  const openSubmenu = useCallback((submenu: Submenu, focusFirstItem = false) => {
    setSubmenuPosition(position => ({ ...position, ready: false }));
    openSubmenuNow(submenu);
    if (focusFirstItem) {
      requestAnimationFrame(() => {
        submenuRef.current?.querySelector<HTMLButtonElement>('[data-openbitfun-menu-item]')?.focus();
      });
    }
  }, [openSubmenuNow]);

  const row = (submenu: Submenu, value?: string, active = false) => (
    <MenuItem
      data-submenu-id={submenu}
      data-openbitfun-state={activeSubmenu === submenu ? 'open' : undefined}
      aria-haspopup="menu"
      aria-expanded={activeSubmenu === submenu}
      metadata={(
        <span className="openbitfun-nav-panel__session-filter-menu-value">
          {active ? <span className="openbitfun-nav-panel__session-filter-active-dot" aria-hidden="true" /> : null}
          {value ? t(`nav.sessions.viewMenu.${submenu}.${value}`) : null}
          <Icon name="chevron-right" size="md" aria-hidden="true" />
        </span>
      )}
      onClick={() => {
        if (activeSubmenu === submenu) closeSubmenuNow();
        else openSubmenu(submenu);
      }}
      onPointerLeave={requestSubmenuClose}
      onKeyDown={event => {
        if (event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        openSubmenu(submenu, true);
      }}
    >
      {t(`nav.sessions.viewMenu.${submenu}.label`)}
    </MenuItem>
  );

  const menu = open ? createPortal(
    <>
      <Menu
        ref={menuRef}
        className="openbitfun-nav-panel__session-filter-menu"
        style={menuPosition}
        autoFocusFirstItem
        aria-label={t('nav.sessions.viewMenu.title')}
        data-testid="nav-session-filter-menu"
      >
        {row('ordering', view.ordering)}
        {row('show')}
        <MenuSeparator />
        <MenuSection
          title={t('nav.sessions.viewMenu.filters.label')}
          actions={[{
            id: 'reset',
            label: t('nav.sessions.viewMenu.filters.reset'),
            icon: <Icon glyph={RotateCcw} />,
            onClick: () => {
              setActiveSubmenu(null);
              view.resetFilters();
            },
          }]}
        >
          {row('status', undefined, view.filters.hiddenStatuses.length > 0)}
          {row('worktree', undefined, view.filters.hiddenWorktrees.length > 0)}
          {row('environment', undefined, view.filters.hiddenEnvironments.length > 0)}
          {row('source', undefined, view.filters.hiddenSources.length > 0)}
        </MenuSection>
        <MenuSeparator />
        {view.grouping === 'grouped' ? (
          <MenuItem
            data-testid="nav-session-collapse-all"
            onClick={() => { view.requestCollapseAll(); close(); }}
          >
            {t('nav.sessions.viewMenu.collapseAll')}
          </MenuItem>
        ) : null}
        <MenuItem
          onClick={() => {
            flowChatStore.clearAllSessionUnreadCompletions();
            close();
          }}
        >
          {t('nav.sessions.viewMenu.markAllRead')}
        </MenuItem>
      </Menu>

      {activeSubmenu && definition ? (
        <Menu
          ref={submenuRef}
          className="openbitfun-nav-panel__session-filter-submenu"
          style={{
            top: submenuPosition.top,
            left: submenuPosition.left,
            visibility: submenuPosition.ready ? 'visible' : 'hidden',
          }}
          aria-label={t(`nav.sessions.viewMenu.${activeSubmenu}.label`)}
          data-testid={`nav-session-filter-${activeSubmenu}-menu`}
          onPointerEnter={keepSubmenuOpen}
          onPointerLeave={requestSubmenuClose}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            closeSubmenu();
          }}
        >
          {definition.options.map(option => {
            const selected = definition.kind === 'single'
              ? option === definition.value
              : !definition.hidden.includes(option);
            return (
              <MenuItem
                key={option}
                role={definition.kind === 'single' ? 'menuitemradio' : 'menuitemcheckbox'}
                checked={selected}
                reserveLeadingSpace
                leading={selected ? <Icon name="check-line" size="sm" /> : null}
                onClick={() => {
                  if (definition.kind === 'single') {
                    definition.choose(option);
                    close();
                  } else {
                    definition.toggle(option);
                  }
                }}
              >
                {t(`nav.sessions.viewMenu.${activeSubmenu}.${option}`)}
              </MenuItem>
            );
          })}
        </Menu>
      ) : null}
    </>,
    getAppearanceOverlayHost(),
  ) : null;

  return (
    <>
      <Tooltip content={t('nav.sessions.viewMenu.tooltip')} placement="right" followCursor disabled={open}>
        <button
          ref={buttonRef}
          type="button"
          className={`openbitfun-nav-panel__section-action${open || isCustomized ? ' is-active' : ''}`}
          data-openbitfun-action="session-filter"
          data-openbitfun-state={[open && 'open', isCustomized && 'filtered'].filter(Boolean).join(' ') || undefined}
          aria-label={t('nav.sessions.viewMenu.tooltip')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          data-testid="nav-session-filter-btn"
        >
          <Icon name="filter" size="lg" style={{ width: 13, height: 13 }} />
        </button>
      </Tooltip>
      {menu}
    </>
  );
};

export default WorkspaceSessionFilterMenu;
