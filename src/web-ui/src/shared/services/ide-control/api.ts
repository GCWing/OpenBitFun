/**
 * IDE control facade.
 *
 * Thin wrapper around `PanelController` to expose high-level operations to callers.
 */
import { PanelController } from './PanelController';
import {
  PanelType,
  PanelOpenConfig,
  NavigateOptions,
  LayoutType,
  ViewType,
  TabOptions,
} from './types';
import { PanelContent, TabData } from '@/app/components/panels/base/types';
import { type LineRange } from '@/shared/editor/LineRange';
import {
  isLegacyEcosystemCompatibilityDestination,
  resolveSettingsDestination,
} from '@/app/scenes/settings/settingsDestination';
import type { SettingsDestination } from '@/app/scenes/settings/settingsTypes';

const panelController = new PanelController();

 
export const ideControl = {
   
  panel: {
     
    open: async (type: PanelType, config?: Partial<PanelOpenConfig>): Promise<void> => {
      await panelController.openPanel({
        panelType: type,
        position: config?.position || 'right',
        config: config?.config,
        options: config?.options,
      });
    },

     
    close: async (type: PanelType): Promise<void> => {
      await panelController.closePanel(type);
    },

     
    toggle: async (type: PanelType): Promise<void> => {
      await panelController.togglePanel(type);
    },

     
    focus: (type: PanelType): void => {
      panelController.focusPanel(type);
    },
  },

   
  navigation: {
     
    goToFile: async (filePath: string, options?: NavigateOptions): Promise<void> => {
      const { fileTabManager } = await import('@/shared/services/FileTabManager');
      
      const jumpToRange = options?.range || (options?.line ? { start: options.line, end: options.column ? options.line : undefined } : undefined);
      fileTabManager.openFile({
        filePath,
        jumpToRange,
        jumpToLine: !jumpToRange ? options?.line : undefined,
        jumpToColumn: !jumpToRange ? options?.column : undefined,
        mode: 'agent',
      });
    },

     
    goToLine: async (
      filePath: string,
      line: number,
      column?: number
    ): Promise<void> => {
      const { fileTabManager } = await import('@/shared/services/FileTabManager');
      fileTabManager.openFile({
        filePath,
        jumpToLine: line,
        jumpToColumn: column,
        mode: 'agent',
      });
    },

     
    goToRange: async (
      filePath: string,
      range: LineRange
    ): Promise<void> => {
      const { fileTabManager } = await import('@/shared/services/FileTabManager');
      fileTabManager.openFile({
        filePath,
        jumpToRange: range,
        mode: 'agent',
      });
    },

     
    goToSymbol: async (symbol: string, filePath?: string): Promise<void> => {
      
      window.dispatchEvent(
        new CustomEvent('ide-navigate-to-symbol', {
          detail: { symbol, filePath },
        })
      );
    },

     
    back: async (): Promise<void> => {
      window.dispatchEvent(new CustomEvent('ide-navigate-back'));
    },

     
    forward: async (): Promise<void> => {
      window.dispatchEvent(new CustomEvent('ide-navigate-forward'));
    },
  },

   
  layout: {
     
    setLayout: async (layout: LayoutType): Promise<void> => {
      window.dispatchEvent(
        new CustomEvent('ide-set-layout', {
          detail: { layout },
        })
      );
    },

     
    toggleFullscreen: async (): Promise<void> => {
      window.dispatchEvent(new CustomEvent('ide-toggle-fullscreen'));
    },

     
    toggleSidebar: async (side: 'left' | 'right'): Promise<void> => {
      const eventName = side === 'left' ? 'toggle-left-panel' : 'toggle-right-panel';
      window.dispatchEvent(new CustomEvent(eventName));
    },

     
    resizePanel: async (panel: string, size: number): Promise<void> => {
      window.dispatchEvent(
        new CustomEvent('ide-resize-panel', {
          detail: { panel, size },
        })
      );
    },
  },

   
  tab: {
     
    create: async (content: PanelContent, options?: TabOptions): Promise<void> => {
      const { createTab } = await import('@/shared/utils/tabUtils');
      createTab({
        type: content.type,
        title: content.title,
        data: content.data,
        metadata: content.metadata,
        checkDuplicate: options?.checkDuplicate,
        duplicateCheckKey: options?.duplicateCheckKey,
        replaceExisting: options?.replaceExisting,
        mode: options?.mode || 'agent',
      });
    },

     
    close: async (tabId: string): Promise<void> => {
      window.dispatchEvent(
        new CustomEvent('ide-close-tab', {
          detail: { tabId },
        })
      );
    },

     
    closeAll: async (): Promise<void> => {
      window.dispatchEvent(new CustomEvent('ide-close-all-tabs'));
    },

     
    switch: async (tabId: string): Promise<void> => {
      window.dispatchEvent(
        new CustomEvent('ide-switch-tab', {
          detail: { tabId },
        })
      );
    },

     
    find: (_predicate: (tab: TabData) => boolean): TabData | null => {
      
      return null;
    },
  },

   
  view: {
     
    focus: async (view: ViewType): Promise<void> => {
      window.dispatchEvent(
        new CustomEvent('ide-focus-view', {
          detail: { view },
        })
      );
    },

     
    show: async (view: ViewType): Promise<void> => {
      window.dispatchEvent(
        new CustomEvent('ide-show-view', {
          detail: { view },
        })
      );
    },

     
    hide: async (view: ViewType): Promise<void> => {
      window.dispatchEvent(
        new CustomEvent('ide-hide-view', {
          detail: { view },
        })
      );
    },

     
    toggle: async (view: ViewType): Promise<void> => {
      window.dispatchEvent(
        new CustomEvent('ide-toggle-view', {
          detail: { view },
        })
      );
    },
  },
};

 
export const quickActions = {
   
  openSettings: (destination?: SettingsDestination | string) => {
    if (isLegacyEcosystemCompatibilityDestination(destination)) {
      void import('@/app/scenes/ecosystem-compatibility/ecosystemCompatibilityStore')
        .then(({ openEcosystemCompatibility }) => {
          openEcosystemCompatibility({ ownerSurface: 'external-sources' });
        });
      return;
    }
    import('@/app/scenes/settings/settingsStore').then(({ useSettingsStore }) => {
      if (destination) {
        useSettingsStore.getState().openDestination(
          typeof destination === 'string'
            ? resolveSettingsDestination(destination)
            : destination,
        );
      }
    });
    window.dispatchEvent(new CustomEvent('scene:open', { detail: { sceneId: 'settings' } }));
  },

   
  openTerminal: (sessionId?: string, workingDirectory?: string) =>
    ideControl.panel.open('terminal', {
      config: {
        session_id: sessionId,
        working_directory: workingDirectory,
      },
    }),

   
  openPlanner: () => ideControl.panel.open('planner'),

   

   
  openGitDiff: (filePath?: string, diffType?: string) =>
    ideControl.panel.open('git-diff', {
      config: {
        file_path: filePath,
        diff_type: diffType || 'staged',
      },
    }),

   
  openFileExplorer: () => ideControl.panel.open('file-viewer'),
};

 
export { PanelController };
export * from './types';
