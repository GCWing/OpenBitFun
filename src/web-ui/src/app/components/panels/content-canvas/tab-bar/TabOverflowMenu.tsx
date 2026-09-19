/**
 * TabOverflowMenu component.
 * Combines mission control entry and overflow tabs menu.
 * - Mission control without overflow: click to open mission control
 * - Overflow: show +N badge and dropdown; first item is mission control (if available)
 * - Overflow without mission control: show overflow menu only
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { subscribeOverlayInteraction, createOverlayPortal, Button, IconButton, OverflowText, Icon, KeyHint, Menu, MenuItem, MenuList, MenuSeparator, Tooltip } from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CanvasTab } from '../types';
import './TabOverflowMenu.scss';
export interface TabOverflowMenuProps {
  /** Overflow tabs */
  overflowTabs: CanvasTab[];
  /** Active tab ID */
  activeTabId: string | null;
  /** Tab click callback */
  onTabClick: (tabId: string) => void;
  /** Close tab callback */
  onTabClose: (tabId: string) => Promise<void> | void;
  /** Reorder tab callback (move to index) */
  onReorderTab: (tabId: string, newIndex: number) => void;
  /** Open mission control (optional, only for primary group) */
  onOpenMissionControl?: () => void;
}

export const TabOverflowMenu: React.FC<TabOverflowMenuProps> = ({
  overflowTabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onReorderTab,
  onOpenMissionControl,
}) => {
  const { t } = useTranslation('components');
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const hasOverflow = overflowTabs.length > 0;
  const hasMissionControl = !!onOpenMissionControl;

  // Update menu position
  const updateMenuPosition = useCallback(() => {
    if (wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      const menuWidth = 240;
      
      // Compute left to keep menu within right boundary
      let left = rect.left;
      if (left + menuWidth > window.innerWidth) {
        left = rect.right - menuWidth;
      }
      
      setMenuPosition({
        top: rect.bottom + 4,
        left: Math.max(8, left),
      });
    }
  }, []);

  // Button click
  const handleButtonClick = useCallback(() => {
    if (hasOverflow) {
      if (!isOpen) {
        updateMenuPosition();
      }
      setIsOpen(prev => !prev);
    } else if (hasMissionControl) {
      onOpenMissionControl?.();
    }
  }, [hasOverflow, hasMissionControl, isOpen, updateMenuPosition, onOpenMissionControl]);

  // Close menu on outside click
  useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        wrapperRef.current &&
        !wrapperRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    // Delay listener to avoid triggering the current click
    const timer = setTimeout(() => {
      removeOverlayMousedown0 = subscribeOverlayInteraction(menuRef, 'mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      removeOverlayMousedown0?.();
    };
  }, [isOpen]);

  // Handle mission control click
  const handleMissionControlClick = useCallback(() => {
    onOpenMissionControl?.();
    setIsOpen(false);
  }, [onOpenMissionControl]);

  // Handle tab click
  const handleTabClick = useCallback((tabId: string) => {
    // Move tab to front (index 0) so it becomes visible
    onReorderTab(tabId, 0);
    // Then switch to the tab
    onTabClick(tabId);
    setIsOpen(false);
  }, [onTabClick, onReorderTab]);

  // Handle close click
  const handleCloseClick = useCallback(async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    await onTabClose(tabId);
  }, [onTabClose]);

  const handleItemMiddleMouseDown = useCallback((e: React.MouseEvent, tab: CanvasTab) => {
    if (e.button !== 1) return;
    if (tab.state === 'pinned') return;
    const target = e.target as HTMLElement;
    if (target.closest('.canvas-tab-overflow-menu__item-close')) return;
    e.preventDefault();
  }, []);

  const handleItemAuxClick = useCallback(
    async (e: React.MouseEvent, tab: CanvasTab) => {
      if (e.button !== 1) return;
      if (tab.state === 'pinned') return;
      const target = e.target as HTMLElement;
      if (target.closest('.canvas-tab-overflow-menu__item-close')) return;
      e.preventDefault();
      e.stopPropagation();
      await onTabClose(tab.id);
      setIsOpen(false);
    },
    [onTabClose]
  );

  // Decide whether to show button: overflow tabs or mission control
  const shouldShowButton = hasOverflow || hasMissionControl;
  
  // Hide button when no overflow and no mission control
  if (!shouldShowButton) {
    return null;
  }

  const tooltipContent = hasOverflow 
    ? hasMissionControl
      ? `${t('tabs.missionControl')} · ${t('tabs.hiddenTabsCount', { count: overflowTabs.length })}`
      : t('tabs.hiddenTabsCount', { count: overflowTabs.length })
    : hasMissionControl
      ? t('tabs.missionControl')
      : '';

  return (
    <div data-openbitfun-product-component="canvas-tab-overflow" data-openbitfun-product-part="root" data-openbitfun-state={isOpen ? 'open' : ''} ref={wrapperRef} className="canvas-tab-panorama-wrapper">
      <Tooltip content={tooltipContent} placement="bottom">
        {hasOverflow ? (
          <Button
            data-openbitfun-product-component="canvas-tab-overflow"
            data-openbitfun-product-part="trigger"
            size="sm"
            variant="text"
            aria-label={tooltipContent}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            onClick={handleButtonClick}
            leadingIcon={hasMissionControl ? <LayoutGrid size={14} /> : <Icon name="chevron-down" size="sm" />}
          >
            <span data-openbitfun-product-component="canvas-tab-overflow" data-openbitfun-product-part="badge">
              +{overflowTabs.length}
            </span>
          </Button>
        ) : (
          <IconButton
            data-openbitfun-product-component="canvas-tab-overflow"
            data-openbitfun-product-part="trigger"
            size="sm"
            aria-label={tooltipContent}
            onClick={handleButtonClick}
            icon={<LayoutGrid size={14} />}
          />
        )}
      </Tooltip>

      {isOpen && hasOverflow && createOverlayPortal(
        <Menu
          ref={menuRef}
          className="canvas-tab-overflow-menu"
          style={{
            position: 'fixed',
            top: `${menuPosition.top}px`,
            left: `${menuPosition.left}px`,
          }}
        >
          {/* Mission control entry - shown only when available */}
          {hasMissionControl && (
            <>
              <MenuItem
                className="canvas-tab-overflow-menu__mission-control-row canvas-tab-overflow-menu__mission-control"
                onClick={handleMissionControlClick}
                leading={<LayoutGrid size={14} />}
                shortcut={<KeyHint>⌘.</KeyHint>}
              >
                <span>{t('tabs.missionControl')}</span>
              </MenuItem>

              {/* Divider */}
              <MenuSeparator className="canvas-tab-overflow-menu__divider" />
            </>
          )}

          {/* Overflow tab list */}
          <MenuList className="canvas-tab-overflow-menu__list">
            {overflowTabs.map((tab) => {
              const deletedSuffix = tab.fileDeletedFromDisk ? ` - ${t('tabs.fileDeleted')}` : '';
              const titleWithDeleted = `${tab.title}${deletedSuffix}`;
              return (
              <MenuItem data-overflow-trigger
                key={tab.id}
                role="menuitemradio"
                checked={activeTabId === tab.id}
                className={`canvas-tab-overflow-menu__item-row canvas-tab-overflow-menu__item ${
                  activeTabId === tab.id ? 'is-active' : ''
                } ${tab.isDirty ? 'is-dirty' : ''} ${tab.fileDeletedFromDisk ? 'is-file-deleted' : ''}`}
                onClick={() => handleTabClick(tab.id)}
                onMouseDown={(e) => handleItemMiddleMouseDown(e, tab)}
                onAuxClick={(e) => void handleItemAuxClick(e, tab)}
                actions={[{
                  id: `close:${tab.id}`,
                  label: t('tabs.close'),
                  icon: <Icon name="xmark" size="xs" />,
                  onClick: (e) => { void handleCloseClick(e, tab.id); },
                }]}
              >
                <OverflowText behavior="marquee"
                  data-openbitfun-product-component="canvas-tab-overflow"
                  data-openbitfun-product-part="itemTitle"
                  data-openbitfun-state={[
                    activeTabId === tab.id && 'active',
                    tab.isDirty && 'dirty',
                    tab.fileDeletedFromDisk && 'deleted',
                  ].filter(Boolean).join(' ') || undefined}
                  className="canvas-tab-overflow-menu__item-title"
                >
                  {tab.state === 'preview' && <em>{titleWithDeleted}</em>}
                  {tab.state !== 'preview' && titleWithDeleted}
                </OverflowText>
                
                {tab.isDirty && (
                  <span className="canvas-tab-overflow-menu__item-dirty">●</span>
                )}
                
              </MenuItem>
            );
            })}
          </MenuList>
        </Menu>,
        getAppearanceOverlayHost()
      )}
    </div>
  );
};

TabOverflowMenu.displayName = 'TabOverflowMenu';

export default TabOverflowMenu;
