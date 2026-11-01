import React, { useEffect, useRef, useState } from 'react';
import recipes from './grok-live/grok-recipes.json';
import { createGrokBot, type GrokBot } from './grok-live/grok-player.js';
import { readGrokLiveSettings, subscribeGrokLiveSettings, resolveGrokBodyColorHex, resolveGrokEyeColorHex, hexToRgb01 } from './grok-live/grokLiveSettings';
import type { AgentCompanionPetProps } from './AgentCompanionPet';
import './GrokLivePet.scss';

type Props = Pick<AgentCompanionPetProps, 'mood' | 'action' | 'className' | 'nativePetdexSize' | 'onPetFrameSizeChange'> & {
  needsAttention?: boolean;
  toolWaiting?: boolean;
  gaze?: [number, number] | null;
};
type FrameSample = { intervalMs: number; engineMs: number; domMs: number };

export function grokStateForMood(mood: Props['mood'], needsAttention = false, toolWaiting = false): string {
  switch (mood) {
    case 'rest': return 'idle';
    case 'analyzing': return 'thinking';
    case 'working': return 'coding';
    case 'waiting': return needsAttention ? 'waiting' : toolWaiting ? 'working' : 'waiting';
    case 'hover': return 'listening';
    case 'dragging': return 'dragging';
  }
}

function applyBaseState(bot: GrokBot, state: string, idleMotion: boolean): void {
  bot.setResting(false);
  bot.setState(state);
  if (state === 'idle' && !idleMotion) bot.setResting(true);
}

const ACTION_STATES = { jumping: 'waking', waving: 'finished', failed: 'failed' } as const;

/** One Grok engine per mounted pet; state changes never rerender SVG through React. */
export const GrokLivePet: React.FC<Props> = ({
  mood, action = null, className = '', nativePetdexSize = false, gaze,
  onPetFrameSizeChange, needsAttention = false, toolWaiting = false,
}) => {
  const hasExternalGaze = gaze !== undefined;
  const [settings, setSettings] = useState(readGrokLiveSettings);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [stats, setStats] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);
  const botRef = useRef<GrokBot | null>(null);
  const actionRef = useRef(action);
  const transientActiveRef = useRef(false);
  const baseState = grokStateForMood(mood, needsAttention, toolWaiting);
  const baseRef = useRef(baseState);
  baseRef.current = baseState;
  actionRef.current = action;

  useEffect(() => subscribeGrokLiveSettings(() => setSettings(readGrokLiveSettings())), []);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    onPetFrameSizeChange?.(nativePetdexSize ? { width: settings.size, height: settings.size } : null);
    return () => onPetFrameSizeChange?.(null);
  }, [nativePetdexSize, onPetFrameSizeChange, settings.size]);

  useEffect(() => {
    if (!stageRef.current) return;
    let disposed = false;
    let start = performance.now();
    const samples: FrameSample[] = [];
    setReady(false);
    setError(false);
    setStats('');
    const maxFps = settings.fps === '60' ? 60 : 120;
    let bot: GrokBot;
    try {
      bot = createGrokBot(stageRef.current, {
        data: recipes, size: 320, maxFps, state: baseRef.current,
        follow: settings.follow && !hasExternalGaze && !reducedMotion, reducedMotion,
        theme: { ink: hexToRgb01(resolveGrokBodyColorHex(settings)), spot: hexToRgb01(resolveGrokEyeColorHex(settings)), cutout: false },
        onFrame: import.meta.env.DEV && settings.showStats ? sample => {
          if (sample.intervalMs == null || !Number.isFinite(sample.intervalMs)) return;
          samples.push(sample);
          const now = performance.now();
          if (now - start < 2000) return;
          const intervals = samples.map(s => s.intervalMs).sort((a, b) => a - b);
          const mean = (key: keyof FrameSample) => samples.reduce((sum, s) => sum + s[key], 0) / samples.length;
          const avg = mean('intervalMs');
          const dropped = samples.filter(s => s.intervalMs > 1.5 * 1000 / maxFps).length / samples.length;
          setStats(`JS SVG ${Math.round(1000 / avg)} FPS | avg ${avg.toFixed(1)}ms | p95 ${intervals[Math.ceil(.95 * intervals.length) - 1].toFixed(1)}ms | target gaps ${(100 * dropped).toFixed(0)}% | engine ${mean('engineMs').toFixed(2)}ms | DOM ${mean('domMs').toFixed(2)}ms`);
          samples.length = 0;
          start = now;
        } : undefined,
      });
    } catch {
      setError(true);
      return;
    }
    botRef.current = bot;
    void bot.ready.then(() => {
      if (disposed) return;
      if (bot.error) { setError(true); return; }
      if (!transientActiveRef.current) applyBaseState(bot, baseRef.current, readGrokLiveSettings().idleMotion);
      setReady(true);
    }).catch(() => { if (!disposed) setError(true); });
    return () => {
      disposed = true;
      if (botRef.current === bot) botRef.current = null;
      bot.destroy();
    };
  // The engine is rebuilt only for frame policy, motion preference or debug instrumentation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.fps, settings.showStats, reducedMotion]);

  useEffect(() => {
    botRef.current?.setFollow(settings.follow && !hasExternalGaze && !reducedMotion);
  }, [settings.follow, reducedMotion, hasExternalGaze, settings.fps, settings.showStats]);
  useEffect(() => {
    if (!settings.follow || reducedMotion || !hasExternalGaze) return;
    botRef.current?.setGaze(gaze ?? null);
  }, [gaze, settings.follow, reducedMotion, hasExternalGaze, settings.fps, settings.showStats]);
  useEffect(() => {
    const ink = hexToRgb01(resolveGrokBodyColorHex(settings));
    botRef.current?.setGlow(settings.glow ? {
      inner: ink.map(v => Math.min(1, v + 0.16)),
      mid: ink.map(v => Math.max(0, v - 0.05)),
      rim: ink.map(v => Math.max(0, v - 0.14)),
      halo: 0,
    } : null);
  }, [settings.glow, settings.bodyColor, settings.bodyCustomColor, settings.fps, settings.showStats, reducedMotion]);
  useEffect(() => {
    if ((!action || !transientActiveRef.current) && botRef.current) {
      applyBaseState(botRef.current, baseRef.current, settings.idleMotion);
    }
  }, [baseState, action, settings.idleMotion]);
  useEffect(() => {
    if (!action) return;
    const bot = botRef.current;
    if (!bot) return;
    transientActiveRef.current = true;
    bot.setResting(false);
    bot.setState(ACTION_STATES[action]);
    const timer = window.setTimeout(() => {
      transientActiveRef.current = false;
      if (bot === botRef.current) applyBaseState(bot, baseRef.current, readGrokLiveSettings().idleMotion);
    }, 1650);
    return () => {
      transientActiveRef.current = false;
      window.clearTimeout(timer);
    };
  }, [action, settings.fps, settings.showStats, reducedMotion]);
  useEffect(() => {
    if (!settings.idleMotion || baseState !== 'idle' || reducedMotion) return;
    let timer = 0;
    let stopped = false;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        if (!document.hidden && !actionRef.current) botRef.current?.blink();
        schedule();
      }, 3500 + Math.random() * 5000);
    };
    schedule();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [baseState, settings.idleMotion, reducedMotion]);

  return (
    <div className={`openbitfun-agent-companion-pet openbitfun-grok-live ${className}`.trim()}
      data-openbitfun-component="chat-input-pixel-pet" data-openbitfun-part="root"
      data-openbitfun-mood={mood} data-openbitfun-layout="grok-live"
      style={nativePetdexSize ? { width: settings.size, height: settings.size } : undefined}
      aria-label={error ? 'GrokLive (animation unavailable)' : 'GrokLive'} role="img">
      <div ref={stageRef} className="openbitfun-grok-live__stage">
        {!ready && (<svg className="openbitfun-grok-live__fallback" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="43" fill={resolveGrokBodyColorHex(settings)} />
          <ellipse cx="36" cy="45" rx="8" ry="11" fill={resolveGrokEyeColorHex(settings)} />
          <ellipse cx="64" cy="45" rx="8" ry="11" fill={resolveGrokEyeColorHex(settings)} />
        </svg>)}
      </div>
      {import.meta.env.DEV && settings.showStats && stats && (<output className="openbitfun-grok-live__stats">{stats}</output>)}
    </div>
  );
};
