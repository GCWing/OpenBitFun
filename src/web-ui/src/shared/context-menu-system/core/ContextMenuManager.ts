 

import { ContextResolver } from './ContextResolver';
import { ContextMenuRegistry } from './ContextMenuRegistry';
import { MenuBuilder } from './MenuBuilder';
import { useContextMenuStore } from '../store/ContextMenuStore';
import { MenuContext } from '../types/context.types';
import { MenuItem, MenuOptions, MenuEvents } from '../types/menu.types';
import { globalEventBus } from '../../../infrastructure/event-bus';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ContextMenuManager');

 
export interface ContextMenuManagerConfig {
   
  resolver?: ContextResolver;
   
  registry?: ContextMenuRegistry;
   
  builder?: MenuBuilder;
   
  options?: MenuOptions;
   
  events?: MenuEvents;
   
  debug?: boolean;
}

 
export class ContextMenuManager {
  private static instance: ContextMenuManager;
  
  private resolver: ContextResolver;
  private registry: ContextMenuRegistry;
  private builder: MenuBuilder;
  private options: MenuOptions;
  private events: MenuEvents;
  
  private isShowing: boolean = false;
  private currentContext: MenuContext | null = null;

  private constructor(config: ContextMenuManagerConfig = {}) {
    this.resolver = config.resolver || new ContextResolver();
    this.registry = config.registry || new ContextMenuRegistry();
    this.builder = config.builder || new MenuBuilder();
    this.options = {
      showIcons: true,
      showShortcuts: true,
      enableSearch: false,
      autoAdjustPosition: true,
      closeDelay: 0,
      submenuOpenDelay: 200,
      minWidth: 180,
      ...config.options
    };
    this.events = config.events || {};

    this.init();
  }

   
  static getInstance(config?: ContextMenuManagerConfig): ContextMenuManager {
    if (!ContextMenuManager.instance) {
      ContextMenuManager.instance = new ContextMenuManager(config);
    }
    return ContextMenuManager.instance;
  }

   
  private init(): void {
    
    this.bindGlobalEvents();
  }

   
  private bindGlobalEvents(): void {
    
    document.addEventListener('contextmenu', this.handleContextMenu);

    
    // MenuPopover owns outside dismissal and Escape in the document overlay stack.

    


    
    window.addEventListener('resize', this.handleResize);
  }

   
  private handleContextMenu = async (event: MouseEvent): Promise<void> => {
    
    const target = event.target as HTMLElement;
    
    
    if (this.shouldUseNativeMenu(target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    try {
      await this.show(event);
    } catch (error) {
      log.error('Failed to show menu', error as Error);
    }
  };

   
  async show(event: MouseEvent | React.MouseEvent): Promise<void> {
    if (this.isShowing) {
      this.hide();
    }

    this.isShowing = true;

    try {
      
      const context = this.resolver.resolve(event);
      this.currentContext = context;

      
      if (this.events.onBeforeShow) {
        await this.events.onBeforeShow(context);
      }

      
      globalEventBus.emit('contextmenu:before-show', { context });

      
      const providers = this.registry.findMatchingProviders(context);

      if (providers.length === 0) {
        this.isShowing = false;
        return;
      }

      
      const items = await this.builder.build(providers, context);

      if (items.length === 0) {
        this.isShowing = false;
        return;
      }

      
      const position = this.calculatePosition(event, items);

      
      const store = useContextMenuStore.getState();
      store.showMenu(position, items, context);

      
      if (this.events.onAfterShow) {
        this.events.onAfterShow(context);
      }

      
      globalEventBus.emit('contextmenu:show', { context, items, position });

    } catch (error) {
      log.error('Error in show menu', error as Error);
      this.isShowing = false;
    }
  }

   
  async hide(): Promise<void> {
    if (!this.isShowing) {
      return;
    }

    
    if (this.events.onBeforeHide) {
      await this.events.onBeforeHide();
    }

    
    globalEventBus.emit('contextmenu:before-hide', { context: this.currentContext });

    const store = useContextMenuStore.getState();
    store.hideMenu();

    this.isShowing = false;
    this.currentContext = null;

    
    if (this.events.onAfterHide) {
      this.events.onAfterHide();
    }

    
    globalEventBus.emit('contextmenu:hide', {});
  }

   
  private handleResize = (): void => {
    if (this.isShowing) {
      this.hide();
    }
  };

   
  private calculatePosition(
    event: MouseEvent | React.MouseEvent,
    items: MenuItem[]
  ): { x: number; y: number } {
    const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event;
    let { clientX: x, clientY: y } = nativeEvent;

    if (!this.options.autoAdjustPosition) {
      return { x, y };
    }

    
    const menuWidth = this.options.minWidth || 180;
    const itemHeight = 32; 
    const menuHeight = Math.min(items.length * itemHeight, 400); 

    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    
    if (x + menuWidth > viewportWidth) {
      x = viewportWidth - menuWidth - 10;
    }

    
    if (y + menuHeight > viewportHeight) {
      y = viewportHeight - menuHeight - 10;
    }

    
    x = Math.max(10, x);
    y = Math.max(10, y);

    return { x, y };
  }

   
  private shouldUseNativeMenu(target: HTMLElement): boolean {
    
    const tagName = target.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea') {
      const selection = window.getSelection()?.toString();
      if (!selection) {
        
        
        return false;
      }
    }

    return false;
  }

   
  async showMenu(
    position: { x: number; y: number },
    items: MenuItem[],
    context?: Partial<MenuContext>
  ): Promise<void> {
    
    const fakeEvent = new MouseEvent('contextmenu', {
      clientX: position.x,
      clientY: position.y,
      bubbles: true,
      cancelable: true
    });

    if (context) {
      
      this.currentContext = context as MenuContext;
      const store = useContextMenuStore.getState();
      store.showMenu(position, items, this.currentContext);
      this.isShowing = true;
    } else {
      
      await this.show(fakeEvent);
    }
  }

   
  getRegistry(): ContextMenuRegistry {
    return this.registry;
  }

   
  getResolver(): ContextResolver {
    return this.resolver;
  }

   
  getBuilder(): MenuBuilder {
    return this.builder;
  }

   
  setOptions(options: Partial<MenuOptions>): void {
    this.options = { ...this.options, ...options };
  }

   
  getOptions(): MenuOptions {
    return { ...this.options };
  }

   
  setEvents(events: Partial<MenuEvents>): void {
    this.events = { ...this.events, ...events };
  }

   
  getCurrentContext(): MenuContext | null {
    return this.currentContext;
  }

   
  destroy(): void {
    document.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('resize', this.handleResize);

    this.hide();
  }
}

 
let _instance: ContextMenuManager | null = null;
export let contextMenuManager: ContextMenuManager | undefined;

export function getContextMenuManager(config?: ContextMenuManagerConfig): ContextMenuManager {
  if (!_instance) {
    _instance = ContextMenuManager.getInstance(config || {
      debug: process.env.NODE_ENV === 'development'
    });
    contextMenuManager = _instance;
  }
  return _instance;
}

export function ensureContextMenuManager(): void {
  if (!contextMenuManager) {
    contextMenuManager = getContextMenuManager();
  }
}

