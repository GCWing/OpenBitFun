/**
 * IDE control types.
 *
 * Defines the operation/event contract used by the panel controller and event bus.
 */
import { PanelContentType } from '@/app/components/panels/base/types';
import { type LineRange } from '@/shared/editor/LineRange';

 
export type IdeControlOperation =
  | 'open_panel'
  | 'close_panel'
  | 'toggle_panel'
  | 'navigate'
  | 'layout'
  | 'tab'
  | 'focus'
  | 'expand';

 
export type PanelType = PanelContentType;

 
export type PanelPosition = 'left' | 'right' | 'bottom' | 'center';

 
export type OperationMode = 'agent' | 'project' | 'git';

 
export interface IdeControlEvent {
   
  operation: IdeControlOperation;
  
   
  target: {
     
    type: string;
     
    id: string;
     
    position?: PanelPosition;
     
    config?: PanelConfig;
  };
  
   
  position?: PanelPosition;
  
   
  options?: IdeControlOptions;
  
   
  metadata?: {
     
    source: string;
     
    timestamp: number;
     
    session_id?: string;
     
    request_id: string;
  };
}

 
export interface PanelConfig {
   
  section?: string;
   
  tab_id?: string;
   
  session_id?: string;
   
  file_path?: string;
   
  data?: Record<string, any>;
   
  workspace_id?: string;
   
  workspace_path?: string;
   
  analysis_type?: string;
   
  diff_type?: string;
   
  working_directory?: string;
  
  
   
  title?: string;
}

export interface IdeControlOptions {
   
  auto_focus?: boolean;
   
  replace_existing?: boolean;
   
  check_duplicate?: boolean;
   
  expand_panel?: boolean;
   
  mode?: OperationMode;
}

 
export interface PanelOpenConfig {
   
  panelType: PanelType;
   
  position?: PanelPosition;
   
  config?: PanelConfig;
   
  options?: IdeControlOptions;
}

 
export interface NavigateOptions {
   
  line?: number;
   
  column?: number;
   
  range?: LineRange;
   
  highlight?: boolean;
   
  select?: boolean;
}

 
export type LayoutType = 'default' | 'focus' | 'zen' | 'split';

 
export type ViewType = 'editor' | 'terminal' | 'sidebar' | 'panel';

 
export interface TabOptions {
   
  checkDuplicate?: boolean;
   
  duplicateCheckKey?: string;
   
  replaceExisting?: boolean;
   
  mode?: OperationMode;
}

 
export interface IdeController {
   
  execute(
    target: IdeControlEvent['target'],
    options?: IdeControlOptions,
    metadata?: IdeControlEvent['metadata']
  ): Promise<void>;
}

 
export interface IdeControlResult {
   
  success: boolean;
   
  message?: string;
   
  request_id?: string;
   
  error?: string;
   
  timestamp?: number;
}
