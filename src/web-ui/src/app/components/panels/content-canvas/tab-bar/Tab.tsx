/**
 * Tab component.
 * Supports preview/active/pinned tab states.
 */

import React, { useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';

import { commandExecutor } from '@/shared/context-menu-system/commands/CommandExecutor';
import { canRevealInExplorer } from '@/shared/context-menu-system/commands/builtin/file/RevealInExplorerCommand';
import { useContextMenuStore } from '@/shared/context-menu-system/store/ContextMenuStore';
import { ContextType, type TabContext } from '@/shared/context-menu-system/types/context.types';
import type { MenuItem } from '@/shared/context-menu-system/types/menu.types';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { isRemoteWorkspace } from '@/shared/types';
import { hasNonFileUriScheme } from '@/shared/utils/pathUtils';
import { isHtmlFilePath } from '@/shared/utils/htmlFilePreview';
import { openFileInBestTarget } from '@/shared/utils/tabUtils';
import type { CanvasTab, EditorGroupId, TabState } from '../types';
import { CanvasStoreModeContext } from '../stores';
import { writeSessionTabDrag } from '@/app/workbench/canvasTabTransfer';
import './Tab.scss';
import { Tooltip } from '@openbitfun/ui';
export interface TabProps {
  /** Standard TabGroup item; this wrapper owns document interactions only. */
  children: React.ReactNode;
  /** Tab data */
  tab: CanvasTab;
  /** Editor group ID */
  groupId: EditorGroupId;
  /** Whether active tab */
  isActive: boolean;
  /** Click callback */
  onClick: () => void;
  /** Double-click callback */
  onDoubleClick: () => void;
  /** Close callback */
  onClose: () => Promise<void> | void;
  /** Pin/unpin callback */
  onPin: () => void;
  /** Drag start callback */
  onDragStart: (e: React.DragEvent) => void;
  /** Drag end callback */
  onDragEnd: () => void;
  /** Whether being dragged */
  isDragging?: boolean;
  /** Pop out as independent scene */
  onPopOut?: () => void;
  /** Close all other tabs in the same group */
  onCloseOthers?: () => Promise<void> | void;
  /** Close all tabs in the same group */
  onCloseAll?: () => Promise<void> | void;
}

/**
 * Get class name for tab state.
 */
const getStateClassName = (state: TabState): string => {
  switch (state) {
    case 'preview':
      return 'is-preview';
    case 'pinned':
      return 'is-pinned';
    default:
      return '';
  }
};

export const Tab: React.FC<TabProps> = ({
  children,
  tab,
  groupId,
  isActive,
  onClick,
  onDoubleClick,
  onClose,
  onPin,
  onDragStart,
  onDragEnd,
  isDragging = false,
  onPopOut,
  onCloseOthers,
  onCloseAll,
}) => {
  const { t } = useTranslation(['components', 'common']);
  const mode = useContext(CanvasStoreModeContext);
  const showMenu = useContextMenuStore(state => state.showMenu);
  const tabData = tab.content.data as { filePath?: string; workspacePath?: string } | undefined;
  const filePath = typeof tabData?.filePath === 'string' ? tabData.filePath : undefined;
  const workspacePath = typeof tabData?.workspacePath === 'string' ? tabData.workspacePath : undefined;
  // The tab's resource scope names the owning workspace by ID; the path is only its IO projection.
  const resourceScope = tab.content.metadata?.resourceScope;
  const owningWorkspace = resourceScope?.workspaceId
    ? workspaceManager.getState().openedWorkspaces.get(resourceScope.workspaceId) ?? workspaceManager.getState().currentWorkspace
    : workspaceManager.getState().currentWorkspace;
  const isRemote = isRemoteWorkspace(owningWorkspace);
  const canUseLocalFileActions = Boolean(filePath) && !isRemote && !hasNonFileUriScheme(filePath || '');
  const isPinned = tab.state === 'pinned';

  // Build tooltip text
  const unsavedSuffix = tab.isDirty ? ` (${t('tabs.unsaved')})` : '';
  const deletedSuffix = tab.fileDeletedFromDisk ? ` - ${t('tabs.fileDeleted')}` : '';
  const titleDisplay = `${tab.title}${deletedSuffix}`;
  const tooltipText = tab.content.data?.filePath
    ? `${tab.content.data.filePath}${deletedSuffix}${unsavedSuffix}`
    : `${titleDisplay}${unsavedSuffix}`;

  // Handle single click - respond immediately
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // TabGroup activates new selections. Clicking the selected tab still needs
    // to focus its editor group, including an inactive split group.
    if (isActive) onClick();
  }, [isActive, onClick]);

  // Handle double click - rely on native onDoubleClick
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick();
  }, [onDoubleClick]);

  // Handle drag start
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      tabId: tab.id,
      sourceGroupId: groupId,
    }));
    e.dataTransfer.effectAllowed = 'move';
    if (onPopOut && mode === 'agent') writeSessionTabDrag(e.dataTransfer, tab.id, groupId);
    onDragStart(e);
  }, [tab.id, groupId, onDragStart, onPopOut, mode]);

  const runCommand = useCallback((commandId: string, context: TabContext) => {
    void commandExecutor.execute(commandId, context);
  }, []);

  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation?.();

    const context: TabContext = {
      type: ContextType.TAB,
      event: e,
      targetElement: e.currentTarget,
      position: { x: e.clientX, y: e.clientY },
      timestamp: Date.now(),
      metadata: {
        groupId,
        tabState: tab.state,
        isDirty: tab.isDirty,
      },
      tabId: tab.id,
      tabTitle: tab.title,
      tabType: tab.content.type,
      filePath,
      workspacePath,
      resourceScope,
      isActive,
      isClosable: true,
    };

    const items: MenuItem[] = [
      {
        id: 'tab-close',
        label: t('tabs.close'),
        icon: 'X',
        onClick: () => {
          void onClose();
        },
      },
      {
        id: 'tab-close-others',
        label: t('tabs.closeOthers'),
        icon: 'X',
        disabled: !onCloseOthers,
        onClick: () => {
          void onCloseOthers?.();
        },
      },
      {
        id: 'tab-close-all',
        label: t('tabs.closeAll'),
        icon: 'X',
        disabled: !onCloseAll,
        onClick: () => {
          void onCloseAll?.();
        },
      },
      {
        id: 'tab-separator-actions',
        label: '',
        separator: true,
      },
      {
        id: 'tab-toggle-pin',
        label: isPinned ? t('tabs.unpin') : t('tabs.pin'),
        icon: 'Pin',
        onClick: onPin,
      },
    ];

    if (onPopOut) {
      items.push({
        id: 'tab-pop-out',
        label: t('tabs.popOut'),
        icon: 'ExternalLink',
        onClick: onPopOut,
      });
    }

    if (filePath) {
      items.push(
        {
          id: 'tab-separator-file',
          label: '',
          separator: true,
        },
        {
          id: 'tab-copy-path',
          label: t('common:file.copyPath'),
          icon: 'Copy',
          onClick: () => runCommand('file.copy-path', context),
        },
        {
          id: 'tab-reveal-file',
          label: t('common:file.reveal'),
          icon: 'FolderOpen',
          disabled: !canRevealInExplorer(context),
          onClick: () => runCommand('file.reveal-in-explorer', context),
        },
      );

      if (isHtmlFilePath(filePath)) {
        items.push({
          id: 'tab-open-html-as-text',
          label: t('common:file.openAsText'),
          icon: 'files',
          disabled: tab.content.type === 'code-editor',
          onClick: () => openFileInBestTarget({
            filePath,
            fileName: tab.title,
            workspacePath,
            scope: resourceScope,
            editorType: 'code-editor',
          }),
        });
        items.push({
          id: 'tab-open-html-in-integrated-browser',
          label: t('common:file.openInIntegratedBrowser'),
          icon: 'PanelRightOpen',
          disabled: tab.content.type === 'html-preview',
          onClick: () => openFileInBestTarget({
            filePath,
            fileName: tab.title,
            workspacePath,
            scope: resourceScope,
            editorType: 'html-preview',
          }),
        });
        items.push({
          id: 'tab-open-html-in-browser',
          label: t('common:file.openInSystemBrowser'),
          icon: 'ExternalLink',
          disabled: !canUseLocalFileActions,
          onClick: () => runCommand('file.open-html-in-browser', context),
        });
      }
    }

    showMenu({ x: e.clientX, y: e.clientY }, items, context);
  }, [
    canUseLocalFileActions,
    filePath,
    groupId,
    isActive,
    isPinned,
    onClose,
    onCloseAll,
    onCloseOthers,
    onPin,
    onPopOut,
    resourceScope,
    runCommand,
    showMenu,
    t,
    tab.content.type,
    tab.id,
    tab.isDirty,
    tab.state,
    tab.title,
    workspacePath,
  ]);

  /** Middle-click closes (same as SceneBar session tabs); skip pinned and pin/popout controls. */
  const handleMiddleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 1) return;
    if (isPinned) return;
    const target = e.target as HTMLElement;
    if (target.closest('.canvas-tab__action-btn') || target.closest('.canvas-tab__popout-btn')) return;
    e.preventDefault();
  }, [isPinned]);

  const handleAuxClick = useCallback((e: React.MouseEvent) => {
    if (e.button !== 1) return;
    if (isPinned) return;
    const target = e.target as HTMLElement;
    if (target.closest('.canvas-tab__action-btn') || target.closest('.canvas-tab__popout-btn')) return;
    e.preventDefault();
    e.stopPropagation();
    void onClose();
  }, [isPinned, onClose]);

  const isTaskDetail = tab.content.type === 'task-detail';

  // Build class names
  const classNames = [
    'canvas-tab',
    isActive && 'is-active',
    tab.isDirty && 'is-dirty',
    tab.fileDeletedFromDisk && 'is-file-deleted',
    isDragging && 'is-dragging',
    getStateClassName(tab.state),
    isTaskDetail && 'is-task-detail',
  ].filter(Boolean).join(' ');

  return (
    <Tooltip content={tooltipText} placement="bottom">
      <div data-openbitfun-product-component="canvas-tab" data-openbitfun-product-part="root" data-openbitfun-group={groupId}
        data-overflow-trigger
        data-openbitfun-state={[
          isActive && 'active',
          isDragging && 'dragging',
          tab.isDirty && 'dirty',
          tab.fileDeletedFromDisk && 'deleted',
          tab.state === 'pinned' && 'pinned',
          tab.state === 'preview' && 'preview',
        ].filter(Boolean).join(' ')}
        className={classNames}
        data-tab-id={tab.id}
        data-tab-title={tab.title}
        data-tab-type={tab.content.type}
        data-active={isActive}
        data-closable="true"
        data-file-path={filePath}
        data-workspace-path={workspacePath}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onMouseDown={handleMiddleMouseDown}
        onAuxClick={handleAuxClick}
        onKeyDown={(event) => {
          if (event.key !== 'Delete' || isPinned) return;
          event.preventDefault();
          event.stopPropagation();
          void onClose();
        }}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={onDragEnd}
      >
        {children}
      </div>
    </Tooltip>
  );
};

Tab.displayName = 'Tab';

export default Tab;
