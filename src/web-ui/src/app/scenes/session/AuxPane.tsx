/**
 * AuxPane — AI Agent scene right pane.
 * Hosts ContentCanvas with tab management for editor views and visualizations.
 *
 * Renamed from panels/ContentPanel. All logic preserved.
 */

import { forwardRef, useEffect, useRef, useImperativeHandle, useCallback, useSyncExternalStore } from 'react';
import { Maximize2, Minimize2, SquareDashed } from 'lucide-react';
import { Icon, IconButton, Tooltip } from '@openbitfun/ui';
import { ContentCanvas, useCanvasStore } from '../../components/panels/content-canvas';
import { usePanelTabCoordinator } from '../../components/panels/content-canvas/hooks/usePanelTabCoordinator';
import { TAB_EVENTS } from '../../components/panels/content-canvas/types';
import { collapseSessionAuxPane, expandSessionAuxPane, hideSessionAuxPane } from './sessionPanelLayout';
import { switchAgentCanvasScope } from '../../components/panels/content-canvas/stores';
import { useI18n } from '@/infrastructure/i18n';
import type { PanelContent as OldPanelContent } from '../../components/panels/base/types';
import type { PanelContent } from '../../components/panels/content-canvas/types';
import { createLogger } from '@/shared/utils/logger';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { isCanvasTabVisibleForSession } from '../../components/panels/content-canvas/types';

import './AuxPane.scss';

const log = createLogger('AuxPane');

export interface AuxPaneRef {
  addTab: (content: OldPanelContent) => void;
  switchToTab: (tabId: string) => void;
  findTabByMetadata: (metadata: Record<string, any>) => { tabId: string } | null;
  updateTabContent: (tabId: string, content: OldPanelContent) => void;
  closeAllTabs: () => void;
}

interface AuxPaneProps {
  workspacePath?: string;
  isSceneActive?: boolean;
  terminalResizeSuspended?: boolean;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

const AuxPane = forwardRef<AuxPaneRef, AuxPaneProps>(
  ({ workspacePath, isSceneActive = true, terminalResizeSuspended = false, isFullscreen = false, onToggleFullscreen }, ref) => {
    const { t } = useI18n('components');
    const activeSessionId = useSyncExternalStore(
      flowChatStore.subscribe.bind(flowChatStore),
      () => flowChatStore.getState().activeSessionId,
      () => flowChatStore.getState().activeSessionId,
    );

    // Fine-grained selectors so unrelated store changes do not re-render.
    const addTab = useCanvasStore(state => state.addTab);
    const switchToTab = useCanvasStore(state => state.switchToTab);
    const findTabByMetadata = useCanvasStore(state => state.findTabByMetadata);
    const updateTabContent = useCanvasStore(state => state.updateTabContent);
    const closeAllTabs = useCanvasStore(state => state.closeAllTabs);
    const primaryGroup = useCanvasStore(state => state.primaryGroup);
    const secondaryGroup = useCanvasStore(state => state.secondaryGroup);
    const tertiaryGroup = useCanvasStore(state => state.tertiaryGroup);
    const canvasScopeKey = useCanvasStore(state => state.scopeKey);
    const { expandPanel } = usePanelTabCoordinator({
      visibleTabCount: [primaryGroup, secondaryGroup, tertiaryGroup]
        .reduce((count, group) => count + group.tabs.filter(tab =>
          !tab.isHidden && isCanvasTabVisibleForSession(tab, activeSessionId),
        ).length, 0),
      scopeKey: canvasScopeKey,
      expandEventName: TAB_EVENTS.EXPAND_RIGHT_PANEL,
      onExpand: expandSessionAuxPane,
      onCollapse: collapseSessionAuxPane,
    });

    const convertContent = useCallback((oldContent: OldPanelContent): PanelContent => {
      return {
        type: oldContent.type,
        title: oldContent.title,
        data: oldContent.data,
        metadata: oldContent.metadata,
      };
    }, []);

    useImperativeHandle(ref, () => ({
      addTab: (content: OldPanelContent) => {
        addTab(convertContent(content), 'active');
        expandPanel();
      },
      switchToTab: (tabId: string) => {
        if (primaryGroup.tabs.find(t => t.id === tabId)) {
          switchToTab(tabId, 'primary');
          expandPanel();
        } else if (secondaryGroup.tabs.find(t => t.id === tabId)) {
          switchToTab(tabId, 'secondary');
          expandPanel();
        }
      },
      findTabByMetadata: (metadata: Record<string, any>) => {
        const result = findTabByMetadata(metadata);
        return result ? { tabId: result.tab.id } : null;
      },
      updateTabContent: (tabId: string, content: OldPanelContent) => {
        if (primaryGroup.tabs.find(t => t.id === tabId)) {
          updateTabContent(tabId, 'primary', convertContent(content));
        } else if (secondaryGroup.tabs.find(t => t.id === tabId)) {
          updateTabContent(tabId, 'secondary', convertContent(content));
        }
      },
      closeAllTabs: () => {
        closeAllTabs();
      },
    }), [
      addTab,
      switchToTab,
      findTabByMetadata,
      updateTabContent,
      closeAllTabs,
      primaryGroup.tabs,
      secondaryGroup.tabs,
      convertContent,
      expandPanel,
    ]);

    const prevScopeKeyRef = useRef<string | undefined>(undefined);

    const syncAgentCanvasScope = useCallback((next: string | undefined) => {
      const prev = prevScopeKeyRef.current;
      if (prev === next) return;

      log.debug('Active session changed, swapping agent canvas snapshot', {
        from: prev ?? '(none)',
        to: next ?? '(none)',
      });
      prevScopeKeyRef.current = next;
      switchAgentCanvasScope(next ?? null);
    }, []);

    useEffect(() => {
      syncAgentCanvasScope(flowChatStore.getState().activeSessionId ?? undefined);
      // FlowChatStore notifies synchronously while a session switch is still in
      // progress. Swap the canvas before callers can open content for the target
      // session; the store itself ignores a swap to the scope already live.
      return flowChatStore.subscribe(state => {
        syncAgentCanvasScope(state.activeSessionId ?? undefined);
      });
    }, [syncAgentCanvasScope]);

    const handleInteraction = useCallback(async (itemId: string, userInput: string) => {
      log.debug('Panel interaction', { itemId, userInput });
    }, []);

    const handleBeforeClose = useCallback(async (_content: any) => {
      return true;
    }, []);

    return (
      <div data-openbitfun-component="aux-pane" data-openbitfun-part="root" className="openbitfun-aux-pane">
        <ContentCanvas
          workspacePath={workspacePath}
          mode="agent"
          isSceneActive={isSceneActive}
          onReveal={expandPanel}
          onCollapsePanel={hideSessionAuxPane}
          toolbarActions={(
            <>
              {onToggleFullscreen && (
                <Tooltip content={t(isFullscreen ? 'canvas.restorePanel' : 'canvas.maximizePanel')} placement="bottom">
                  <IconButton
                    size="sm"
                    aria-label={t(isFullscreen ? 'canvas.restorePanel' : 'canvas.maximizePanel')}
                    aria-pressed={isFullscreen}
                    icon={<Icon glyph={isFullscreen ? Minimize2 : Maximize2} size="sm" />}
                    onClick={event => {
                      event.stopPropagation();
                      onToggleFullscreen();
                    }}
                  />
                </Tooltip>
              )}
              <Tooltip content={t('canvas.hidePanel')} placement="bottom">
                <IconButton
                  size="sm"
                  aria-label={t('canvas.hidePanel')}
                  icon={<Icon glyph={SquareDashed} size="sm" />}
                  onClick={event => {
                    event.stopPropagation();
                    hideSessionAuxPane();
                  }}
                />
              </Tooltip>
            </>
          )}
          onInteraction={handleInteraction}
          onBeforeClose={handleBeforeClose}
          terminalResizeSuspended={terminalResizeSuspended}
          missionControlEnabled={false}
          emptyState={
            <div
              className="openbitfun-aux-pane__empty-state"
              data-openbitfun-component="aux-pane"
              data-openbitfun-part="emptyState"
            >
              {t('canvas.noContentOpen')}
            </div>
          }
        />
      </div>
    );
  }
);

AuxPane.displayName = 'AuxPane';

export default AuxPane;
