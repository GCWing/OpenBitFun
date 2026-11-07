import { captureConfirmationAnchor } from '@openbitfun/ui';
 

import { BaseCommand } from '../../BaseCommand';
import { CommandResult } from '../../../types/command.types';
import { MenuContext, ContextType, FileNodeContext } from '../../../types/context.types';
import { globalEventBus } from '../../../../../infrastructure/event-bus';
import { i18nService } from '@/infrastructure/i18n';
import { confirmDanger } from '@/infrastructure/confirm-dialog';

export class DeleteFileCommand extends BaseCommand {
  constructor() {
    const t = i18nService.getT();
    super({
      id: 'file.delete',
      label: t('common:actions.delete'),
      description: t('common:contextMenu.descriptions.delete'),
      icon: 'Trash2',
      shortcut: 'Delete',
      category: 'file'
    });
  }

  canExecute(context: MenuContext): boolean {
    if (context.type === ContextType.FILE_NODE || context.type === ContextType.FOLDER_NODE) {
      return !(context as FileNodeContext).isReadOnly;
    }
    return false;
  }

  async execute(context: MenuContext): Promise<CommandResult> {
    try {
      const t = i18nService.getT();
      const fileContext = context as FileNodeContext;
      
      
      const confirmed = await this.confirmDelete(fileContext);
      if (!confirmed) {
        return this.failure(t('errors:contextMenu.deleteCancelled'));
      }

      globalEventBus.emit('file:delete', { 
        path: fileContext.filePath,
        isDirectory: fileContext.isDirectory 
      });

      return this.success(t('common:contextMenu.status.deleteSuccess'));
    } catch (error) {
      const t = i18nService.getT();
      return this.failure(t('errors:contextMenu.deleteFailed'), error as Error);
    }
  }

  private async confirmDelete(context: FileNodeContext): Promise<boolean> {
    const t = i18nService.getT();
    const message = context.isDirectory
      ? t('common:contextMenu.confirmDeleteFolder', { name: context.fileName })
      : t('common:contextMenu.confirmDeleteFile', { name: context.fileName });

    return confirmDanger(t('common:file.delete'), message, {
      anchor: captureConfirmationAnchor(context.targetElement),
      confirmText: t('common:actions.delete'),
    });
  }
}

