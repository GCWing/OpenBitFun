 

import { create, useStore, type StateCreator } from 'zustand';
import { createContext, useContext } from 'react';
import { devtools, persist } from 'zustand/middleware';
import { ContextItem, ValidationResult } from '../types/context';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ContextStore');



export interface ContextState {
  
  contexts: ContextItem[];
  
  
  validationStates: Map<string, ValidationResult>;
  
  
  validatingIds: Set<string>;
  
  // Actions
  addContext: (item: ContextItem) => void;
  removeContext: (id: string) => void;
  clearContexts: () => void;
  replaceContexts: (contexts: ContextItem[]) => void;
  updateValidation: (id: string, result: ValidationResult) => void;
  setValidating: (id: string, validating: boolean) => void;
  reorderContexts: (startIndex: number, endIndex: number) => void;
  updateContext: (id: string, updates: Partial<ContextItem>) => void;
}



const contextStateCreator: StateCreator<ContextState, [['zustand/devtools', never]]> = (set, _get) => ({
        
        contexts: [],
        validationStates: new Map(),
        validatingIds: new Set(),
        
        
        addContext: (item: ContextItem) => {
          set((state) => {
            
            if (state.contexts.some(c => c.id === item.id)) {
              log.warn('Context already exists', { id: item.id });
              return state;
            }
            
            return {
              contexts: [...state.contexts, item]
            };
          }, false, 'addContext');
        },
        
        
        removeContext: (id: string) => {
          set((state) => {
            const newValidationStates = new Map(state.validationStates);
            newValidationStates.delete(id);
            
            const newValidatingIds = new Set(state.validatingIds);
            newValidatingIds.delete(id);
            
            return {
              contexts: state.contexts.filter(c => c.id !== id),
              validationStates: newValidationStates,
              validatingIds: newValidatingIds
            };
          }, false, 'removeContext');
        },
        
        
        clearContexts: () => {
          set({
            contexts: [],
            validationStates: new Map(),
            validatingIds: new Set()
          }, false, 'clearContexts');
        },

        replaceContexts: (contexts: ContextItem[]) => {
          set({
            contexts: [...contexts],
            validationStates: new Map(),
            validatingIds: new Set(),
          }, false, 'replaceContexts');
        },
        
        
        updateValidation: (id: string, result: ValidationResult) => {
          set((state) => {
            const newValidationStates = new Map(state.validationStates);
            newValidationStates.set(id, result);
            
            const newValidatingIds = new Set(state.validatingIds);
            newValidatingIds.delete(id);
            
            return {
              validationStates: newValidationStates,
              validatingIds: newValidatingIds
            };
          }, false, 'updateValidation');
        },
        
        
        setValidating: (id: string, validating: boolean) => {
          set((state) => {
            const newValidatingIds = new Set(state.validatingIds);
            if (validating) {
              newValidatingIds.add(id);
            } else {
              newValidatingIds.delete(id);
            }
            
            return { validatingIds: newValidatingIds };
          }, false, 'setValidating');
        },
        
        
        reorderContexts: (startIndex: number, endIndex: number) => {
          set((state) => {
            const newContexts = [...state.contexts];
            const [removed] = newContexts.splice(startIndex, 1);
            newContexts.splice(endIndex, 0, removed);
            
            return { contexts: newContexts };
          }, false, 'reorderContexts');
        },
        
        
        updateContext: (id: string, updates: Partial<ContextItem>) => {
          set((state) => {
            const contexts = state.contexts.map(c => 
              c.id === id ? { ...c, ...updates } as ContextItem : c
            );
            
            return { contexts };
          }, false, 'updateContext');
        }
      });

const defaultContextStore = create<ContextState>()(
  devtools(
    persist<ContextState, [['zustand/devtools', never]]>(
      contextStateCreator,
      {
        name: 'openbitfun-context-storage',
        
        serialize: (state: any) => {
          return JSON.stringify({
            ...state.state,
            validationStates: Array.from(state.state.validationStates.entries()),
            validatingIds: Array.from(state.state.validatingIds)
          });
        },
        
        deserialize: (str: string) => {
          const parsed = JSON.parse(str);
          return {
            ...parsed,
            state: {
              ...parsed.state,
              validationStates: new Map(parsed.state.validationStates),
              validatingIds: new Set(parsed.state.validatingIds)
            }
          };
        },
        
        partialize: (state: any) => ({ 
          contexts: state.contexts.filter((ctx: any) => ctx.type !== 'image' && ctx.type !== 'pull-request')
        })
      } as any
    ),
    {
      name: 'ContextStore',
      enabled: process.env.NODE_ENV === 'development'
    }
  )
);



export const createConversationContextStore = () => create<ContextState>()(devtools(contextStateCreator, { enabled: false }));
export const ConversationContextStoreContext = createContext<ReturnType<typeof createConversationContextStore> | null>(null);
export const useContextStoreApi = () => useContext(ConversationContextStoreContext) ?? defaultContextStore;
export const useContextStore = Object.assign(
  function useScopedContextStore<T>(selector: (state: ContextState) => T): T {
    return useStore(useContextStoreApi(), selector);
  },
  defaultContextStore,
);

export const selectContexts = (state: ContextState) => state.contexts;
export const selectContextCount = (state: ContextState) => state.contexts.length;
export const selectContextById = (id: string) => (state: ContextState) => 
  state.contexts.find(c => c.id === id);
export const selectValidationState = (id: string) => (state: ContextState) => 
  state.validationStates.get(id);
export const selectIsValidating = (id: string) => (state: ContextState) => 
  state.validatingIds.has(id);
export const selectHasInvalidContexts = (state: ContextState) => 
  Array.from(state.validationStates.values()).some(v => !v.valid);



 
export const cleanupImageContextsFromStorage = () => {
  try {
    const storageKey = 'openbitfun-context-storage';
    const stored = localStorage.getItem(storageKey);
    
    if (stored) {
      const parsed = JSON.parse(stored);
      
      if (parsed.state && Array.isArray(parsed.state.contexts)) {
        const imageCount = parsed.state.contexts.filter((ctx: any) => ctx.type === 'image').length;
        
        if (imageCount > 0) {
          
          parsed.state.contexts = parsed.state.contexts.filter((ctx: any) => ctx.type !== 'image');
          
          
          localStorage.setItem(storageKey, JSON.stringify(parsed));
        }
      }
    }
  } catch (error) {
    log.warn('Failed to cleanup image contexts', error);
  }
};


cleanupImageContextsFromStorage();
