 

import React, { useCallback, useState, useRef, useEffect } from 'react';
import { dragManager } from '../../services/DragManager';
import { contextRegistry } from '../../services/ContextRegistry';
import { useContextStore } from '../../stores/contextStore';
import type { IDropTarget } from '../../types/drag';
import type { DragPayload } from '../../types/drag';
import type { ContextItem, ContextType } from '../../types/context';
import './ContextDropZone.scss';
export interface ContextDropZoneProps {
  acceptedTypes?: ContextType[];
  children?: React.ReactNode;
  className?: string;
  onContextAdded?: (context: ContextItem) => void;
  onExternalFilesDrop?: (files: File[]) => void;
  disabled?: boolean;
  /** Also accept drops in this enclosing surface; feedback stays on the composer. */
  extendedTargetRef?: React.RefObject<HTMLElement | null>;
  onDragStateChange?: (canDrop: boolean) => void;
}

type DropEvent = React.DragEvent | DragEvent;
const nativeDragEvent = (event: DropEvent): DragEvent =>
  'nativeEvent' in event ? event.nativeEvent : event;

export const ContextDropZone: React.FC<ContextDropZoneProps> = ({
  acceptedTypes,
  children,
  className = '',
  onContextAdded,
  onExternalFilesDrop,
  disabled = false,
  extendedTargetRef,
  onDragStateChange,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [canAccept, setCanAccept] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0); 
  const addContext = useContextStore(state => state.addContext);
  const updateValidation = useContextStore(state => state.updateValidation);

  useEffect(() => {
    onDragStateChange?.(isDragOver && canAccept && !disabled);
  }, [isDragOver, canAccept, disabled, onDragStateChange]);

  useEffect(() => {
    const reset = () => {
      dragCounterRef.current = 0;
      setIsDragOver(false);
      setCanAccept(false);
    };
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('blur', reset);
    };
  }, []);
  
  
  const acceptedTypesArray = React.useMemo(() => 
    acceptedTypes || contextRegistry.getAllTypes(), 
    [acceptedTypes]
  );
  
  
  const dropTarget = React.useMemo<IDropTarget>(() => ({
    targetId: 'context-drop-zone',
    acceptedTypes: acceptedTypesArray,
    
    canAccept: (payload: DragPayload<ContextItem>) => {
      return !disabled && acceptedTypesArray.includes(payload.dataType);
    },
    
    onDrop: async (payload: DragPayload<ContextItem>) => {
      if (disabled) return;
      const context = payload.data;
      
      
      addContext(context);
      
      
      
      updateValidation(context.id, { valid: true });
      
      
      onContextAdded?.(context);
      
      
      setIsDragOver(false);
      setCanAccept(false);
    },
    
    onDragEnter: (payload: DragPayload<ContextItem>) => {
      setIsDragOver(true);
      const accepted = dropTarget.canAccept(payload);
      setCanAccept(accepted);
    },
    
    onDragLeave: () => {
      setIsDragOver(false);
      setCanAccept(false);
    },
    
    onDragOver: () => {
      
    }
  }), [acceptedTypesArray, addContext, disabled, updateValidation, onContextAdded]);
  
  
  const dropTargetRef = useRef(dropTarget);
  
  
  useEffect(() => {
    dropTargetRef.current = dropTarget;
  }, [dropTarget]);
  
  
  React.useEffect(() => {
    const unregister = dragManager.registerTarget(dropTarget);
    
    return () => {
      unregister();
    };
  }, [dropTarget]);
  
   
  /**
   * Whether this zone should claim the drag as a DOM drop target.
   *
   * Claiming means calling preventDefault on dragenter/dragover, which turns
   * the composer into a DOM drop target. On WebKitGTK (Linux) an OS file drag
   * reports NO dataTransfer types, and a claimed DOM target makes WebKit stop
   * forwarding the drop to the native window drag handler, silently swallowing
   * the file. Empty-typed drags therefore stay unclaimed so the pane-level
   * native drop path (wry drag events) owns them.
   */
  const shouldClaimDrag = useCallback((e: DropEvent): boolean => {
    if (!e.dataTransfer) return false;
    const types = Array.from(e.dataTransfer.types);
    if (types.includes('Files')) {
      return !disabled && Boolean(onExternalFilesDrop);
    }
    // Internal context drags and typed non-file drags keep the historical
    // claiming behavior; only unidentifiable empty-typed drags step aside.
    return types.length > 0 || Boolean(dragManager.getCurrentPayload());
  }, [disabled, onExternalFilesDrop]);

  const handleDragEnter = useCallback((e: DropEvent) => {
    if (!e.dataTransfer) return;
    if (!shouldClaimDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current++;
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      setIsDragOver(true);
      setCanAccept(!disabled && Boolean(onExternalFilesDrop));
      return;
    }
    
    if (dragCounterRef.current === 1) {
      
      const payload = dragManager.getCurrentPayload();
      if (payload) {
        const accepted = dropTargetRef.current.canAccept(payload);
        setIsDragOver(true);
        setCanAccept(accepted);
        dragManager.handleDragEnter(dropTargetRef.current, nativeDragEvent(e));
      }
    }
  }, [disabled, onExternalFilesDrop, shouldClaimDrag]);

  const handleDragOver = useCallback((e: DropEvent) => {
    if (!e.dataTransfer) return;
    if (!shouldClaimDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();

    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.dataTransfer.dropEffect = disabled || !onExternalFilesDrop ? 'none' : 'copy';
      return;
    }

    const payload = dragManager.getCurrentPayload();
    if (payload && dropTargetRef.current.canAccept(payload)) {
      e.dataTransfer.dropEffect = 'copy';
      dragManager.handleDragOver(dropTargetRef.current, nativeDragEvent(e));
    } else {
      e.dataTransfer.dropEffect = 'none';
    }
  }, [disabled, onExternalFilesDrop, shouldClaimDrag]);
  
  const handleDragLeave = useCallback((e: DropEvent) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();
    const containsExternalFiles = Array.from(e.dataTransfer.types).includes('Files');
    
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    
    if (dragCounterRef.current === 0) {
      
      setIsDragOver(false);
      setCanAccept(false);
      if (!containsExternalFiles) {
        dragManager.handleDragLeave(dropTargetRef.current, nativeDragEvent(e));
      }
    }
  }, []);
  
  const handleDrop = useCallback((e: DropEvent) => {
    if (!e.dataTransfer) return;
    if (!shouldClaimDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    
    
    dragCounterRef.current = 0;
    setIsDragOver(false);
    setCanAccept(false);

    if (Array.from(e.dataTransfer.types).includes('Files')) {
      if (!disabled && onExternalFilesDrop) {
        onExternalFilesDrop(Array.from(e.dataTransfer.files));
      }
      return;
    }
    dragManager.handleDrop(dropTargetRef.current, nativeDragEvent(e));
  }, [disabled, onExternalFilesDrop, shouldClaimDrag]);

  useEffect(() => {
    const target = extendedTargetRef?.current;
    if (!target) return;
    const outsideComposer = (handler: (event: DropEvent) => void) => (event: DragEvent) => {
      // The composer's existing React handlers own drops inside it. Do not
      // consume text/tab drags in the transcript or add an attachment twice.
      if (event.target instanceof Node && dropZoneRef.current?.contains(event.target)) return;
      if (!event.dataTransfer?.types.includes('Files') && !dragManager.getCurrentPayload()) return;
      handler(event);
    };
    const enter = outsideComposer(handleDragEnter);
    const over = outsideComposer(handleDragOver);
    const leave = outsideComposer(handleDragLeave);
    const drop = outsideComposer(handleDrop);
    target.addEventListener('dragenter', enter);
    target.addEventListener('dragover', over);
    target.addEventListener('dragleave', leave);
    target.addEventListener('drop', drop);
    return () => {
      target.removeEventListener('dragenter', enter);
      target.removeEventListener('dragover', over);
      target.removeEventListener('dragleave', leave);
      target.removeEventListener('drop', drop);
    };
  }, [extendedTargetRef, handleDragEnter, handleDragOver, handleDragLeave, handleDrop]);
  
  return (
    <div
      ref={dropZoneRef}
      className={`
        openbitfun-context-drop-zone
        ${isDragOver ? 'openbitfun-context-drop-zone--drag-over' : ''}
        ${canAccept ? 'openbitfun-context-drop-zone--can-accept' : ''}
        ${!canAccept && isDragOver ? 'openbitfun-context-drop-zone--cannot-accept' : ''}
        ${className}
      `.trim()}
      
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-dropzone="context-drop-zone"
      data-openbitfun-component="context-list"
      data-openbitfun-part="dropZone"
      data-openbitfun-state={`${isDragOver ? 'drag-over ' : ''}${canAccept ? 'can-accept' : ''}`.trim() || undefined}
    >
      {children}
    </div>
  );
};

export default ContextDropZone;
