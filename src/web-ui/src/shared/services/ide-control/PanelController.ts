/**
 * Panel controller.
 *
 * Implements a subset of IDE control operations focused on opening/closing panels.
 */
import { i18nService } from '@/infrastructure/i18n';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createTab } from '@/shared/utils/tabUtils';
import { useNavSceneStore } from '@/app/stores/navSceneStore';
import {
  IdeController,
  IdeControlEvent,
  IdeControlOptions,
  PanelType,
  PanelConfig,
  PanelOpenConfig,
} from './types';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('PanelController');

 
export class PanelController implements IdeController {
   
  async execute(
    target: IdeControlEvent['target'],
    options?: IdeControlOptions,
    metadata?: IdeControlEvent['metadata']
  ): Promise<void> {
    const panelType = target.type as PanelType;
    const config = target.config || {};
    const position = target.position || 'right';

    
    const openConfig: PanelOpenConfig = {
      panelType,
      position,
      config,
      options,
    };

    
    await this.openPanel(openConfig);

    
    if (metadata?.request_id) {
      this.sendExecutionResult(metadata.request_id, true, `Panel ${panelType} opened successfully`);
    }
  }

   
  async openPanel(config: PanelOpenConfig): Promise<void> {
    const { panelType, config: panelConfig, options } = config;
    if (panelType === 'file-viewer' && !panelConfig?.file_path && !panelConfig?.data?.filePath) {
      useNavSceneStore.getState().openNavScene('file-viewer');
      return;
    }
    const tabDetail = this.buildTabDetail(panelType, panelConfig || {}, options);
    createTab({ ...tabDetail, mode: options?.mode || 'agent' });
  }

   
  async closePanel(panelType: PanelType): Promise<void> {
    
    window.dispatchEvent(
      new CustomEvent('ide-close-panel', {
        detail: { panelType },
      })
    );
  }

   
  async togglePanel(panelType: PanelType): Promise<void> {
    
    window.dispatchEvent(
      new CustomEvent('ide-toggle-panel', {
        detail: { panelType },
      })
    );
  }

   
  focusPanel(panelType: PanelType): void {
    
    window.dispatchEvent(
      new CustomEvent('ide-focus-panel', {
        detail: { panelType },
      })
    );
  }

   
  private buildTabDetail(
    panelType: PanelType,
    config: PanelConfig,
    options?: IdeControlOptions
  ): any {
    const duplicateCheckKey = this.getDuplicateCheckKey(panelType, config);
    const baseDetail = {
      type: panelType,
      title: this.getPanelTitle(panelType, config),
      data: config.data || {},
      metadata: {
        duplicateCheckKey,
      },
      checkDuplicate: options?.check_duplicate ?? true,
      replaceExisting: options?.replace_existing ?? false,
      duplicateCheckKey, 
    };

    
    switch (panelType) {
      case 'git-diff':
        return {
          ...baseDetail,
          data: {
            ...baseDetail.data,
            filePath: config.file_path,
            diffType: config.diff_type || 'staged',
          },
        };

      case 'git-settings':
        return {
          ...baseDetail,
          title: i18nService.getT()('common:tabs.gitSettings'),
        };

      case 'planner':
        return {
          ...baseDetail,
          title: i18nService.getT()('common:tabs.taskPlanner'),
        };

      case 'generative-widget':
        return {
          ...baseDetail,
          title: config.title || 'Widget Preview',
          data: {
            ...baseDetail.data,
            widgetId: config.data?.widgetId,
            title: config.title || config.data?.title,
            widgetCode: config.data?.widgetCode,
            width: config.data?.width,
            height: config.data?.height,
            isSvg: config.data?.isSvg,
          },
        };

      case 'code-editor':
      case 'file-viewer':
      case 'markdown-editor':
      case 'plan-viewer':
        return {
          ...baseDetail,
          data: {
            ...baseDetail.data,
            filePath: config.file_path,
            workspaceId: config.workspace_id,
            workspacePath: config.workspace_path,
          },
        };

      default:
        return baseDetail;
    }
  }

   
  private getPanelTitle(panelType: PanelType, config: PanelConfig): string {
    const t = i18nService.getT();
    switch (panelType) {
      case 'git-settings':
        return t('common:tabs.gitSettings');
      case 'git-diff':
        return config.file_path ? `${t('common:tabs.gitDiff')}: ${config.file_path}` : t('common:tabs.gitDiff');
      case 'planner':
        return t('common:tabs.taskPlanner');
      case 'file-viewer':
        return t('common:tabs.fileBrowser');
      case 'code-editor':
        return config.file_path || t('common:tabs.editor');
      case 'markdown-editor':
        return config.file_path || t('common:tabs.markdown');
      case 'generative-widget':
        return config.title || 'Widget Preview';
      default:
        return panelType;
    }
  }

   
  private getDuplicateCheckKey(panelType: PanelType, config: PanelConfig): string {
    switch (panelType) {
      case 'git-diff':
        return config.file_path ? `git-diff-${config.file_path}` : 'git-diff';
      case 'code-editor':
      case 'markdown-editor':
        return config.file_path ? config.file_path : `${panelType}-${Date.now()}`;
      case 'planner':
      case 'git-settings':
        
        return panelType;
      default:
        return `${panelType}-${Date.now()}`;
    }
  }

   


   
  private sendExecutionResult(requestId: string, success: boolean, message: string): void {
    // Route through the shared adapter so the success branch uses the same
    // transport as the error branch in IdeControlEventBus. report_ide_control_result
    // is LOCAL_ONLY, so both branches settle on the controller's local host.
    api.invoke('report_ide_control_result', {
      request_id: requestId,
      success,
      message: success ? message : undefined,
      error: success ? undefined : message,
      timestamp: Date.now(),
    }).catch((error) => {
      log.error('Failed to send execution result', error);
    });
  }
}
