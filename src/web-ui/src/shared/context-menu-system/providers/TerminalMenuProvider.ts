 

import { IMenuProvider } from '../types/provider.types';
import { MenuItem } from '../types/menu.types';
import { MenuContext, ContextType, TerminalContext } from '../types/context.types';
import { globalEventBus } from '@/infrastructure/event-bus';
import { i18nService } from '@/infrastructure/i18n';
export class TerminalMenuProvider implements IMenuProvider {
  readonly id = 'terminal';
  readonly name = i18nService.t('common:contextMenu.terminalMenu.name');
  readonly description = i18nService.t('common:contextMenu.terminalMenu.description');
  readonly priority = 60;

  matches(context: MenuContext): boolean {
    return context.type === ContextType.TERMINAL;
  }

  async getMenuItems(context: MenuContext): Promise<MenuItem[]> {
    const terminalContext = context as TerminalContext;
    const items: MenuItem[] = [];
    const isReadOnly = terminalContext.isReadOnly ?? false;

    
    items.push({
      id: 'terminal-copy',
      label: i18nService.t('common:actions.copy'),
      icon: 'Copy',
      shortcut: 'Ctrl+Shift+C',
      disabled: !terminalContext.hasSelection,
      onClick: () => {
        globalEventBus.emit('terminal:copy', {
          terminalId: terminalContext.terminalId,
          sessionId: terminalContext.sessionId,
          selectedText: terminalContext.selectedText
        });
      }
    });

    
    if (!isReadOnly) {
      items.push({
        id: 'terminal-paste',
        label: i18nService.t('common:actions.paste'),
        icon: 'Clipboard',
        shortcut: 'Ctrl+Shift+V',
        onClick: () => {
          globalEventBus.emit('terminal:paste', {
            terminalId: terminalContext.terminalId,
            sessionId: terminalContext.sessionId
          });
        }
      });
    }

    
    items.push({
      id: 'terminal-separator-1',
      label: '',
      separator: true
    });

    
    items.push({
      id: 'terminal-select-all',
      label: i18nService.t('common:actions.selectAll'),
      icon: 'SelectAll',
      shortcut: 'Ctrl+Shift+A',
      onClick: () => {
        globalEventBus.emit('terminal:select-all', {
          terminalId: terminalContext.terminalId,
          sessionId: terminalContext.sessionId
        });
      }
    });

    
    if (!isReadOnly) {
      
      items.push({
        id: 'terminal-separator-2',
        label: '',
        separator: true
      });

      
      items.push({
        id: 'terminal-clear',
        label: i18nService.t('common:contextMenu.terminalMenu.clearTerminal'),
        icon: 'Trash2',
        onClick: () => {
          globalEventBus.emit('terminal:clear', {
            terminalId: terminalContext.terminalId,
            sessionId: terminalContext.sessionId
          });
        }
      });
    }

    return items;
  }

  isEnabled(): boolean {
    return true;
  }
}
