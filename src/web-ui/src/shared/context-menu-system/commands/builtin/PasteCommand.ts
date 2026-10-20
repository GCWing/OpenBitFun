 

import { BaseCommand } from '../BaseCommand';
import { CommandResult } from '../../types/command.types';
import { MenuContext, ContextType, SelectionContext, EditorContext, TextInputContext } from '../../types/context.types';
import { MonacoHelper } from '@/shared/helpers/MonacoHelper';
import { insertTextIntoElement, readClipboardText } from '@/shared/utils/nativeTextEditing';
import { dispatchPasteIntoTextInput, focusTextInputTarget } from '../../utils/textInputActions';
import { createLogger } from '@/shared/utils/logger';
import { i18nService } from '@/infrastructure/i18n';

const log = createLogger('PasteCommand');

export class PasteCommand extends BaseCommand {
  constructor() {
    const t = i18nService.getT();
    super({
      id: 'paste',
      label: t('common:actions.paste'),
      description: t('common:contextMenu.descriptions.paste'),
      icon: 'Clipboard',
      shortcut: 'Ctrl+V',
      category: 'edit'
    });
  }

  canExecute(context: MenuContext): boolean {
    
    if (context.type === ContextType.SELECTION) {
      return (context as SelectionContext).isEditable;
    }
    if (context.type === ContextType.EDITOR) {
      return !(context as EditorContext).isReadOnly;
    }
    if (context.type === ContextType.TEXT_INPUT) {
      return !(context as TextInputContext).isReadOnly;
    }
    return false;
  }

  async execute(context: MenuContext): Promise<CommandResult> {
    try {
      const t = i18nService.getT();

      if (context.type === ContextType.TEXT_INPUT) {
        return await this.executeForTextInput(context as TextInputContext);
      }
      
      let text: string;

      const clipboardText = await readClipboardText();
      if (clipboardText === null) {
        return this.failure(t('errors:contextMenu.clipboardUnavailable'));
      }
      text = clipboardText;

      if (!text) {
        return this.failure(t('errors:contextMenu.clipboardEmpty'));
      }

      
      if (context.type === ContextType.EDITOR) {
        return await this.executeForEditor(context as EditorContext, text);
      }

      
      const success = document.execCommand('insertText', false, text);

      if (success) {
        return this.success(t('common:contextMenu.status.pasteSuccess'), { text });
      } else {
        return this.failure(t('errors:contextMenu.pasteFailed'));
      }
    } catch (error) {
      const t = i18nService.getT();
      return this.failure(t('errors:contextMenu.pasteFailed'), error as Error);
    }
  }
  
  /**
   * Field paste is delivered as a native `paste` event first, so rich editors
   * keep their own paste semantics; plain fields fall back to insertion.
   */
  private async executeForTextInput(context: TextInputContext): Promise<CommandResult> {
    const t = i18nService.getT();

    if (context.isReadOnly) {
      return this.failure(t('errors:contextMenu.notEditable'));
    }

    const text = await readClipboardText();
    if (text === null) {
      return this.failure(t('errors:contextMenu.clipboardUnavailable'));
    }

    if (!text) {
      return this.failure(t('errors:contextMenu.clipboardEmpty'));
    }

    const element = focusTextInputTarget(context);
    if (!element) {
      return this.failure(t('errors:contextMenu.pasteFailed'));
    }

    if (dispatchPasteIntoTextInput(element, text) || insertTextIntoElement(element, text)) {
      return this.success(t('common:contextMenu.status.pasteSuccess'), { text });
    }

    return this.failure(t('errors:contextMenu.pasteFailed'));
  }

   
  private async executeForEditor(context: EditorContext, text: string): Promise<CommandResult> {
    try {
      const t = i18nService.getT();
      if (context.isReadOnly) {
        return this.failure(t('errors:contextMenu.readOnlyEditor'));
      }
      
      
      const editor = MonacoHelper.getEditorFromElement(context.targetElement);
      
      if (!editor) {
        log.warn('Editor instance not found, using fallback method');
        
        const success = document.execCommand('insertText', false, text);
        return success
          ? this.success(t('common:contextMenu.status.pasteSuccess'), { text })
          : this.failure(t('errors:contextMenu.pasteFailed'));
      }
      
      
      const selection = editor.getSelection();
      if (selection) {
        editor.executeEdits('paste', [{
          range: selection,
          text: text
        }]);
      } else {
        
        const position = editor.getPosition();
        if (position) {
          editor.executeEdits('paste', [{
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column
            },
            text: text
          }]);
        }
      }
      
      editor.focus();
      
      return this.success(t('common:contextMenu.status.pasteSuccess'), { text });
    } catch (error) {
      log.error('Failed to paste in Monaco editor', error as Error);
      const t = i18nService.getT();
      return this.failure(t('errors:contextMenu.pasteFailed'), error as Error);
    }
  }
}

