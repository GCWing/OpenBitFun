/**
 * Notification service.
 *
 * Provides a typed facade over the notification store to create and control
 * toast/progress/persistent notifications.
 */
import { notificationStore } from '../store/NotificationStore';
import {
  Notification,
  NotificationType,
  ToastOptions,
  ProgressOptions,
  PersistentOptions,
  SilentOptions,
  LoadingOptions,
  ProgressController,
  LoadingController,
  ProgressMode
} from '../types';
import { i18nService } from '@/infrastructure/i18n/core/I18nService';

class NotificationService {
  private idCounter = 0;

   
  private generateId(): string {
    return `notification-${Date.now()}-${++this.idCounter}`;
  }

   
  success(message: string, options?: ToastOptions): string {
    return this.toast('success', message, options);
  }

   
  error(message: string, options?: ToastOptions): string {
    return this.toast('error', message, {
      ...options,
      duration: options?.duration ?? 0
    });
  }

   
  warning(message: string, options?: ToastOptions): string {
    return this.toast('warning', message, options);
  }

   
  info(message: string, options?: ToastOptions): string {
    return this.toast('info', message, options);
  }

   
  private toast(type: NotificationType, message: string, options?: ToastOptions): string {
    const id = this.generateId();
    const state = notificationStore.getState();
    
    const notification: Notification = {
      id,
      type,
      variant: 'toast',
      title: options?.title || this.getDefaultTitle(type),
      message,
      messageNode: options?.messageNode,
      timestamp: Date.now(),
      duration: options?.duration ?? state.config.defaultDuration,
      closable: options?.closable ?? true,
      actions: options?.actions,
      metadata: options?.metadata,
      read: false,
      status: 'active'
    };

    notificationStore.addNotification(notification);

    
    // Presentation owns the timeout. A queued toast must not expire before
    // it has appeared, including while a modal keeps the notification inert.

    return id;
  }

   
  progress(options: ProgressOptions): ProgressController {
    const id = this.generateId();

    
    let progressMode: ProgressMode = 'percentage';
    if (options.progressMode) {
      progressMode = options.progressMode;
    } else if (options.textOnly) {
      progressMode = 'text-only';
    } else if (options.total !== undefined) {
      progressMode = 'fraction';
    }

    const notification: Notification = {
      id,
      type: 'info',
      variant: 'progress',
      title: options.title,
      message: options.message,
      timestamp: Date.now(),
      progress: options.initialProgress ?? 0,
      progressText: options.message,
      progressMode,
      current: options.initialCurrent ?? 0,
      total: options.total,
      textOnly: options.textOnly ?? false,  
      cancellable: options.cancellable ?? false,
      onCancel: options.onCancel,
      duration: 0, 
      closable: false, 
      metadata: options.metadata,
      read: false,
      status: 'active'
    };

    notificationStore.addNotification(notification);

    
    return this.createProgressController(id, progressMode, options.total);
  }

   
  private createProgressController(id: string, _mode: ProgressMode = 'percentage', total?: number): ProgressController {
    return {
      id,
      update: (progress: number, text?: string) => {
        const updates: Partial<Notification> = {
          progress: Math.max(0, Math.min(100, progress))
        };
        if (text) {
          updates.progressText = text;
          updates.message = text; 
        }
        notificationStore.updateNotification(id, updates);
      },
      updateFraction: (current: number, newTotal?: number, text?: string) => {
        const actualTotal = newTotal ?? total ?? 100;
        const progress = actualTotal > 0 ? (current / actualTotal) * 100 : 0;
        
        const updates: Partial<Notification> = {
          current,
          total: actualTotal,
          progress: Math.max(0, Math.min(100, progress))
        };
        
        if (text) {
          updates.progressText = text;
          updates.message = text;
        }
        
        notificationStore.updateNotification(id, updates);
      },
      complete: (message?: string) => {
        
        notificationStore.removeNotification(id);
        
        
        if (message) {
          this.success(message);
        }
      },
      fail: (message?: string) => {
        
        notificationStore.removeNotification(id);
        
        
        if (message) {
          this.error(message);
        }
      },
      cancel: () => {
        
        notificationStore.removeNotification(id);
      }
    };
  }

   
  persistent(options: PersistentOptions): string {
    const id = this.generateId();

    const notification: Notification = {
      id,
      type: options.type,
      variant: 'persistent',
      title: options.title,
      message: options.message,
      timestamp: Date.now(),
      duration: 0, 
      closable: options.closable ?? true,
      actions: options.actions,
      metadata: options.metadata,
      read: false,
      status: 'active'
    };

    notificationStore.addNotification(notification);

    return id;
  }

   
  silent(options: SilentOptions): string {
    const id = this.generateId();

    const notification: Notification = {
      id,
      type: options.type || 'info',
      variant: 'silent',
      title: options.title,
      message: options.message,
      timestamp: Date.now(),
      duration: 0,
      closable: true,
      metadata: options.metadata,
      read: false,
      status: 'active'
    };

    notificationStore.addNotification(notification);

    return id;
  }

   
  loading(options: LoadingOptions): LoadingController {
    const id = this.generateId();

    const notification: Notification = {
      id,
      type: 'info',
      variant: 'loading',
      title: options.title,
      message: options.message,
      timestamp: Date.now(),
      cancellable: options.cancellable ?? false,
      onCancel: options.onCancel,
      duration: 0, 
      closable: false, 
      metadata: options.metadata,
      read: false,
      status: 'active'
    };

    notificationStore.addNotification(notification);

    
    return this.createLoadingController(id);
  }

   
  private createLoadingController(id: string): LoadingController {
    return {
      id,
      updateMessage: (message: string) => {
        notificationStore.updateNotification(id, {
          message
        });
      },
      complete: (message?: string) => {
        
        notificationStore.removeNotification(id);
        
        
        if (message) {
          this.success(message);
        }
      },
      fail: (message?: string) => {
        
        notificationStore.removeNotification(id);
        
        
        if (message) {
          this.error(message);
        }
      },
      cancel: () => {
        
        notificationStore.removeNotification(id);
      }
    };
  }

   
  update(id: string, updates: Partial<Notification>): void {
    notificationStore.updateNotification(id, updates);
  }

   
  dismiss(id: string): void {
    notificationStore.removeNotification(id);
  }

   
  dismissAll(): void {
    notificationStore.clearActiveNotifications();
  }

   
  markAsRead(id: string): void {
    notificationStore.markAsRead(id);
  }

   
  markAllAsRead(): void {
    notificationStore.markAllAsRead();
  }

   
  deleteFromHistory(id: string): void {
    notificationStore.removeFromHistory(id);
  }

   
  clearHistory(): void {
    notificationStore.clearHistory();
  }

   
  toggleCenter(open?: boolean): void {
    notificationStore.toggleCenter(open);
  }

   
  private getDefaultTitle(type: NotificationType): string {
    const titles: Record<NotificationType, string> = {
      success: i18nService.t('common:status.success'),
      error: i18nService.t('common:status.error'),
      warning: i18nService.t('common:status.warning'),
      info: i18nService.t('common:status.info')
    };
    return titles[type];
  }
}


export const notificationService = new NotificationService();
