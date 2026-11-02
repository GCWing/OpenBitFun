import { useEffect, useSyncExternalStore } from 'react';
import { useAIExperienceSettings } from '@/infrastructure/config/hooks/useAIExperienceSettings';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { usePromptSuggestionStore } from '../store/promptSuggestionStore';

/** Follow the execution host's setting and discard hints disabled by that host. */
export function usePromptSuggestionsEnabled(): boolean {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const { settings } = useAIExperienceSettings();
  const enabled = settings?.enable_prompt_suggestion === true;

  useEffect(() => {
    if (settings && scope.isCurrent()) {
      usePromptSuggestionStore.getState().setEnabled(enabled, scope.surfaceId);
    }
  }, [enabled, settings, scope]);

  return enabled;
}
