 

import { IMenuProvider } from '../types/provider.types';
import { MenuItem } from '../types/menu.types';
import { MenuContext, ContextType, EditorContext } from '../types/context.types';
import { commandExecutor } from '../commands/CommandExecutor';
import { globalEventBus } from '@/infrastructure/event-bus';
import { i18nService } from '@/infrastructure/i18n';
import type { CodeSnippetContext } from '@/shared/types/context';
import { useContextStore } from '@/shared/stores/contextStore';

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const i = normalized.lastIndexOf('/');
  return i >= 0 ? normalized.slice(i + 1) : normalized;
}

function languageHintFromPath(filePath: string): string | undefined {
  const name = fileNameFromPath(filePath);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    rs: 'rust',
    py: 'python',
    go: 'go',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    vue: 'vue',
    svelte: 'svelte',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    ps1: 'powershell',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    c: 'c',
    h: 'c',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    swift: 'swift',
    rb: 'ruby',
    php: 'php',
    cs: 'csharp',
    fs: 'fsharp',
    scala: 'scala',
  };
  return map[ext];
}

function newSnippetContextId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `code-snippet-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function supportsEditorAction(context: EditorContext, actionId: string): boolean {
  return context.supportedActionIds?.includes(actionId) === true;
}

function appendMenuGroup(items: MenuItem[], separatorId: string, group: MenuItem[]): void {
  if (group.length === 0) {
    return;
  }
  if (items.length > 0 && !items[items.length - 1].separator) {
    items.push({ id: separatorId, label: '', separator: true });
  }
  items.push(...group);
}

export class EditorMenuProvider implements IMenuProvider {
  readonly id = 'editor';
  readonly name = i18nService.t('common:contextMenu.editorMenu.name');
  readonly description = i18nService.t('common:contextMenu.editorMenu.description');
  readonly priority = 50;

  matches(context: MenuContext): boolean {
    return context.type === ContextType.EDITOR;
  }

  async getMenuItems(context: MenuContext): Promise<MenuItem[]> {
    const editorContext = context as EditorContext;
    const items: MenuItem[] = [];

    
    if (editorContext.selectedText) {
      items.push({
        id: 'editor-copy',
        label: i18nService.t('common:actions.copy'),
        icon: 'Copy',
        shortcut: 'Ctrl+C',
        command: 'copy',
        onClick: async (ctx) => {
          await commandExecutor.execute('copy', ctx);
        }
      });

      if (!editorContext.isReadOnly) {
        items.push({
          id: 'editor-cut',
          label: i18nService.t('common:actions.cut'),
          icon: 'Scissors',
          shortcut: 'Ctrl+X',
          command: 'cut',
          onClick: async (ctx) => {
            await commandExecutor.execute('cut', ctx);
          }
        });
      }
    }

    
    if (!editorContext.isReadOnly) {
      items.push({
        id: 'editor-paste',
        label: i18nService.t('common:actions.paste'),
        icon: 'Clipboard',
        shortcut: 'Ctrl+V',
        command: 'paste',
        onClick: async (ctx) => {
          await commandExecutor.execute('paste', ctx);
        }
      });
    }

    
    items.push({
      id: 'editor-separator-1',
      label: '',
      separator: true
    });

    items.push({
      id: 'editor-select-all',
      label: i18nService.t('common:actions.selectAll'),
      icon: 'SelectAll',
      shortcut: 'Ctrl+A',
      command: 'select-all',
      onClick: async (ctx) => {
        await commandExecutor.execute('select-all', ctx);
      }
    });

    if (editorContext.selectedText && editorContext.filePath) {
      items.push({
        id: 'editor-separator-add-to-chat',
        label: '',
        separator: true
      });

      items.push({
        id: 'editor-add-to-chat',
        label: i18nService.t('common:editor.addToChat'),
        icon: 'MessageSquarePlus',
        onClick: () => {
          const filePath = editorContext.filePath!;
          const startLine =
            editorContext.selectionRange?.startLine ??
            editorContext.cursorPosition?.line ??
            1;
          const endLine =
            editorContext.selectionRange?.endLine ??
            editorContext.cursorPosition?.line ??
            startLine;
          const context: CodeSnippetContext = {
            type: 'code-snippet',
            id: newSnippetContextId(),
            timestamp: Date.now(),
            filePath,
            fileName: fileNameFromPath(filePath),
            startLine,
            endLine,
            selectedText: editorContext.selectedText!,
            language: languageHintFromPath(filePath),
          };
          useContextStore.getState().addContext(context);
          window.dispatchEvent(
            new CustomEvent('insert-context-tag', { detail: { context } })
          );
        }
      });
    }

    if (
      !editorContext.isReadOnly &&
      editorContext.filePath &&
      supportsEditorAction(editorContext, 'editor.action.formatDocument')
    ) {
      appendMenuGroup(items, 'editor-separator-2', [{
        id: 'editor-format',
        label: i18nService.t('common:editor.formatDocument'),
        icon: 'Code',
        shortcut: 'Shift+Alt+F',
        onClick: () => {
          
          globalEventBus.emit('editor:format-document', {
            filePath: editorContext.filePath,
            editorId: editorContext.editorId
          });
        }
      }]);
    }

    if (editorContext.filePath) {
      const position = editorContext.cursorPosition || { line: 1, column: 1 };
      const navigationItems: MenuItem[] = [];

      if (supportsEditorAction(editorContext, 'editor.action.revealDefinition')) {
        navigationItems.push({
          id: 'editor-goto-definition',
          label: i18nService.t('common:editor.goToDefinition'),
          icon: 'Navigation',
          shortcut: 'F12',
          onClick: () => {
            globalEventBus.emit('editor:goto-definition', {
              filePath: editorContext.filePath,
              line: position.line,
              column: position.column,
              editorId: editorContext.editorId
            });
          }
        });
      }

      if (supportsEditorAction(editorContext, 'editor.action.goToTypeDefinition')) {
        navigationItems.push({
          id: 'editor-goto-type-definition',
          label: i18nService.t('common:editor.goToTypeDefinition'),
          icon: 'FileType',
          onClick: () => {
            globalEventBus.emit('editor:goto-type-definition', {
              filePath: editorContext.filePath,
              line: position.line,
              column: position.column,
              editorId: editorContext.editorId
            });
          }
        });
      }

      if (supportsEditorAction(editorContext, 'editor.action.referenceSearch.trigger')) {
        navigationItems.push({
          id: 'editor-find-references',
          label: i18nService.t('common:editor.findAllReferences'),
          icon: 'Search',
          shortcut: 'Shift+F12',
          onClick: () => {
            globalEventBus.emit('editor:find-references', {
              filePath: editorContext.filePath,
              line: position.line,
              column: position.column,
              editorId: editorContext.editorId
            });
          }
        });
      }

      if (
        !editorContext.isReadOnly &&
        supportsEditorAction(editorContext, 'editor.action.rename')
      ) {
        navigationItems.push({
          id: 'editor-rename-symbol',
          label: i18nService.t('common:editor.renameSymbol'),
          icon: 'Edit',
          shortcut: 'F2',
          onClick: () => {
            globalEventBus.emit('editor:rename-symbol', {
              filePath: editorContext.filePath,
              line: position.line,
              column: position.column,
              editorId: editorContext.editorId
            });
          }
        });
      }

      if (
        !editorContext.isReadOnly &&
        supportsEditorAction(editorContext, 'editor.action.quickFix')
      ) {
        navigationItems.push({
          id: 'editor-code-action',
          label: i18nService.t('common:editor.quickFix'),
          icon: 'Lightbulb',
          shortcut: 'Ctrl+.',
          onClick: () => {
            globalEventBus.emit('editor:code-action', {
              filePath: editorContext.filePath,
              line: position.line,
              column: position.column,
              editorId: editorContext.editorId
            });
          }
        });
      }

      appendMenuGroup(items, 'editor-separator-navigation', navigationItems);

      const moreItems: MenuItem[] = [];

      if (supportsEditorAction(editorContext, 'editor.action.quickOutline')) {
        moreItems.push({
          id: 'editor-document-symbols',
          label: i18nService.t('common:editor.goToSymbol'),
          icon: 'List',
          shortcut: 'Ctrl+Shift+O',
          onClick: () => {
            globalEventBus.emit('editor:document-symbols', {
              filePath: editorContext.filePath,
              editorId: editorContext.editorId
            });
          }
        });
      }

      if (supportsEditorAction(editorContext, 'editor.action.wordHighlight.trigger')) {
        moreItems.push({
          id: 'editor-document-highlight',
          label: i18nService.t('common:editor.highlightAllOccurrences'),
          icon: 'Highlighter',
          onClick: () => {
            globalEventBus.emit('editor:document-highlight', {
              filePath: editorContext.filePath,
              line: position.line,
              column: position.column,
              editorId: editorContext.editorId
            });
          }
        });
      }

      appendMenuGroup(items, 'editor-separator-more', moreItems);
    }

    return items;
  }

  isEnabled(): boolean {
    return true;
  }
}
