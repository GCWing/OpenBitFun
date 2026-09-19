import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { createOverlayPortal, OverflowText, Icon, Menu, MenuItem, MenuSeparator } from '@openbitfun/ui';

import {
  SYSTEM_APPEARANCE_ID,
  useAppearance,
  type AppearanceCatalogEntry,
  type AppearanceSelectionId,
} from '@/infrastructure/appearance';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useNotification } from '@/shared/notification-system';

interface AppearanceQuickSwitchMenuItemProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseParentMenu: () => void;
  onOpenAppearanceSettings: () => void;
}

interface SubmenuLayout {
  left: number;
  placement: 'left' | 'right';
  top: number;
}

const SUBMENU_GAP = 5;
const SUBMENU_FALLBACK_WIDTH = 228;
const SUBMENU_FALLBACK_HEIGHT = 360;
const VIEWPORT_PADDING = 8;

const clamp = (value: number, min: number, max: number): number => (
  Math.min(Math.max(value, min), Math.max(min, max))
);

function useSubmenuLayout(
  open: boolean,
  anchorRef: RefObject<HTMLButtonElement | null>,
  submenuRef: RefObject<HTMLDivElement | null>,
  layoutRevision: unknown,
): SubmenuLayout | null {
  const [layout, setLayout] = useState<SubmenuLayout | null>(null);

  const updateLayout = useCallback(() => {
    const anchor = anchorRef.current;
    const submenu = submenuRef.current;
    if (!anchor || !submenu) return;

    const anchorRect = anchor.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();
    const submenuWidth = submenuRect.width
      || submenu.offsetWidth
      || submenu.scrollWidth
      || SUBMENU_FALLBACK_WIDTH;
    const submenuHeight = submenuRect.height
      || submenu.offsetHeight
      || submenu.scrollHeight
      || SUBMENU_FALLBACK_HEIGHT;
    const preferredLeft = anchorRect.right + SUBMENU_GAP;
    const opensRight = preferredLeft + submenuWidth <= window.innerWidth - VIEWPORT_PADDING;
    const nextLayout: SubmenuLayout = {
      left: clamp(
        opensRight ? preferredLeft : anchorRect.left - SUBMENU_GAP - submenuWidth,
        VIEWPORT_PADDING,
        window.innerWidth - submenuWidth - VIEWPORT_PADDING,
      ),
      placement: opensRight ? 'right' : 'left',
      top: clamp(
        anchorRect.top - 4,
        VIEWPORT_PADDING,
        window.innerHeight - submenuHeight - VIEWPORT_PADDING,
      ),
    };

    setLayout(current => current?.left === nextLayout.left
      && current.top === nextLayout.top
      && current.placement === nextLayout.placement
      ? current
      : nextLayout);
  }, [anchorRef, submenuRef]);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null);
      return;
    }

    updateLayout();
    window.addEventListener('resize', updateLayout);
    window.addEventListener('scroll', updateLayout, true);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateLayout);
    if (anchorRef.current) resizeObserver?.observe(anchorRef.current);
    if (submenuRef.current) resizeObserver?.observe(submenuRef.current);

    return () => {
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('scroll', updateLayout, true);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, open, submenuRef, updateLayout]);

  useLayoutEffect(() => {
    if (open) updateLayout();
  }, [layoutRevision, open, updateLayout]);

  return layout;
}

const AppearanceQuickSwitchMenuItem: React.FC<AppearanceQuickSwitchMenuItemProps> = ({
  open,
  onOpenChange,
  onCloseParentMenu,
  onOpenAppearanceSettings,
}) => {
  const { t } = useI18n('common');
  const { t: tApplication } = useI18n('settings/application');
  const { error: notifyError } = useNotification();
  const {
    appearances,
    current,
    initialized,
    select,
    selectedAppearanceId,
    status,
  } = useAppearance();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const focusSubmenuOnOpenRef = useRef(false);

  const getAppearanceDisplayName = useCallback((appearance: AppearanceCatalogEntry) => {
    if (appearance.source !== 'builtin') return appearance.name;
    const presetId = appearance.id.replace(/^builtin\./, '');
    return tApplication(`appearance.presets.${presetId}.name`, {
      defaultValue: appearance.name,
    });
  }, [tApplication]);

  const selectedDisplayName = useMemo(() => {
    if (selectedAppearanceId === SYSTEM_APPEARANCE_ID) {
      return tApplication('appearance.systemAppearance');
    }
    const selected = appearances.find(appearance => appearance.id === selectedAppearanceId);
    if (selected) return getAppearanceDisplayName(selected);
    return current?.name ?? t('nav.settingsMenu.theme');
  }, [appearances, current?.name, getAppearanceDisplayName, selectedAppearanceId, t, tApplication]);

  const submenuLayout = useSubmenuLayout(
    open,
    triggerRef,
    submenuRef,
    `${appearances.length}:${selectedAppearanceId}`,
  );

  const focusFirstSubmenuItem = useCallback(() => {
    const firstItem = submenuRef.current?.querySelector<HTMLButtonElement>(
      '[data-openbitfun-menu-item]:not(:disabled)',
    );
    firstItem?.focus();
  }, []);

  useEffect(() => {
    if (!open || !focusSubmenuOnOpenRef.current) return;
    focusSubmenuOnOpenRef.current = false;
    const frame = window.requestAnimationFrame(focusFirstSubmenuItem);
    return () => window.cancelAnimationFrame(frame);
  }, [focusFirstSubmenuItem, open]);

  const openFromKeyboard = useCallback(() => {
    focusSubmenuOnOpenRef.current = true;
    if (open) {
      window.requestAnimationFrame(focusFirstSubmenuItem);
    } else {
      onOpenChange(true);
    }
  }, [focusFirstSubmenuItem, onOpenChange, open]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      openFromKeyboard();
    }
  };

  const handleSubmenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onOpenChange(false);
    triggerRef.current?.focus();
  };

  const handleSelect = useCallback(async (id: AppearanceSelectionId) => {
    try {
      await select(id);
      onCloseParentMenu();
    } catch {
      notifyError(t('nav.settingsMenu.appearanceSwitchFailed'), { duration: 4000 });
    }
  }, [notifyError, onCloseParentMenu, select, t]);

  const selectionDisabled = !initialized || status === 'applying';

  return (
    <>
      <MenuItem data-overflow-trigger
        ref={triggerRef}
        className={`openbitfun-nav-panel__appearance-menu-trigger${open ? ' is-open' : ''}`}
        leading={<Icon name="palette" size="sm" aria-hidden="true" />}
        metadata={(
          <OverflowText className="openbitfun-nav-panel__appearance-menu-current" title={selectedDisplayName}>
            {selectedDisplayName}
          </OverflowText>
        )}
        shortcut={<Icon name="chevron-right" size="sm" aria-hidden="true" />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        onKeyDown={handleTriggerKeyDown}
        data-testid="nav-settings-appearance-item"
      >
        {t('nav.settingsMenu.theme')}
      </MenuItem>

      {open && createOverlayPortal(
        <Menu
          ref={submenuRef}
          className="openbitfun-nav-panel__appearance-submenu"
          aria-label={t('nav.settingsMenu.theme')}
          data-placement={submenuLayout?.placement}
          data-testid="nav-settings-appearance-menu"
          onKeyDown={handleSubmenuKeyDown}
          style={{
            left: `${submenuLayout?.left ?? 0}px`,
            top: `${submenuLayout?.top ?? 0}px`,
            visibility: submenuLayout ? 'visible' : 'hidden',
          }}
        >
          <MenuItem
            checked={selectedAppearanceId === SYSTEM_APPEARANCE_ID}
            disabled={selectionDisabled}
            leading={selectedAppearanceId === SYSTEM_APPEARANCE_ID
              ? <Icon name="check-line" size="sm" aria-hidden="true" />
              : undefined}
            reserveLeadingSpace
            role="menuitemradio"
            onClick={() => void handleSelect(SYSTEM_APPEARANCE_ID)}
            data-appearance-id={SYSTEM_APPEARANCE_ID}
            data-testid="nav-settings-appearance-option"
          >
            {tApplication('appearance.systemAppearance')}
          </MenuItem>
          <MenuSeparator />
          {appearances.map(appearance => {
            const selected = appearance.id === selectedAppearanceId;
            return (
              <MenuItem
                key={appearance.id}
                checked={selected}
                disabled={selectionDisabled}
                leading={selected
                  ? <Icon name="check-line" size="sm" aria-hidden="true" />
                  : undefined}
                reserveLeadingSpace
                role="menuitemradio"
                onClick={() => void handleSelect(appearance.id)}
                data-appearance-id={appearance.id}
                data-testid="nav-settings-appearance-option"
              >
                {getAppearanceDisplayName(appearance)}
              </MenuItem>
            );
          })}
          <MenuSeparator />
          <MenuItem
            leading={<Icon name="gear" size="sm" aria-hidden="true" />}
            onClick={onOpenAppearanceSettings}
            data-testid="nav-settings-appearance-settings"
          >
            {t('nav.settingsMenu.themeConfiguration')}
          </MenuItem>
        </Menu>,
        getAppearanceOverlayHost(),
      )}
    </>
  );
};

export default AppearanceQuickSwitchMenuItem;
