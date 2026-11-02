import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import { useI18n } from '@/infrastructure/i18n';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { useSubmenuIntent } from '@/shared/utils/useSubmenuIntent';
import { EXTERNAL_SESSION_NAMES, type ExternalSessionEcosystem } from '@/shared/types/external-session';
import { subscribeOverlayInteraction, createOverlayPortal, Icon, IconButton, Menu, MenuItem, MenuSection, MenuSeparator, Tooltip } from '@openbitfun/ui';
import {
  DEFAULT_WORKSPACE_SESSION_VIEW,
  hasWorkspaceSessionFilters,
  sessionSourceAgentLabel,
  type WorkspaceSessionEnvironment,
  type WorkspaceSessionFilterKey,
  type WorkspaceSessionOrdering,
  type WorkspaceSessionShow,
  type WorkspaceSessionSource,
  type WorkspaceSessionSourceAgent,
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
  filter: WorkspaceSessionFilterKey;
  hidden: readonly T[];
  options: readonly T[];
  setHidden: (values: T[]) => void;
  selectAll: () => void;
}

type MenuDefinition = SingleChoiceMenu<string> | MultiChoiceMenu<string>;

const MAIN_MENU_WIDTH = 220;
const SUBMENU_WIDTH = 220;
const MENU_GAP = 5;
const VIEWPORT_PADDING = 8;
const SOURCE_AGENTS: readonly WorkspaceSessionSourceAgent[] = [
  'all', 'openbitfun', ...Object.keys(EXTERNAL_SESSION_NAMES) as ExternalSessionEcosystem[],
];
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
    || view.sourceAgent !== DEFAULT_WORKSPACE_SESSION_VIEW.sourceAgent
    || hasWorkspaceSessionFilters(view.filters);

  const updatePosition = useCallback(() => {
    const anchor = buttonRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const measuredHeight = menuRef.current?.offsetHeight ?? 422;
    const menuWidth = menuRef.current?.offsetWidth || MAIN_MENU_WIDTH;
    const preferredRight = anchor.right + MENU_GAP;
    const canOpenRight = preferredRight + menuWidth <= window.innerWidth - VIEWPORT_PADDING;
    setMenuPosition({
      top: clamp(anchor.top - 6, VIEWPORT_PADDING, window.innerHeight - measuredHeight - VIEWPORT_PADDING),
      left: clamp(
        canOpenRight ? preferredRight : anchor.left - MENU_GAP - menuWidth,
        VIEWPORT_PADDING,
        window.innerWidth - menuWidth - VIEWPORT_PADDING,
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
    const removeOverlayMousedown0 = subscribeOverlayInteraction(menuRef, 'mousedown', handlePointerDown);
    const removeOverlayKeydown1 = subscribeOverlayInteraction(menuRef, 'keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      removeOverlayMousedown0?.();
      removeOverlayKeydown1?.();
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
      filter: 'hiddenStatuses',
      kind: 'multi', hidden: view.filters.hiddenStatuses, options: ['running', 'attention', 'error', 'completed', 'idle'] as WorkspaceSessionStatus[], setHidden: values => view.setHiddenFilterOptions('hiddenStatuses', values as WorkspaceSessionStatus[]),
      selectAll: () => view.selectAllFilterOptions('hiddenStatuses'),
    },
    worktree: {
      filter: 'hiddenWorktrees',
      kind: 'multi', hidden: view.filters.hiddenWorktrees, options: ['main', 'worktree'] as WorkspaceSessionWorktree[], setHidden: values => view.setHiddenFilterOptions('hiddenWorktrees', values as WorkspaceSessionWorktree[]),
      selectAll: () => view.selectAllFilterOptions('hiddenWorktrees'),
    },
    environment: {
      filter: 'hiddenEnvironments',
      kind: 'multi', hidden: view.filters.hiddenEnvironments, options: ['local', 'remote', 'detached'] as WorkspaceSessionEnvironment[], setHidden: values => view.setHiddenFilterOptions('hiddenEnvironments', values as WorkspaceSessionEnvironment[]),
      selectAll: () => view.selectAllFilterOptions('hiddenEnvironments'),
    },
    source: {
      filter: 'hiddenSources',
      kind: 'multi', hidden: view.filters.hiddenSources, options: ['openbitfun', 'external'] as WorkspaceSessionSource[], setHidden: values => view.setHiddenFilterOptions('hiddenSources', values as WorkspaceSessionSource[]),
      selectAll: () => view.selectAllFilterOptions('hiddenSources'),
    },
  }), [view]);

  const definition = activeSubmenu ? definitions[activeSubmenu] : null;
  const isSelectAllActive = definition?.kind === 'multi'
    && view.explicitAllFilters.includes(definition.filter) && definition.hidden.length === 0
    && (activeSubmenu !== 'source' || view.sourceAgent === 'all');

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
          <Icon name="chevron-right" size="sm" aria-hidden="true" />
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

  const menu = open ? createOverlayPortal(
    <>
      <Menu
        ref={menuRef}
        className="openbitfun-nav-panel__session-filter-menu"
        inlineSize="content"
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
            icon: <Icon glyph={RotateCcw} size="sm" />,
            onClick: () => {
              setActiveSubmenu(null);
              view.resetFilters();
            },
          }]}
        >
          {row('status', undefined, view.filters.hiddenStatuses.length > 0)}
          {row('worktree', undefined, view.filters.hiddenWorktrees.length > 0)}
          {row('environment', undefined, view.filters.hiddenEnvironments.length > 0)}
          {row('source', undefined, view.filters.hiddenSources.length > 0 || view.sourceAgent !== 'all')}
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
          inlineSize="content"
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
          {definition.kind === 'multi' ? (
            <>
              <MenuItem
                role="menuitemradio"
                checked={isSelectAllActive}
                reserveLeadingSpace
                leading={isSelectAllActive ? <Icon name="check-line" size="sm" /> : null}
                data-testid={`nav-session-filter-${activeSubmenu}-select-all`}
                onClick={definition.selectAll}
              >
                {t('actions.selectAll')}
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          {definition.options.map(option => {
            const selected = definition.kind === 'single'
              ? option === definition.value
              : !isSelectAllActive && !definition.hidden.includes(option);
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
                    definition.setHidden(isSelectAllActive
                      ? definition.options.filter(value => value !== option)
                      : definition.hidden.includes(option)
                        ? definition.hidden.filter(value => value !== option)
                        : [...definition.hidden, option]);
                  }
                }}
              >
                {t(`nav.sessions.viewMenu.${activeSubmenu}.${option}`)}
              </MenuItem>
            );
          })}
          {activeSubmenu === 'source' ? (
            <>
              <MenuSeparator />
              <MenuSection title={t('nav.sessions.sourceAgentFilter')}>
                {SOURCE_AGENTS.map(source => (
                  <MenuItem
                    key={source}
                    role="menuitemradio"
                    checked={!isSelectAllActive && view.sourceAgent === source}
                    reserveLeadingSpace
                    leading={!isSelectAllActive && view.sourceAgent === source ? <Icon name="check-line" size="sm" /> : null}
                    data-testid={`nav-session-source-${source}`}
                    onClick={() => {
                      view.setSourceAgent(source);
                      close();
                    }}
                  >
                    {source === 'all' ? t('nav.sessions.allSourceAgents') : sessionSourceAgentLabel(source)}
                  </MenuItem>
                ))}
              </MenuSection>
            </>
          ) : null}
        </Menu>
      ) : null}
    </>,
    getAppearanceOverlayHost(),
  ) : null;

  return (
    <>
      <Tooltip content={t('nav.sessions.viewMenu.tooltip')} placement="right" followCursor disabled={open}>
        <IconButton
          ref={buttonRef}
          className={`openbitfun-nav-panel__section-action${open || isCustomized ? ' is-active' : ''}`}
          data-openbitfun-action="session-filter"
          data-openbitfun-state={[open && 'open', isCustomized && 'filtered'].filter(Boolean).join(' ') || undefined}
          aria-label={t('nav.sessions.viewMenu.tooltip')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          data-testid="nav-session-filter-btn"
          icon={<Icon name="filter" size="sm" />}
          size="xs"
          variant="quiet"
        />
      </Tooltip>
      {menu}
    </>
  );
};

export default WorkspaceSessionFilterMenu;
