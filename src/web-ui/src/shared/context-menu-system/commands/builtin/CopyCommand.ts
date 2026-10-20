 

import { BaseCommand } from '../BaseCommand';
import { CommandResult } from '../../types/command.types';
import { MenuContext, ContextType, SelectionContext, EditorContext, TextInputContext } from '../../types/context.types';
import { executeNativeEditAction, hasNativeTextSelection, isContentEditableHost } from '@/shared/utils/nativeTextEditing';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import { focusTextInputTarget } from '../../utils/textInputActions';
import { i18nService } from '@/infrastructure/i18n';

export class CopyCommand extends BaseCommand {
  constructor() {
    const t = i18nService.getT();
    super({
      id: 'copy',
      label: t('common:actions.copy'),
      description: t('common:contextMenu.descriptions.copy'),
      icon: 'Copy',
      shortcut: 'Ctrl+C',
      category: 'edit'
    });
  }

  canExecute(context: MenuContext): boolean {
    
    if (context.type === ContextType.SELECTION) {
      const selectionContext = context as SelectionContext;
      return !!selectionContext.selectedText;
    }
    
    if (context.type === ContextType.EDITOR) {
      const editorContext = context as EditorContext;
      return !!editorContext.selectedText;
    }

    if (context.type === ContextType.TEXT_INPUT) {
      return (context as TextInputContext).hasSelection;
    }
    
    return false;
  }

  async execute(context: MenuContext): Promise<CommandResult> {
    try {
      const t = i18nService.getT();

      if (context.type === ContextType.TEXT_INPUT) {
        return await this.executeForTextInput(context as TextInputContext);
      }
      
      let text: string | undefined;
      
      if (context.type === ContextType.SELECTION) {
        const selectionContext = context as SelectionContext;
        text = selectionContext.selectedText;
      } else if (context.type === ContextType.EDITOR) {
        const editorContext = context as EditorContext;
        text = editorContext.selectedText;
      }

      if (!text) {
        return this.failure(t('errors:contextMenu.noSelection'));
      }

      
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return this.success(t('common:contextMenu.status.copySuccess'), { text });
      } else {
        
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);

        if (success) {
          return this.success(t('common:contextMenu.status.copySuccess'), { text });
        } else {
          return this.failure(t('errors:contextMenu.copyFailed'));
        }
      }
    } catch (error) {
      const t = i18nService.getT();
      return this.failure(t('errors:contextMenu.copyFailed'), error as Error);
    }
  }

  /**
   * A `contenteditable` host copies through the browser so rich editors can
   * serialize their own payload (composer tokens, markdown source). Plain fields
   * copy their captured selection text directly.
   */
  private async executeForTextInput(context: TextInputContext): Promise<CommandResult> {
    const t = i18nService.getT();
    const text = context.selectedText;

    if (!text) {
      return this.failure(t('errors:contextMenu.noSelection'));
    }

    const element = focusTextInputTarget(context);
    if (
      element
      && isContentEditableHost(element)
      && hasNativeTextSelection(element)
      && executeNativeEditAction(element, 'copy')
    ) {
      return this.success(t('common:contextMenu.status.copySuccess'), { text });
    }

    if (await copyTextToClipboard(text)) {
      return this.success(t('common:contextMenu.status.copySuccess'), { text });
    }

    return this.failure(t('errors:contextMenu.copyFailed'));
  }
}

