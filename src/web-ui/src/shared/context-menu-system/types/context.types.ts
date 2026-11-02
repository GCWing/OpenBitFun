 
/**
 * Context menu context types.
 *
 * A `MenuContext` describes what the user interacted with when opening the menu
 * (selection, file tree node, editor, etc.).
 */
import type { ContentResourceScope } from '@/shared/types/contentResource';

export enum ContextType {
   
  SELECTION = 'selection',
   
  FILE_NODE = 'file_node',
   
  FOLDER_NODE = 'folder_node',
   
  EDITOR = 'editor',
   
  TERMINAL = 'terminal',
   
  FLOWCHAT = 'flowchat',
   
  FLOWCHAT_TOOL_CARD = 'flowchat_tool_card',
   
  FLOWCHAT_TEXT_BLOCK = 'flowchat_text_block',

  /** Editable text field: `<input>`, `<textarea>`, or a `contenteditable` host. */
  TEXT_INPUT = 'text_input',
   
  EMPTY_SPACE = 'empty_space',
   
  TAB = 'tab',
   
  PANEL_HEADER = 'panel_header',
   
  CUSTOM = 'custom'
}

/**
 * Base shape shared by all menu context variants.
 */
export interface BaseContext {
   
  type: ContextType;
   
  event: MouseEvent | React.MouseEvent;
   
  targetElement: HTMLElement;
   
  position: {
    x: number;
    y: number;
  };
   
  timestamp: number;
   
  metadata?: Record<string, any>;
  resourceScope?: ContentResourceScope;
}

 
export interface SelectionContext extends BaseContext {
  type: ContextType.SELECTION;
   
  selectedText: string;
   
  selection: Selection | null;
   
  isEditable: boolean;
}

 
export interface FileNodeContext extends BaseContext {
  type: ContextType.FILE_NODE | ContextType.FOLDER_NODE;
   
  filePath: string;
   
  fileName: string;
   
  fileType?: string;
   
  isDirectory: boolean;
   
  isReadOnly?: boolean;
   
  selectedFiles?: string[];
   
  workspacePath?: string;
}

 
export interface EditorContext extends BaseContext {
  type: ContextType.EDITOR;
   
  editorId?: string;
   
  filePath?: string;
   
  cursorPosition?: {
    line: number;
    column: number;
  };
   
  selectedText?: string;

  /** Monaco selection range when the user has a non-empty selection in the editor. */
  selectionRange?: {
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  };

  /** Monaco actions supported by the concrete editor at menu-open time. */
  supportedActionIds?: string[];
   
  isReadOnly?: boolean;
}

 
export interface TerminalContext extends BaseContext {
  type: ContextType.TERMINAL;
   
  terminalId: string;
   
  sessionId?: string;
   
  hasSelection: boolean;
   
  selectedText?: string;
   
  isReadOnly?: boolean;
}

 
export interface FlowChatContext extends BaseContext {
  type: ContextType.FLOWCHAT | ContextType.FLOWCHAT_TOOL_CARD | ContextType.FLOWCHAT_TEXT_BLOCK;
   
  dialogTurn?: any;
   
  modelRound?: any;
   
  textBlock?: any;
   
  toolCard?: any;
   
  userMessage?: any;
   
  selectedText?: string;
}

 
/**
 * Text field context for the chat composer, search fields, settings inputs and
 * any other `contenteditable` surface. The editable host can be an ancestor of
 * the right-clicked node, so it is carried explicitly.
 */
export interface TextInputContext extends BaseContext {
  type: ContextType.TEXT_INPUT;

  element: HTMLElement;

  kind: 'input' | 'textarea' | 'contenteditable';

  isReadOnly: boolean;

  hasSelection: boolean;

  selectedText: string;

  /** Selection captured when the menu opened, before menu focus moves away. */
  selectionStart?: number;

  selectionEnd?: number;

  savedSelectionRange?: Range;
}

export interface TabContext extends BaseContext {
  type: ContextType.TAB;
   
  tabId: string;
   
  tabTitle: string;
   
  tabType?: string;
   
  filePath?: string;
   
  workspacePath?: string;
   
  isActive: boolean;
   
  isClosable: boolean;
}

 
export interface PanelHeaderContext extends BaseContext {
  type: ContextType.PANEL_HEADER;
   
  panelId: string;
   
  panelTitle: string;
   
  isCollapsible?: boolean;
   
  isCollapsed?: boolean;
}

 
export interface EmptySpaceContext extends BaseContext {
  type: ContextType.EMPTY_SPACE;
   
  area?: string;
}

 
export interface CustomContext extends BaseContext {
  type: ContextType.CUSTOM;
   
  customType: string;
   
  data: any;
}

 
export type MenuContext =
  | SelectionContext
  | FileNodeContext
  | EditorContext
  | TerminalContext
  | FlowChatContext
  | TextInputContext
  | TabContext
  | PanelHeaderContext
  | EmptySpaceContext
  | CustomContext;

 
export type ContextMatcher = (context: MenuContext) => boolean;

 
export interface ContextResolverConfig {
   
  debug?: boolean;
   
  customResolvers?: Array<{
    matcher: (element: HTMLElement) => boolean;
    resolver: (element: HTMLElement, event: MouseEvent) => Partial<MenuContext>;
  }>;
}
