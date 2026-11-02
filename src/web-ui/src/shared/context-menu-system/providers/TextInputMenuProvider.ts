import { IMenuProvider } from '../types/provider.types';
import { MenuItem } from '../types/menu.types';
import { MenuContext, ContextType, TextInputContext } from '../types/context.types';
import { commandExecutor } from '../commands/CommandExecutor';
import { globalEventBus } from '@/infrastructure/event-bus';
import { i18nService } from '@/infrastructure/i18n';
import { textEditShortcut } from '../utils/textInputActions';

/**
 * Edit menu for text fields (chat composer, search fields, settings inputs).
 * Copy/cut follow the field selection, while paste additionally depends on the
 * field being writable.
 */
export class TextInputMenuProvider implements IMenuProvider {
  readonly id = 'text-input';
  readonly name = i18nService.t('common:contextMenu.textInputMenu.name');
  readonly description = i18nService.t('common:contextMenu.textInputMenu.description');
  readonly priority = 110;

  matches(context: MenuContext): boolean {
    return context.type === ContextType.TEXT_INPUT;
  }

  async getMenuItems(context: MenuContext): Promise<MenuItem[]> {
    const inputContext = context as TextInputContext;
    const canWrite = !inputContext.isReadOnly;
    const canCopy = inputContext.hasSelection;

    return [
      {
        id: 'text-input-copy',
        label: i18nService.t('common:actions.copy'),
        icon: 'Copy',
        shortcut: textEditShortcut('C'),
        command: 'copy',
        disabled: !canCopy,
        onClick: (ctx) => this.runCommand('copy', ctx),
      },
      {
        id: 'text-input-cut',
        label: i18nService.t('common:actions.cut'),
        icon: 'Scissors',
        shortcut: textEditShortcut('X'),
        command: 'cut',
        disabled: !canCopy || !canWrite,
        onClick: (ctx) => this.runCommand('cut', ctx),
      },
      {
        id: 'text-input-paste',
        label: i18nService.t('common:actions.paste'),
        icon: 'Clipboard',
        shortcut: textEditShortcut('V'),
        command: 'paste',
        disabled: !canWrite,
        onClick: (ctx) => this.runCommand('paste', ctx),
      },
      {
        id: 'text-input-separator-1',
        label: '',
        separator: true,
      },
      {
        id: 'text-input-select-all',
        label: i18nService.t('common:actions.selectAll'),
        icon: 'SelectAll',
        shortcut: textEditShortcut('A'),
        command: 'select-all',
        onClick: (ctx) => this.runCommand('select-all', ctx),
      },
    ];
  }

  isEnabled(): boolean {
    return true;
  }

  private runCommand(commandId: string, context: MenuContext): void {
    void commandExecutor.execute(commandId, context).then((result) => {
      if (!result.success && result.message) {
        globalEventBus.emit('toast:error', { message: result.message });
      }
    });
  }
}
