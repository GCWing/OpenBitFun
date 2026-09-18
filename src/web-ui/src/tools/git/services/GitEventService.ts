import { GitWorkspaceScope, gitWorkspaceKey } from '@/infrastructure/api/service-api/GitAPI';
/**
 * Git event service - manages Git event pub/sub
 */

import { globalEventBus } from '../../../infrastructure/event-bus';
import { 
  GitEvent, 
  GitEventType, 
  GitEventListener, 
  GitEventSubscriptionOptions
} from '../types';

export class GitEventService {
  private static instance: GitEventService;
  private readonly eventPrefix = 'git:';

  private constructor() {}

  public static getInstance(): GitEventService {
    if (!GitEventService.instance) {
      GitEventService.instance = new GitEventService();
    }
    return GitEventService.instance;
  }

  on<T extends GitEventType>(
    eventType: T, 
    listener: GitEventListener<T>,
    options?: GitEventSubscriptionOptions
  ): () => void {
    const eventName = this.getEventName(eventType);
    
    const wrappedListener = (data: Extract<GitEvent, { type: T }>['data']) => {
      if (options?.filter && !options.filter(data)) {
        return;
      }

      if (options?.repositoryPath && 'repositoryPath' in data) {
        if (!data.repositoryPath || gitWorkspaceKey(data.repositoryPath) !== gitWorkspaceKey(options.repositoryPath)) {
          return;
        }
      }

      const event = { type: eventType, data } as Extract<GitEvent, { type: T }>;
      listener(event);
    };

    if (options?.once) {
      return globalEventBus.once(eventName, wrappedListener as any);
    }

    return globalEventBus.on(eventName, wrappedListener as any);
  }

  once<T extends GitEventType>(
    eventType: T, 
    listener: GitEventListener<T>
  ): () => void {
    return this.on(eventType, listener, { once: true });
  }

  off<T extends GitEventType>(
    eventType: T, 
    listener: GitEventListener<T>
  ): void {
    const eventName = this.getEventName(eventType);
    globalEventBus.off(eventName, listener as any);
  }

  emit<T extends GitEventType>(
    eventType: T, 
    data: Extract<GitEvent, { type: T }>['data']
  ): void {
    const eventName = this.getEventName(eventType);
    globalEventBus.emit(eventName, data as any);
    globalEventBus.emit('git:event', { type: eventType, data } as any);
  }

  removeAllListeners(eventType?: GitEventType): void {
    if (eventType) {
      const eventName = this.getEventName(eventType);
      globalEventBus.removeAllListeners(eventName);
    } else {
      const gitEventTypes: GitEventType[] = [
        'repository:opened', 'repository:closed', 'repository:changed',
        'status:changed', 'files:changed',
        'branch:changed', 'branch:created', 'branch:deleted',
        'commit:created',
        'operation:started', 'operation:completed', 'operation:failed',
        'conflict:detected', 'conflict:resolved',
        'merge:started', 'merge:completed',
        'push:started', 'push:completed',
        'pull:started', 'pull:completed',
        'state:refreshing', 'state:refreshed', 'state:error'
      ];
      
      gitEventTypes.forEach(type => {
        const eventName = this.getEventName(type);
        globalEventBus.removeAllListeners(eventName);
      });
      
      globalEventBus.removeAllListeners('git:event');
    }
  }

  private getEventName(eventType: GitEventType): string {
    return `${this.eventPrefix}${eventType}`;
  }

  emitBatch(events: Array<{ type: GitEventType; data: any }>): void {
    events.forEach(({ type, data }) => {
      this.emit(type as any, data);
    });
  }

  /**
   * Convenience wrapper for repository-scoped events.
   */
  onRepositoryEvent(
    repositoryPath: GitWorkspaceScope,
    callback: (event: GitEvent) => void
  ): () => void {
    return this.on('repository:changed', callback, { repositoryPath });
  }

  /**
   * Convenience wrapper for status-changed events.
   */
  onStatusChanged(
    repositoryPath: GitWorkspaceScope,
    callback: (event: Extract<GitEvent, { type: 'status:changed' }>) => void
  ): () => void {
    return this.on('status:changed', callback, { repositoryPath });
  }

  /**
   * Convenience wrapper for operation lifecycle events.
   */
  onOperation(
    callback: (event: Extract<GitEvent, { type: 'operation:started' | 'operation:completed' | 'operation:failed' }>) => void
  ): () => void {
    const unsubscribers = [
      this.on('operation:started', callback),
      this.on('operation:completed', callback),
      this.on('operation:failed', callback)
    ];

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }

  /**
   * Wait for a specific event (Promise-based).
   */
  waitFor<T extends GitEventType>(
    eventType: T,
    options?: GitEventSubscriptionOptions & { timeout?: number }
  ): Promise<Extract<GitEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timeout = options?.timeout || 10000;
      
      let unsubscriber: () => void = () => {};
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (unsubscriber) unsubscriber();
      };


      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Git event ${eventType}`));
      }, timeout);


      unsubscriber = this.once(eventType, (event) => {
        cleanup();
        resolve(event);
      });
    });
  }
}


export const gitEventService = GitEventService.getInstance();
