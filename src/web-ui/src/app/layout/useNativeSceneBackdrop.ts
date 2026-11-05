import { useLayoutEffect, useRef } from 'react';
import { appearanceRuntime } from '@/infrastructure/appearance';
import { observeNativeSceneBackdrop } from '@/infrastructure/runtime/sceneBackdrop';

export function useNativeSceneBackdrop() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const backdrop = observeNativeSceneBackdrop(ref.current);
    const unsubscribe = appearanceRuntime.subscribe(backdrop.refresh);
    return () => { unsubscribe(); backdrop.dispose(); };
  }, []);
  return ref;
}
