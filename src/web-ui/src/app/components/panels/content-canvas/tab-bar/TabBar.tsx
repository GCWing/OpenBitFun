/**
 * TabBar component.
 * Tab bar container that manages visibility and overflow.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react';
import { Split } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tab } from './Tab';
import { TabOverflowMenu } from './TabOverflowMenu';
import type { CanvasTab, EditorGroupId, TabDragPayload } from '../types';
import { createLogger } from '@/shared/utils/logger';
import './TabBar.scss';
import { Icon, IconButton, TabGroup, Toolbar, Tooltip, type TabGroupItem } from '@openbitfun/ui';

const log = createLogger('TabBar');
const TAB_REORDER_DURATION_MS = 160;
const TAB_REORDER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export interface TabBarProps {
  /** Tab list */
  tabs: CanvasTab[];
  /** Editor group ID */
  groupId: EditorGroupId;
  /** Active tab ID */
  activeTabId: string | null;
  /** Whether this group is active */
  isActiveGroup: boolean;
  /** Click tab */
  onTabClick: (tabId: string) => void;
  /** Double-click tab */
  onTabDoubleClick: (tabId: string) => void;
  /** Close tab */
  onTabClose: (tabId: string) => Promise<void> | void;
  /** Pin tab */
  onTabPin: (tabId: string) => void;
  /** Drag start */
  onDragStart: (payload: TabDragPayload) => void;
  /** Drag end */
  onDragEnd: () => void;
  /** Dragging tab ID */
  draggingTabId: string | null;
  /** Reorder tab */
  onReorderTab: (tabId: string, newIndex: number) => void;
  /** Open mission control */
  onOpenMissionControl?: () => void;
  /** Close all tabs */
  onCloseAllTabs?: () => Promise<void> | void;
  /** Pop out tab as independent scene */
  onTabPopOut?: (tabId: string) => void;
  /** undefined keeps default actions; null omits them in non-owning split groups. */
  toolbarActions?: React.ReactNode;
}

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  groupId,
  activeTabId,
  isActiveGroup,
  onTabClick,
  onTabDoubleClick,
  onTabClose,
  onTabPin,
  onDragStart,
  onDragEnd,
  draggingTabId,
  onReorderTab,
  onOpenMissionControl,
  onCloseAllTabs,
  onTabPopOut,
  toolbarActions,
}) => {
  const { t } = useTranslation('components');
  const [overflowTabIds, setOverflowTabIds] = useState<string[]>([]);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const tabsListRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const tabWrapperRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingReorderRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const reorderAnimationsRef = useRef<Map<string, Animation>>(new Map());
  const visibleTabs = useMemo(() => tabs.filter(tab => !tab.isHidden), [tabs]);
  const tabSignature = visibleTabs.map(tab => tab.id).join(':');

  // Every item stays in one TabGroup so keyboard navigation can reach tabs
  // beyond the viewport. Overflow follows rendered geometry, never text estimates.
  const updateOverflow = useCallback(() => {
    const list = tabsListRef.current;
    const toolbar = containerRef.current;
    if (!list || !toolbar || list.clientWidth === 0) return;

    const toolbarStyle = getComputedStyle(toolbar);
    const actions = actionsRef.current;
    const fixedActions = actions
      ? Array.from(actions.children).filter((child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset.openbitfunProductComponent !== 'canvas-tab-overflow')
      : [];
    const actionsGap = actions ? parseFloat(getComputedStyle(actions).columnGap) || 0 : 0;
    const fixedActionsWidth = fixedActions.reduce((width, action) => width + action.offsetWidth, 0)
      + Math.max(0, fixedActions.length - 1) * actionsGap;
    const availableWithoutOverflow = toolbar.clientWidth
      - (parseFloat(toolbarStyle.paddingLeft) || 0)
      - (parseFloat(toolbarStyle.paddingRight) || 0)
      - (parseFloat(toolbarStyle.columnGap) || 0)
      - fixedActionsWidth;
    const canFitWithoutMenu = !onOpenMissionControl
      && list.scrollWidth <= availableWithoutOverflow;
    const viewport = list.getBoundingClientRect();
    const nextIds = canFitWithoutMenu ? [] : visibleTabs.filter(tab => {
      const bounds = tabWrapperRefs.current.get(tab.id)?.getBoundingClientRect();
      return bounds && (bounds.left < viewport.left - 1 || bounds.right > viewport.right + 1);
    }).map(tab => tab.id);

    setOverflowTabIds(previous => previous.length === nextIds.length
      && previous.every((id, index) => id === nextIds[index]) ? previous : nextIds);
  }, [onOpenMissionControl, visibleTabs]);

  const revealActiveTab = useCallback(() => {
    if (activeTabId && tabsListRef.current?.clientWidth) {
      tabWrapperRefs.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeTabId]);

  useLayoutEffect(() => {
    revealActiveTab();
    updateOverflow();
  }, [revealActiveTab, updateOverflow]);

  useEffect(() => {
    let frameId: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        revealActiveTab();
        updateOverflow();
      });
    });
    for (const element of [containerRef.current, tabsListRef.current, actionsRef.current, ...tabWrapperRefs.current.values()]) {
      if (element) observer.observe(element);
    }
    return () => {
      observer.disconnect();
      if (frameId !== undefined) cancelAnimationFrame(frameId);
    };
  }, [revealActiveTab, updateOverflow]);

  const overflowTabs = visibleTabs.filter(tab => overflowTabIds.includes(tab.id));
  useEffect(() => () => {
    reorderAnimationsRef.current.forEach(animation => animation.cancel());
    reorderAnimationsRef.current.clear();
  }, []);

  useLayoutEffect(() => {
    const previousRects = pendingReorderRectsRef.current;
    if (!previousRects) return;
    pendingReorderRectsRef.current = null;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduceMotion) return;

    for (const [tabId, element] of tabWrapperRefs.current) {
      const previousRect = previousRects.get(tabId);
      if (!previousRect) continue;
      const deltaX = previousRect.left - element.getBoundingClientRect().left;
      if (Math.abs(deltaX) < 0.5) continue;

      reorderAnimationsRef.current.get(tabId)?.cancel();
      const animation = element.animate(
        [
          { transform: `translateX(${deltaX}px)` },
          { transform: 'translateX(0)' },
        ],
        {
          duration: TAB_REORDER_DURATION_MS,
          easing: TAB_REORDER_EASING,
        },
      );
      reorderAnimationsRef.current.set(tabId, animation);
      animation.addEventListener('finish', () => {
        if (reorderAnimationsRef.current.get(tabId) === animation) {
          reorderAnimationsRef.current.delete(tabId);
        }
      }, { once: true });
    }
  }, [tabSignature]);

  // Handle tab drag start
  const handleTabDragStart = useCallback((tab: CanvasTab) => (_e: React.DragEvent) => {
    onDragStart({
      tabId: tab.id,
      sourceGroupId: groupId,
      tab,
    });
  }, [groupId, onDragStart]);

  // Handle drag over
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  // Handle drag leave
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverIndex(null);
    }
  }, []);

  // Handle drop
  const handleDrop = useCallback((e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverIndex(null);

    if (!draggingTabId) return;

    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'));

      // Only reorder within the same group
      if (data.sourceGroupId === groupId) {
        const currentIndex = visibleTabs.findIndex(t => t.id === data.tabId);
        if (currentIndex !== -1 && currentIndex !== targetIndex) {
          pendingReorderRectsRef.current = new Map(
            Array.from(tabWrapperRefs.current, ([tabId, element]) => (
              [tabId, element.getBoundingClientRect()] as const
            )),
          );
          onReorderTab(data.tabId, targetIndex);
        }
      }
    } catch (err) {
      log.error('Failed to parse drag data', err);
    }
  }, [draggingTabId, groupId, visibleTabs, onReorderTab]);

  const draggingIndex = draggingTabId
    ? visibleTabs.findIndex(tab => tab.id === draggingTabId)
    : -1;
  const draggedTabWidth = draggingIndex >= 0
    ? (tabWrapperRefs.current.get(visibleTabs[draggingIndex].id)?.offsetWidth ?? 0)
      + (tabsListRef.current ? parseFloat(getComputedStyle(tabsListRef.current).columnGap) || 0 : 0)
    : 0;

  const getDragShift = (index: number): number => {
    if (dragOverIndex === null || draggingIndex < 0 || index === draggingIndex) {
      return 0;
    }
    if (draggingIndex < dragOverIndex && index > draggingIndex && index <= dragOverIndex) {
      return -draggedTabWidth;
    }
    if (draggingIndex > dragOverIndex && index >= dragOverIndex && index < draggingIndex) {
      return draggedTabWidth;
    }
    return 0;
  };

  // Clear indicator when drag ends
  useEffect(() => {
    if (!draggingTabId) {
      setDragOverIndex(null);
    }
  }, [draggingTabId]);

  const handleCloseOtherTabs = useCallback((targetTabId: string) => async () => {
    for (const tab of visibleTabs) {
      if (tab.id !== targetTabId && tab.state !== 'pinned') {
        await onTabClose(tab.id);
      }
    }
  }, [onTabClose, visibleTabs]);

  const tabItems: TabGroupItem[] = visibleTabs.map(tab => ({
    value: tab.id,
    label: (
      <span data-openbitfun-product-component="canvas-tab" data-openbitfun-product-part="title" className="canvas-tab__title">
        {tab.fileDeletedFromDisk ? `${tab.title} - ${t('tabs.fileDeleted')}` : tab.title}
      </span>
    ),
    icon: tab.content.type === 'task-detail'
      ? <Split data-openbitfun-product-component="canvas-tab" data-openbitfun-product-part="typeIcon" aria-hidden />
      : undefined,
    labelSuffix: tab.isDirty ? (
      <span data-openbitfun-product-component="canvas-tab" data-openbitfun-product-part="dirtyIndicator" className="canvas-tab__dirty-indicator" title={t('tabs.unsaved')}>
        ●
      </span>
    ) : undefined,
    endAction: (
      <IconButton
        data-openbitfun-product-component="canvas-tab"
        data-openbitfun-product-part="action"
        className="canvas-tab__action-btn"
        data-motion="none"
        shape="circle"
        size="xs"
        variant={tab.state === 'pinned' ? 'quiet' : 'outline'}
        aria-label={`${t(tab.state === 'pinned' ? 'tabs.unpin' : 'tabs.close')} ${tab.title}`}
        title={t(tab.state === 'pinned' ? 'tabs.unpin' : 'tabs.close')}
        icon={<Icon name={tab.state === 'pinned' ? 'pin' : 'xmark'} size="xs" />}
        onClick={(event) => {
          event.stopPropagation();
          if (tab.state === 'pinned') onTabPin(tab.id);
          else void onTabClose(tab.id);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      />
    ),
  }));

  return (
    <Toolbar data-openbitfun-product-component="canvas-tab-bar" data-openbitfun-product-part="root" data-openbitfun-group={groupId} data-openbitfun-state={isActiveGroup ? 'active' : ''}
      ref={containerRef}
      className={`canvas-tab-bar ${isActiveGroup ? 'is-active-group' : ''}`}
      size="sm"
      leading={(
        <TabGroup
          ref={tabsListRef}
          className="canvas-tab-bar__tabs"
          data-openbitfun-product-component="canvas-tab-bar"
          data-openbitfun-product-part="list"
          data-openbitfun-group={groupId}
          aria-label={t(groupId === 'primary' ? 'canvas.groupPrimaryFull' : groupId === 'secondary' ? 'canvas.groupSecondaryFull' : 'canvas.groupTertiaryFull')}
          size="sm"
          value={activeTabId ?? undefined}
          items={tabItems}
          onValueChange={onTabClick}
          onScroll={updateOverflow}
          renderItem={(item, node, index) => {
            const tab = visibleTabs[index];
            return (
              <div
                data-openbitfun-product-component="canvas-tab-bar"
                data-openbitfun-product-part="tabWrapper"
                data-tab-id={tab.id}
                key={item.value}
                className="canvas-tab-bar__tab-wrapper"
                ref={(element) => {
                  if (element) tabWrapperRefs.current.set(tab.id, element);
                  else tabWrapperRefs.current.delete(tab.id);
                }}
                style={{
                  transform: getDragShift(index) === 0
                    ? undefined
                    : `translateX(${getDragShift(index)}px)`,
                }}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, index)}
              >
                {/* Drop indicator */}
                {dragOverIndex === index && draggingTabId && (
                  <div data-openbitfun-product-component="canvas-tab-bar" data-openbitfun-product-part="dropIndicator" className="canvas-tab-drop-indicator" />
                )}

                <Tab
                  tab={tab}
                  groupId={groupId}
                  isActive={(activeTabId ?? visibleTabs[0]?.id) === tab.id}
                  onClick={() => onTabClick(tab.id)}
                  onDoubleClick={() => onTabDoubleClick(tab.id)}
                  onClose={() => onTabClose(tab.id)}
                  onPin={() => onTabPin(tab.id)}
                  onDragStart={handleTabDragStart(tab)}
                  onDragEnd={onDragEnd}
                  isDragging={draggingTabId === tab.id}
                  onPopOut={onTabPopOut ? () => onTabPopOut(tab.id) : undefined}
                  onCloseOthers={visibleTabs.length > 1 ? handleCloseOtherTabs(tab.id) : undefined}
                  onCloseAll={onCloseAllTabs}
                >
                  {node}
                </Tab>
              </div>
            );
          }}
        />
      )}
      trailing={(
        <div ref={actionsRef} className="canvas-tab-bar__actions" data-openbitfun-product-component="canvas-tab-bar" data-openbitfun-product-part="actions" data-openbitfun-group={groupId}>
          {/* Overflow menu (all groups; mission control only in primary) */}
          {visibleTabs.length > 0 && (
            <TabOverflowMenu
              overflowTabs={overflowTabs}
              activeTabId={activeTabId}
              onTabClick={onTabClick}
              onTabClose={onTabClose}
              onReorderTab={onReorderTab}
              onOpenMissionControl={onOpenMissionControl}
            />
          )}

          {/* Hosts own layout actions; close-all remains available in tab menus. */}
          {toolbarActions !== undefined ? toolbarActions : onCloseAllTabs && visibleTabs.length > 0 && (
            <Tooltip content={t('tabs.closeAll')} placement="bottom">
              <IconButton
                data-openbitfun-product-component="canvas-tab-bar"
                data-openbitfun-product-part="action"
                className="canvas-tab-bar__close-all"
                size="sm"
                aria-label={t('tabs.closeAll')}
                icon={<Icon name="xmark" size="sm" />}
                onClick={async (e) => {
                  e.stopPropagation();
                  await onCloseAllTabs();
                }}
              />
            </Tooltip>
          )}
        </div>
      )}
    />
  );
};

TabBar.displayName = 'TabBar';

export default TabBar;
