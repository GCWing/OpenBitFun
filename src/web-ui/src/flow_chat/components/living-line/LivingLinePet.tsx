import { useEffect, useState } from 'react';
import type { AgentCompanionPetMood } from '../AgentCompanionPet';
import { LivingLineRenderer } from './preview';
import { readLivingLineSettings, subscribeLivingLineSettings } from './livingLineSettingsStore';
import type { LivingState } from './geometry';
import './LivingLinePet.scss';

export const LIVING_LINE_FRAME_SIZE = { width: 288, height: 192 } as const;

export function LivingLinePet({
  state,
  mood,
  className = '',
  onFrameSizeChange,
}: {
  state: LivingState;
  mood: AgentCompanionPetMood;
  className?: string;
  onFrameSizeChange?: (size: { width: number; height: number } | null) => void;
}) {
  const [settings, setSettings] = useState(readLivingLineSettings);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => subscribeLivingLineSettings(() => setSettings(readLivingLineSettings())), []);

  useEffect(() => {
    onFrameSizeChange?.(LIVING_LINE_FRAME_SIZE);
    return () => onFrameSizeChange?.(null);
  }, [onFrameSizeChange]);

  return (
    <div
      className={`openbitfun-agent-companion-pet living-line-pet ${className}`.trim()}
      data-openbitfun-component="chat-input-pixel-pet"
      data-openbitfun-part="root"
      data-openbitfun-state={state}
      style={LIVING_LINE_FRAME_SIZE}
      aria-hidden="true"
    >
      <LivingLineRenderer
        state={state}
        reducedMotion={reducedMotion}
        settings={settings}
        hovered={mood === 'hover'}
        className="living-line-pet__art"
      />
    </div>
  );
}
