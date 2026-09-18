/**
 * SceneBar — horizontally scrollable scene-level tab bar.
 *
 * Delegates state to useSceneManager.
 * Session tabs show only the referenced session title.
 */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { Pin, CircleAlert } from 'lucide-react';
import { useSceneStore } from '../../stores/sceneStore';
import { useContextMenuStore } from '@/shared/context-menu-system/store/ContextMenuStore';
import { ContextType } from '@/shared/context-menu-system/types/context.types';
import type { MenuItem } from '@/shared/context-menu-system/types/menu.types';

import { Icon, TabGroup, type TabGroupItem } from '@openbitfun/ui';
import { useSceneTabNavigation } from './useSceneTabNavigation';
import { useSceneManager } from '../../hooks/useSceneManager';
import { useSessionTabLabels } from '../../hooks/useSessionTabLabels';
import { SessionTitleNumber } from '@/flow_chat/components/SessionTitleNumber';
import { isSceneTabClosable } from '../../scenes/registry';
import { useContentResourceStore } from '../../workbench/contentResourceStore';
import { dropSessionTabOnWorkbench, isSessionTabDrag, type WorkbenchTabDropTarget } from '../../workbench/canvasTabTransfer';
import { useAgentCanvasStore } from '../panels/content-canvas/stores';
import { onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { SceneTabId } from './types';
import { beginConversationTransfer, endConversationTransfer, isConversationTransfer, dropConversationInWorkbench } from '../../services/conversationDockTransfer';
import './SceneBar.scss';

function getSceneIdFromTabTarget(target: EventTarget | null): SceneTabId | undefined {
  if (!(target instanceof HTMLElement)) return undefined;
  const item = target.closest<HTMLElement>('[data-openbitfun-part="item"]');
  const tab = item?.querySelector<HTMLElement>('[role="tab"][data-openbitfun-value]');
  return tab?.dataset.openbitfunValue as SceneTabId | undefined;
}

interface SceneBarProps {
  className?: string;
}

const SceneBar: React.FC<SceneBarProps> = ({
  className = '',
}) => {
  const {
    openTabs,
    activeTabId,
    pendingTabId,
    navigationMotion,
    tabDefs,
    activateScene,
    closeScene,
  } = useSceneManager();
  const sessionLabels = useSessionTabLabels(openTabs);
  const resources = useContentResourceStore(state => state.resources);
  const selectedTabId = pendingTabId ?? activeTabId;
  const { t } = useI18n('common');
  const { t: tComponents } = useI18n('components');
  const draggingTab = useRef<SceneTabId | null>(null);
  const [offeredCanvasTabId, setOfferedCanvasTabId] = useState<string | null>(null);
  const draggingCanvasTabId = useAgentCanvasStore(state => {
    const group = state.draggingFromGroupId === 'primary' ? state.primaryGroup
      : state.draggingFromGroupId === 'secondary' ? state.secondaryGroup : state.tertiaryGroup;
    return group.tabs.some(tab => tab.id === state.draggingTabId) ? state.draggingTabId : null;
  });
  const [canvasDrop, setCanvasDrop] = useState<{ target?: WorkbenchTabDropTarget } | null>(null);
  const canAcceptCanvasTab = Boolean(offeredCanvasTabId && offeredCanvasTabId === draggingCanvasTabId);
  const activeCanvasDrop = canAcceptCanvasTab ? canvasDrop : null;
  const sceneBarClassName = `openbitfun-scene-bar ${className}`.trim();
  const {
    tabRegionRef,
    tabsRef,
    scrollState: tabScrollState,
    handleScroll: handleTabsScroll,
    handleWheel: handleTabsWheel,
    scrollByPage: scrollTabsByPage,
  } = useSceneTabNavigation({
    activeTabId: selectedTabId,
    navigationMotion,
    openTabIds: openTabs.map(tab => tab.id),
  });

  const handleTabValueChange = useCallback((value: string) => {
    activateScene(value as SceneTabId);
  }, [activateScene]);

  useEffect(() => {
    // The source has written its transfer format and committed its drag state
    // before dragstart bubbles here. Advertise the destination immediately.
    const offerDrop = (event: DragEvent) => {
      setOfferedCanvasTabId(event.dataTransfer && isSessionTabDrag(event.dataTransfer)
        ? useAgentCanvasStore.getState().draggingTabId : null);
      setCanvasDrop(null);
    };
    const clearDrop = () => {
      setOfferedCanvasTabId(null);
      setCanvasDrop(null);
    };
    window.addEventListener('dragstart', offerDrop);
    // Other drop targets may stop bubbling. Completion always ends this offer.
    window.addEventListener('dragend', clearDrop, true);
    window.addEventListener('drop', clearDrop, true);
    const stopSurfaceListener = onSurfaceActivated(clearDrop);
    return () => {
      window.removeEventListener('dragstart', offerDrop);
      window.removeEventListener('dragend', clearDrop, true);
      window.removeEventListener('drop', clearDrop, true);
      stopSurfaceListener();
    };
  }, []);

  const getCanvasDropTarget = (event: React.DragEvent): WorkbenchTabDropTarget | undefined => {
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-scene-tab-id]') : null;
    const tabId = item?.dataset.sceneTabId as SceneTabId | undefined;
    if (item && tabId) {
      const rect = item.getBoundingClientRect();
      return { tabId, placement: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after' };
    }
    const last = openTabs[openTabs.length - 1];
    return last ? { tabId: last.id, placement: 'after' } : undefined;
  };

  const handleTabsMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 1) return;
    if ((e.target as HTMLElement | null)?.closest('[data-scene-bar-part="closeTab"]')) return;
    const sceneId = getSceneIdFromTabTarget(e.target);
    if (!sceneId || !isSceneTabClosable(tabDefs.find(def => def.id === sceneId))) return;
    e.preventDefault();
  }, [tabDefs]);

  const handleTabsAuxClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 1) return;
    if ((e.target as HTMLElement | null)?.closest('[data-scene-bar-part="closeTab"]')) return;
    const sceneId = getSceneIdFromTabTarget(e.target);
    if (!sceneId || !isSceneTabClosable(tabDefs.find(def => def.id === sceneId))) return;
    e.preventDefault();
    e.stopPropagation();
    closeScene(sceneId);
  }, [closeScene, tabDefs]);

  const handleTabsKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Delete') return;
    const sceneId = getSceneIdFromTabTarget(e.target);
    if (!sceneId || !isSceneTabClosable(tabDefs.find(def => def.id === sceneId))) return;
    e.preventDefault();
    e.stopPropagation();
    closeScene(sceneId);
  }, [closeScene, tabDefs]);

  const handleContextMenu = (event: React.MouseEvent, id: SceneTabId) => {
    event.preventDefault();
    event.stopPropagation();
    const tab = openTabs.find(candidate => candidate.id === id);
    if (!tab) return;
    const resource = tab.contentId ? resources[tab.contentId] : undefined;
    const closeContentTabs = async (except?: SceneTabId) => {
      const state = useSceneStore.getState();
      const targets = state.openTabs.filter(candidate => candidate.contentId && candidate.id !== except && !candidate.pinned)
        .sort((a, b) => Number(a.id === state.activeTabId) - Number(b.id === state.activeTabId));
      for (const target of targets) {
        await useSceneStore.getState().closeScene(target.id);
        if (useSceneStore.getState().openTabs.some(candidate => candidate.id === target.id)) break;
      }
    };
    const items: MenuItem[] = [
      { id: 'close', label: tComponents('tabs.close'), disabled: !isSceneTabClosable(tabDefs.find(def => def.id === id)), onClick: () => closeScene(id) },
      { id: 'pin', label: tComponents((tab.pinned ?? tabDefs.find(def => def.id === id)?.pinned) ? 'tabs.unpin' : 'tabs.pin'), onClick: () => useSceneStore.getState().togglePinScene(id) },
    ];
    if (resource) items.push(
      { id: 'close-others', label: tComponents('workbench.closeOtherContent'), onClick: () => { void closeContentTabs(id); } },
      { id: 'close-all', label: tComponents('workbench.closeAllContent'), onClick: () => { void closeContentTabs(); } },
    );
    if (resource?.target.kind === 'file') {
      const path = resource.target.path;
      items.push({ id: 'copy-path', label: t('file.copyPath'), onClick: () => navigator.clipboard.writeText(path) });
    }
    useContextMenuStore.getState().showMenu({ x: event.clientX, y: event.clientY }, items, {
      type: ContextType.CUSTOM, customType: 'workbench-tab', data: { tabId: id },
      event, targetElement: event.currentTarget as HTMLElement,
      position: { x: event.clientX, y: event.clientY }, timestamp: Date.now(),
    });
  };

  const tabItems = openTabs.reduce<TabGroupItem[]>((items, tab) => {
    const def = tabDefs.find(candidate => candidate.id === tab.id);
    if (!def) return items;

    const translatedLabel = def.labelKey ? t(def.labelKey) : def.label;
    const sessionLabel = sessionLabels[tab.id];
    const displayLabel = sessionLabel?.title || translatedLabel;
    const closeLabel = t('sceneBar.closeTab', { label: sessionLabel?.number ? `${displayLabel} ${sessionLabel.number}` : displayLabel });
    const closable = isSceneTabClosable(def);

    items.push({
      value: tab.id,
      label: displayLabel,
      labelSuffix: sessionLabel?.number || tab.pinned || (tab.contentId && (resources[tab.contentId]?.isDirty || resources[tab.contentId]?.fileMissing)) ? <>
        {sessionLabel?.number && <SessionTitleNumber number={sessionLabel.number} />}
        {tab.pinned && <Pin size={12} aria-label={tComponents('tabs.unpin')} />}
        {tab.contentId && resources[tab.contentId]?.isDirty && <span aria-label={tComponents('tabs.unsaved')}>•</span>}
        {tab.contentId && resources[tab.contentId]?.fileMissing && <CircleAlert size={12} aria-label={tComponents('tabs.fileDeleted')} />}
      </> : undefined,
      labelTransitionKey: tab.session?.sessionId,
      // Keep the close hit target stationary between pointer down and up;
      // shrinking it can retarget the click at the button edge (issue #2210).
      endAction: closable ? (
        <button
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          data-motion="none"
          data-scene-bar-part="closeTab"
          data-scene-id={tab.id}
          onClick={(event) => {
            event.stopPropagation();
            closeScene(tab.id);
          }}
          tabIndex={-1}
        >
          <Icon name="xmark" size="xs" aria-hidden="true" />
        </button>
      ) : undefined,
    });
    return items;
  }, []);

  return (
    <div data-openbitfun-component="scene-bar" data-openbitfun-part="root"
      className={sceneBarClassName}
      data-canvas-drop-state={canAcceptCanvasTab ? (activeCanvasDrop ? 'active' : 'available') : undefined}
      data-canvas-drop-target={activeCanvasDrop ? 'true' : undefined}
      onDragOver={event => {
        if (isConversationTransfer(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; return; }
        if (!isSessionTabDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        // Also recover the offer if this header mounted during an existing drag.
        setOfferedCanvasTabId(useAgentCanvasStore.getState().draggingTabId);
        const target = getCanvasDropTarget(event);
        setCanvasDrop(previous => previous && previous.target?.tabId === target?.tabId
          && previous.target?.placement === target?.placement ? previous : { target });
      }}
      onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setCanvasDrop(null);
      }}
      onDrop={event => {
        if (isConversationTransfer(event.dataTransfer)) { event.preventDefault(); dropConversationInWorkbench(event.dataTransfer); return; }
        if (!isSessionTabDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        dropSessionTabOnWorkbench(event.dataTransfer, getCanvasDropTarget(event));
        setCanvasDrop(null);
      }}
    >
      <div
        ref={tabRegionRef}
        className="openbitfun-scene-bar__tab-region"
        data-overflow={tabScrollState.hasOverflow ? 'true' : 'false'}
        data-openbitfun-component="scene-bar"
        data-openbitfun-part="tabs"
      >
        {tabScrollState.hasOverflow && (
          <button
            type="button"
            className="openbitfun-scene-bar__scroll-button"
            aria-label={t('sceneBar.scrollPrevious')}
            title={t('sceneBar.scrollPrevious')}
            disabled={!tabScrollState.canScrollBackward}
            onClick={() => scrollTabsByPage(-1)}
            data-openbitfun-component="scene-bar"
            data-openbitfun-part="scrollPrevious"
          >
            <Icon name="chevron-left" size="sm" aria-hidden="true" />
          </button>
        )}

        <TabGroup
          ref={tabsRef}
          className="openbitfun-scene-bar__tabs"
          aria-label={t('sceneBar.tabsLabel')}
          items={tabItems}
          renderItem={(item, node) => {
            const tabId = item.value as SceneTabId;
            const tab = openTabs.find(candidate => candidate.id === tabId);
            const resource = tab?.contentId ? resources[tab.contentId] : undefined;
            const title = resource?.target.kind === 'file' ? [resource.scope.surfaceId, resource.scope.remoteConnectionId, resource.target.path].filter(Boolean).join(' · ') : undefined;
            return <div className="openbitfun-scene-bar__item" draggable title={title}
              data-scene-tab-id={tabId}
              data-canvas-drop-position={activeCanvasDrop?.target?.tabId === tabId ? activeCanvasDrop.target.placement : undefined}
              onContextMenu={event => handleContextMenu(event, tabId)}
              onDragStart={event => { draggingTab.current = tabId; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-openbitfun-scene', tabId); if (tab?.session) beginConversationTransfer(event.dataTransfer, tab.session, tabId); }}
              onDragEnd={() => { draggingTab.current = null; endConversationTransfer(); }}
              onDragOver={event => { if (draggingTab.current && draggingTab.current !== tabId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
              onDrop={event => { if (!draggingTab.current) return; event.preventDefault(); useSceneStore.getState().reorderScene(draggingTab.current, tabId, event.clientX >= event.currentTarget.getBoundingClientRect().x + event.currentTarget.getBoundingClientRect().width / 2 ? 'after' : 'before'); draggingTab.current = null; }}
            >{node}</div>;
          }}
          size="sm"
          value={selectedTabId ?? undefined}
          aria-busy={Boolean(pendingTabId)}
          onValueChange={handleTabValueChange}
          onScroll={handleTabsScroll}
          onWheel={handleTabsWheel}
          onKeyDown={handleTabsKeyDown}
          onMouseDown={handleTabsMouseDown}
          onAuxClick={handleTabsAuxClick}
          data-scene-bar-part="tabs"
        />

        {tabScrollState.hasOverflow && (
          <button
            type="button"
            className="openbitfun-scene-bar__scroll-button"
            aria-label={t('sceneBar.scrollNext')}
            title={t('sceneBar.scrollNext')}
            disabled={!tabScrollState.canScrollForward}
            onClick={() => scrollTabsByPage(1)}
            data-openbitfun-component="scene-bar"
            data-openbitfun-part="scrollNext"
          >
            <Icon name="chevron-right" size="sm" aria-hidden="true" />
          </button>
        )}
      </div>
      {canAcceptCanvasTab && (
        <div className="openbitfun-scene-bar__drop-hint" role="status"
          data-openbitfun-component="scene-bar" data-openbitfun-part="dropHint">
          {/* Both labels reserve the same slot, keeping drop geometry stable. */}
          <span aria-hidden={Boolean(activeCanvasDrop)}>{tComponents('workbench.dragToPopOut')}</span>
          <span aria-hidden={!activeCanvasDrop}>{tComponents('workbench.releaseToPopOut')}</span>
        </div>
      )}
    </div>
  );
};

export default SceneBar;
