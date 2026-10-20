 

import {
  MenuContext,
  ContextType,
  BaseContext,
  SelectionContext,
  FileNodeContext,
  EditorContext,
  TerminalContext,
  FlowChatContext,
  TextInputContext,
  TabContext,
  PanelHeaderContext,
  EmptySpaceContext,
  CustomContext,
  ContextResolverConfig
} from '../types/context.types';
import {
  findTextInputHost,
  isEditableInput,
  isTextInputReadOnly,
  readTextInputSelection,
  readTextInputSelectionRange,
} from '@/shared/utils/nativeTextEditing';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ContextResolver');

const EDITOR_ACTION_IDS = [
  'editor.action.formatDocument',
  'editor.action.revealDefinition',
  'editor.action.goToTypeDefinition',
  'editor.action.referenceSearch.trigger',
  'editor.action.rename',
  'editor.action.quickFix',
  'editor.action.quickOutline',
  'editor.action.wordHighlight.trigger'
] as const;

function findAttachedMonacoEditor(target: HTMLElement, boundary: HTMLElement): any | null {
  let currentElement: HTMLElement | null = target;
  while (currentElement) {
    if ((currentElement as any).__monacoEditor) {
      return (currentElement as any).__monacoEditor;
    }
    if (currentElement === boundary) {
      break;
    }
    currentElement = currentElement.parentElement;
  }
  return null;
}

 
export class ContextResolver {
  
  private customResolvers: Map<string, (element: HTMLElement, event: MouseEvent) => Partial<MenuContext>>;

  constructor(config: ContextResolverConfig = {}) {
    
    this.customResolvers = new Map();

    
    if (config.customResolvers) {
      config.customResolvers.forEach((resolver, index) => {
        this.customResolvers.set(`custom-${index}`, resolver.resolver);
      });
    }
  }

   
  resolve(event: MouseEvent | React.MouseEvent): MenuContext {
    const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event;
    const target = nativeEvent.target as HTMLElement;
    const resourceOwner = target.closest<HTMLElement>('[data-resource-surface]');

    
    const baseContext: BaseContext = {
      type: ContextType.EMPTY_SPACE,
      event: nativeEvent,
      targetElement: target,
      position: {
        x: nativeEvent.clientX,
        y: nativeEvent.clientY
      },
      timestamp: Date.now(),
      metadata: {},
      resourceScope: resourceOwner ? {
        surfaceId: resourceOwner.dataset.resourceSurface!,
        workspaceId: resourceOwner.dataset.resourceWorkspaceId,
        workspacePath: resourceOwner.dataset.resourceWorkspacePath,
        remoteConnectionId: resourceOwner.dataset.resourceConnectionId,
      } : undefined,
    };

    
    // Inside the file explorer, file-node context must win over stray text selection;
    // otherwise delete/rename commands can silently fail or target the wrong context.
    const inFileExplorer = this.findAreaName(baseContext.targetElement) === 'file-explorer';

    const context =
      (inFileExplorer ? this.resolveFileNode(baseContext) : null) ??
      this.resolveTextInput(baseContext) ??
      this.resolveSelection(baseContext) ??
      this.resolveTerminal(baseContext) ??
      (!inFileExplorer ? this.resolveFileNode(baseContext) : null) ??
      this.resolveEditor(baseContext) ??
      this.resolveFlowChat(baseContext) ??
      this.resolveTab(baseContext) ??
      this.resolvePanelHeader(baseContext) ??
      this.resolveCustom(baseContext) ??
      this.resolveEmptySpace(baseContext);

    return context;
  }

  /**
   * Text fields own a copy/cut/paste/select-all menu even without a selection.
   * A document selection is resolved afterwards, so a field is never reported as
   * a bare text selection.
   */
  private resolveTextInput(base: BaseContext): TextInputContext | null {
    // Monaco and xterm both render hidden textareas; the editor and terminal
    // menus own those surfaces.
    const ownedByEditorOrTerminal =
      this.findClosestWithAttribute(base.targetElement, [
        'data-monaco-editor',
        'data-editor-id',
        'data-terminal-id'
      ]) ||
      this.findClosestByClass(base.targetElement, [
        'monaco-editor',
        'code-editor',
        'editor-container',
        'xterm',
        'openbitfun-terminal',
        'terminal-container'
      ]);

    if (ownedByEditorOrTerminal) {
      return null;
    }

    const element = findTextInputHost(base.targetElement);
    if (!element) {
      return null;
    }

    const tagName = element.tagName.toLowerCase();
    const kind = tagName === 'input' ? 'input' : tagName === 'textarea' ? 'textarea' : 'contenteditable';
    const selectedText = readTextInputSelection(element);

    return {
      ...base,
      type: ContextType.TEXT_INPUT,
      element,
      kind,
      isReadOnly: isTextInputReadOnly(element),
      hasSelection: selectedText.length > 0,
      selectedText,
      selectionStart: isEditableInput(element) ? element.selectionStart ?? undefined : undefined,
      selectionEnd: isEditableInput(element) ? element.selectionEnd ?? undefined : undefined,
      savedSelectionRange: kind === 'contenteditable'
        ? readTextInputSelectionRange(element)
        : undefined
    };
  }

   
  private resolveSelection(base: BaseContext): SelectionContext | null {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (!selectedText) {
      return null;
    }

    
    
    const isInTerminal = this.findClosestWithAttribute(base.targetElement, [
      'data-terminal-id'
    ]) || this.findClosestByClass(base.targetElement, [
      'xterm',
      'terminal',
      'terminal-container'
    ]);
    
    if (isInTerminal || this.findClosestWithAttribute(base.targetElement, [
      'data-monaco-editor',
      'data-editor-id'
    ]) || this.findClosestByClass(base.targetElement, [
      'monaco-editor',
      'code-editor',
      'editor-container'
    ])) {
      return null;
    }

    const isEditable = this.isEditableElement(base.targetElement);

    return {
      ...base,
      type: ContextType.SELECTION,
      selectedText,
      selection,
      isEditable
    };
  }

   
  private resolveTerminal(base: BaseContext): TerminalContext | null {
    
    const terminalElement = this.findClosestWithAttribute(base.targetElement, [
      'data-terminal-id'
    ]) || this.findClosestByClass(base.targetElement, [
      'xterm',
      'openbitfun-terminal',
      'terminal-container'
    ]);

    if (!terminalElement) {
      return null;
    }

    
    const terminalId = terminalElement.getAttribute('data-terminal-id') || 
                       `terminal-${Date.now()}`;
    const sessionId = terminalElement.getAttribute('data-session-id') || undefined;
    const isReadOnly = terminalElement.getAttribute('data-readonly') === 'true';

    
    const selection = window.getSelection();
    const selectedText = selection?.toString() || '';
    const hasSelection = selectedText.length > 0;

    return {
      ...base,
      type: ContextType.TERMINAL,
      terminalId,
      sessionId,
      hasSelection,
      selectedText: hasSelection ? selectedText : undefined,
      isReadOnly
    };
  }

   
  private resolveFileNode(base: BaseContext): FileNodeContext | null {
    
    const isInEditor = this.findClosestWithAttribute(base.targetElement, [
      'data-monaco-editor',
      'data-editor-id'
    ]) || this.findClosestByClass(base.targetElement, [
      'monaco-editor',
      'code-editor',
      'editor-container'
    ]);
    
    if (isInEditor) {
      return null;
    }
    
    
    const fileNode = this.findClosestWithAttribute(base.targetElement, [
      'data-file-path',
      'data-path',
      'data-file'
    ]);

    if (!fileNode) {
      return null;
    }

    const filePath = 
      fileNode.getAttribute('data-file-path') ||
      fileNode.getAttribute('data-path') ||
      fileNode.getAttribute('data-file') ||
      '';

    const fileName = filePath.split(/[/\\]/).pop() || '';
    const isDirectory = fileNode.getAttribute('data-is-directory') === 'true' ||
                       fileNode.classList.contains('directory') ||
                       fileNode.classList.contains('folder');

    
    const container = fileNode.closest('[data-file-list]');
    const selectedFiles = container 
      ? Array.from(container.querySelectorAll('[data-selected="true"]'))
          .map(el => el.getAttribute('data-file-path'))
          .filter(Boolean) as string[]
      : undefined;

    
    let workspacePath: string | undefined;
    let currentElement: HTMLElement | null = fileNode;
    while (currentElement && currentElement !== document.body) {
      const workspaceRoot = currentElement.getAttribute('data-workspace-root');
      if (workspaceRoot) {
        workspacePath = workspaceRoot;
        break;
      }
      currentElement = currentElement.parentElement;
    }

    return {
      ...base,
      type: isDirectory ? ContextType.FOLDER_NODE : ContextType.FILE_NODE,
      filePath,
      fileName,
      isDirectory,
      fileType: this.getFileType(fileName),
      isReadOnly: fileNode.getAttribute('data-readonly') === 'true',
      selectedFiles,
      workspacePath
    };
  }

   
  private resolveEditor(base: BaseContext): EditorContext | null {
    const editorElement = this.findClosestWithAttribute(base.targetElement, [
      'data-editor-id',
      'data-monaco-editor'
    ]) || this.findClosestByClass(base.targetElement, [
      'monaco-editor',
      'code-editor',
      'editor-container'
    ]);

    if (!editorElement) {
      return null;
    }

    const editorId = editorElement.getAttribute('data-editor-id') || undefined;
    const filePath = editorElement.getAttribute('data-file-path') || undefined;
    const isReadOnly = editorElement.getAttribute('data-readonly') === 'true';

    
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || undefined;

    
    let cursorPosition: { line: number; column: number } | undefined;
    let selectionRange: EditorContext['selectionRange'];
    let supportedActionIds: string[] | undefined;
    
    try {
      const monacoGlobal = (window as any).monaco;
      const attachedEditor = findAttachedMonacoEditor(base.targetElement, editorElement);
      
      if (attachedEditor || monacoGlobal?.editor) {
        let targetEditor = attachedEditor;
        
        
        if (!targetEditor && monacoGlobal?.editor) {
          const editors = monacoGlobal.editor.getEditors?.() || [];
          for (const editor of editors) {
            const domNode = editor.getDomNode?.();
            if (domNode) {
              const matches = domNode === editorElement || 
                            domNode.contains(editorElement) || 
                            editorElement.contains(domNode);
              if (matches) {
                targetEditor = editor;
                break;
              }
            }
          }
        }
        
        
        if (targetEditor) {
          supportedActionIds = EDITOR_ACTION_IDS.filter((actionId) => {
            const action = targetEditor.getAction?.(actionId);
            return action?.isSupported?.() === true;
          });
          
          try {
            if (typeof targetEditor.getTargetAtClientPoint === 'function') {
              const mousePosition = targetEditor.getTargetAtClientPoint(
                base.event.clientX,
                base.event.clientY
              );
              
              if (mousePosition?.position) {
                cursorPosition = {
                  line: mousePosition.position.lineNumber,
                  column: mousePosition.position.column
                };
              }
            }
          } catch (_error) {
            
          }
          
          
          if (!cursorPosition) {
            const position = targetEditor.getPosition?.();
            if (position) {
              cursorPosition = {
                line: position.lineNumber,
                column: position.column
              };
            } else {
              
              const monacoSelection = targetEditor.getSelection?.();
              if (monacoSelection) {
                cursorPosition = {
                  line: monacoSelection.startLineNumber,
                  column: monacoSelection.startColumn
                };
              }
            }
          }

          const monacoSelection = targetEditor.getSelection?.();
          if (monacoSelection) {
            const isEmpty =
              typeof monacoSelection.isEmpty === 'function'
                ? monacoSelection.isEmpty()
                : monacoSelection.startLineNumber === monacoSelection.endLineNumber &&
                  monacoSelection.startColumn === monacoSelection.endColumn;
            if (!isEmpty) {
              selectionRange = {
                startLine: monacoSelection.startLineNumber,
                endLine: monacoSelection.endLineNumber,
                startColumn: monacoSelection.startColumn,
                endColumn: monacoSelection.endColumn
              };
            }
          }
        }
      }
      
      
      if (!cursorPosition) {
        const line = editorElement.getAttribute('data-cursor-line');
        const column = editorElement.getAttribute('data-cursor-column');
        if (line && column) {
          cursorPosition = {
            line: parseInt(line, 10),
            column: parseInt(column, 10)
          };
        }
      }
    } catch (error) {
      log.debug('Failed to get cursor position', { error });
    }

    return {
      ...base,
      type: ContextType.EDITOR,
      editorId,
      filePath,
      cursorPosition,
      selectedText,
      selectionRange,
      supportedActionIds,
      isReadOnly
    };
  }

   
  private resolveFlowChat(base: BaseContext): FlowChatContext | null {
    
    const flowChatElement = this.findClosestByClass(base.targetElement, [
      'flow-chat-container',
      'flowchat-container'
    ]);

    if (!flowChatElement) {
      return null;
    }

    
    const toolCard = this.findClosestByClass(base.targetElement, [
      'flow-tool-card',
      'tool-card'
    ]);

    
    const textBlock = this.findClosestByClass(base.targetElement, [
      'flow-text-block',
      'text-block'
    ]);

    const dialogTurn = this.findClosestByClass(base.targetElement, [
      'flow-chat-dialog-turn',
      'dialog-turn',
      'virtual-item-wrapper'
    ]);

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || undefined;

    let contextType = ContextType.FLOWCHAT;
    if (toolCard) {
      contextType = ContextType.FLOWCHAT_TOOL_CARD;
    } else if (textBlock) {
      contextType = ContextType.FLOWCHAT_TEXT_BLOCK;
    }

    return {
      ...base,
      type: contextType,
      selectedText,
      toolCard: toolCard ? this.extractElementData(toolCard) : undefined,
      textBlock: textBlock ? this.extractElementData(textBlock) : undefined,
      dialogTurn: dialogTurn || undefined
    };
  }

   
  private resolveTab(base: BaseContext): TabContext | null {
    const tabElement = this.findClosestWithAttribute(base.targetElement, [
      'data-tab-id'
    ]) || this.findClosestByClass(base.targetElement, [
      'tab',
      'tab-item'
    ]);

    if (!tabElement) {
      return null;
    }

    const tabId = tabElement.getAttribute('data-tab-id') || '';
    const tabTitle = tabElement.getAttribute('data-tab-title') || 
                    tabElement.textContent?.trim() || '';
    const tabType = tabElement.getAttribute('data-tab-type') || undefined;
    const filePath = tabElement.getAttribute('data-file-path') || undefined;
    const workspacePath = tabElement.getAttribute('data-workspace-path') || undefined;
    const isActive = tabElement.classList.contains('active') ||
                    tabElement.getAttribute('data-active') === 'true';
    const isClosable = tabElement.getAttribute('data-closable') !== 'false';

    return {
      ...base,
      type: ContextType.TAB,
      tabId,
      tabTitle,
      tabType,
      filePath,
      workspacePath,
      isActive,
      isClosable
    };
  }

   
  private resolvePanelHeader(base: BaseContext): PanelHeaderContext | null {
    const panelHeader = this.findClosestWithAttribute(base.targetElement, [
      'data-panel-id'
    ]) || this.findClosestByClass(base.targetElement, [
      'panel-header',
      'panel-title'
    ]);

    if (!panelHeader) {
      return null;
    }

    const panelId = panelHeader.getAttribute('data-panel-id') || '';
    const panelTitle = panelHeader.getAttribute('data-panel-title') ||
                      panelHeader.textContent?.trim() || '';
    const isCollapsible = panelHeader.getAttribute('data-collapsible') === 'true';
    const isCollapsed = panelHeader.getAttribute('data-collapsed') === 'true';

    return {
      ...base,
      type: ContextType.PANEL_HEADER,
      panelId,
      panelTitle,
      isCollapsible,
      isCollapsed
    };
  }

   
  private resolveCustom(base: BaseContext): CustomContext | null {
    
    for (const [key, resolver] of this.customResolvers.entries()) {
      try {
        
        const nativeEvent = 'nativeEvent' in base.event ? (base.event as any).nativeEvent : base.event;
        const partial = resolver(base.targetElement, nativeEvent as MouseEvent);
        if (partial) {
          return {
            ...base,
            ...partial,
            type: ContextType.CUSTOM,
            customType: key
          } as CustomContext;
        }
      } catch (error) {
        log.error('Custom resolver failed', { resolverKey: key, error });
      }
    }

    return null;
  }

   
  private resolveEmptySpace(base: BaseContext): EmptySpaceContext {
    
    const area = this.findAreaName(base.targetElement);

    return {
      ...base,
      type: ContextType.EMPTY_SPACE,
      area
    };
  }

   
  private findClosestWithAttribute(element: HTMLElement, attributes: string[]): HTMLElement | null {
    let current: HTMLElement | null = element;
    
    while (current && current !== document.body) {
      for (const attr of attributes) {
        if (current.hasAttribute(attr)) {
          return current;
        }
      }
      current = current.parentElement;
    }
    
    return null;
  }

   
  private findClosestByClass(element: HTMLElement, classNames: string[]): HTMLElement | null {
    let current: HTMLElement | null = element;
    
    while (current && current !== document.body) {
      for (const className of classNames) {
        if (current.classList.contains(className)) {
          return current;
        }
      }
      current = current.parentElement;
    }
    
    return null;
  }

   
  private isEditableElement(element: HTMLElement): boolean {
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea') {
      return true;
    }
    return element.isContentEditable;
  }

   
  private getFileType(fileName: string): string | undefined {
    const ext = fileName.split('.').pop()?.toLowerCase();
    return ext;
  }

   
  private extractElementData(element: HTMLElement): any {
    const data: any = {};
    
    
    Array.from(element.attributes).forEach(attr => {
      if (attr.name.startsWith('data-')) {
        const key = attr.name.substring(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        data[key] = attr.value;
      }
    });

    return Object.keys(data).length > 0 ? data : undefined;
  }

   
  private findAreaName(element: HTMLElement): string | undefined {
    let current: HTMLElement | null = element;
    
    while (current && current !== document.body) {
      const areaName = current.getAttribute('data-area') || 
                      current.getAttribute('data-region');
      if (areaName) {
        return areaName;
      }
      current = current.parentElement;
    }
    
    return undefined;
  }

   
  addCustomResolver(
    name: string,
    _matcher: (element: HTMLElement) => boolean, 
    resolver: (element: HTMLElement, event: MouseEvent) => Partial<MenuContext>
  ): void {
    this.customResolvers.set(name, resolver);
  }

   
  removeCustomResolver(name: string): boolean {
    return this.customResolvers.delete(name);
  }
}

 
export const contextResolver = new ContextResolver();
