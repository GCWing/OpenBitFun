/**
 * File tab manager.
 *
 * Opens files beside an already open session in their workspace, or in a main tab.
 */
import { resourceFilePath } from '@/app/workbench/contentResourceStore';
import { getEditorType } from '@/infrastructure/language-detection';
import { type LineRange } from '@/shared/editor/LineRange';
import { captureContentScope, openContentInBestTarget } from './workbenchContentService';
import type { ContentResourceScope } from '../types/contentResource';

export interface FileTabOptions {
  scope?: ContentResourceScope;
   
  filePath: string;
   
  fileName?: string;
  /** Owning workspace ID; selects the scope when no explicit scope is given. */
  workspaceId?: string;
  /** Upgrade-only selector for callers that predate workspace IDs. */
  workspacePath?: string;
   
  jumpToLine?: number;
   
  jumpToColumn?: number;
   
  jumpToRange?: LineRange;
  
  navigationToken?: number;
   
  mode?: 'agent' | 'project';
   
  forceNew?: boolean;
   
  splitView?: boolean;
   
  targetGroup?: 'primary' | 'secondary';
  /** Compatibility input; opening no longer depends on a mounted canvas. */
  sceneJustOpened?: boolean;

  /** Explicitly choose a panel type, e.g. opening HTML as source text. */
  editorType?: ReturnType<typeof getEditorType>;
  remoteConnectionId?: string;
}

 
let fileNavigationSequence = 0;

class FileTabManager {
  private static instance: FileTabManager;

  private constructor() {}

  public static getInstance(): FileTabManager {
    if (!FileTabManager.instance) {
      FileTabManager.instance = new FileTabManager();
    }
    return FileTabManager.instance;
  }

   
  public openFile(options: FileTabOptions): void {
    const {
      filePath,
      fileName: providedFileName,
      workspaceId,
      workspacePath,
      jumpToLine,
      jumpToColumn,
      jumpToRange,
      navigationToken,
      editorType: explicitEditorType,
      remoteConnectionId,
    } = options;

    
    const scope = options.scope ?? captureContentScope({ workspaceId, workspacePath, remoteConnectionId });
    const normalizedPath = resourceFilePath(filePath, scope);
    
    
    const fileName = providedFileName || normalizedPath.split(/[/\\]/).pop() || '';
    
    
    const editorType = explicitEditorType || getEditorType(fileName);
    
    
    const finalJumpToRange = jumpToRange;
    
    
    const tabData = {
      filePath: normalizedPath,
      fileName,
      workspaceId: scope.workspaceId,
      workspacePath: scope.workspacePath,
      remoteConnectionId: scope.remoteConnectionId,
      navigationToken: navigationToken ?? ++fileNavigationSequence,
      
      ...(finalJumpToRange && { jumpToRange: finalJumpToRange }),
      
      ...(!finalJumpToRange && jumpToLine && { jumpToLine }),
      ...(!finalJumpToRange && jumpToColumn && { jumpToColumn })
    };
    
    
    const content = {
      type: editorType,
      title: fileName,
      data: tabData,
      metadata: {
        duplicateCheckKey: explicitEditorType ? `${normalizedPath}:${editorType}` : normalizedPath
      }
    };

    
    openContentInBestTarget(content, { scope, replaceExisting: Boolean(explicitEditorType),
      splitView: options.splitView, targetGroup: options.targetGroup });
  }

   
  public openFileAndJump(
    filePath: string,
    line: number,
    column?: number,
    options?: Partial<FileTabOptions>
  ): void {
    this.openFile({
      filePath,
      jumpToLine: line,
      jumpToColumn: column,
      ...options
    });
  }

   
  public openFileAndJumpToRange(
    filePath: string,
    range: LineRange,
    options?: Partial<FileTabOptions>
  ): void {
    this.openFile({
      filePath,
      jumpToRange: range,
      ...options
    });
  }
}


export const fileTabManager = FileTabManager.getInstance();


export type { FileTabManager };
