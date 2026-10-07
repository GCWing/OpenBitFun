import { useEffect, useRef, type CanvasHTMLAttributes } from "react";
import { classNames } from "../../internal/classNames";
import { createVoiceParticleRenderer } from "./voiceParticleRenderer";
import { SILENT_VOICE_AUDIO, type VoiceParticleAudioReader } from "./voiceParticleDynamics";
import styles from "./VoiceParticleLogo.module.css";
import { VoiceParticleFormation } from "./voiceParticleFormation";

export interface VoiceParticleLogoProps extends CanvasHTMLAttributes<HTMLCanvasElement> {
  /** Read the current microphone/output FFT without publishing audio frames through React. */
  readAudio?: VoiceParticleAudioReader;
  active?: boolean;
  /** 0 is the authored solid mark; 1 is the full audio-reactive particle form. */
  formation?: number;
}

/** Decorative, audio-reactive logo. The host alone owns media and permission lifetimes. */
export function VoiceParticleLogo({ readAudio, active = true, formation = 1, className, ...props }: VoiceParticleLogoProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readerRef = useRef(readAudio);
  readerRef.current = readAudio;
  const activeRef = useRef(active);
  activeRef.current = active;
  const formationRef = useRef(new VoiceParticleFormation(formation));
  const syncRef = useRef(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const colors = getComputedStyle(canvas);
    let foreground = colors.color;
    let background = colors.getPropertyValue("--openbitfun-color-content-on-light").trim();
    const renderer = createVoiceParticleRenderer(
      canvas,
      foreground,
      background,
    );
    if (!renderer) return;

    let frame = 0;
    let lastFrame = 0;
    let lastDrawTime = 0;
    let visible = true;
    let width = 0;
    let height = 0;
    const frameDuration = 1000 / 60;
    const canAnimate = () => (activeRef.current || formationRef.current.moving) && visible && !document.hidden && !motion.matches && width > 0 && height > 0;
    const animate = (time: number) => {
      frame = 0;
      if (!canAnimate()) return;
      const elapsed = time - lastFrame;
      if (elapsed >= frameDuration - 0.5) {
        lastFrame = time - (elapsed % frameDuration);
        if (formationRef.current.moving) {
          const current = getComputedStyle(canvas);
          const nextForeground = current.color;
          const nextBackground = current.getPropertyValue("--openbitfun-color-content-on-light").trim();
          if (foreground !== nextForeground || background !== nextBackground) {
            foreground = nextForeground;
            background = nextBackground;
            renderer.setColors(foreground, background);
          }
        }
        renderer.draw(time, activeRef.current ? readerRef.current?.() ?? SILENT_VOICE_AUDIO : SILENT_VOICE_AUDIO,
          activeRef.current, formationRef.current.sample(time));
        lastDrawTime = time;
      }
      if (canAnimate()) frame = requestAnimationFrame(animate);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
      if (!width || !height) return;
      if (canAnimate()) frame = requestAnimationFrame(animate);
      else renderer.draw(lastDrawTime, SILENT_VOICE_AUDIO, false, formationRef.current.sample(performance.now(), motion.matches));
    };
    syncRef.current = sync;
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      renderer.resize(width, height, window.devicePixelRatio || 1);
      sync();
    });
    const intersection = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      visible = entry.isIntersecting;
      sync();
    });
    const updateTheme = () => {
      const current = getComputedStyle(canvas);
      const nextForeground = current.color;
      const nextBackground = current.getPropertyValue("--openbitfun-color-content-on-light").trim();
      if (foreground === nextForeground && background === nextBackground) return;
      foreground = nextForeground;
      background = nextBackground;
      renderer.setColors(foreground, background);
      sync();
    };
    const theme = new MutationObserver(updateTheme);
    const finishColorTransition = (event: TransitionEvent) => {
      if (event.propertyName === "color" && event.target instanceof Element && event.target.contains(canvas)) updateTheme();
    };
    for (let ancestor: HTMLElement | null = canvas; ancestor; ancestor = ancestor.parentElement) {
      theme.observe(ancestor, { attributes: true, attributeFilter: ["style", "class", "data-color-scheme", "data-contrast", "data-openbitfun-state", "data-openbitfun-communication-mode"] });
    }
    const updateProjection = () => {
      renderer.resize(width, height, window.devicePixelRatio || 1);
      sync();
    };
    resize.observe(canvas);
    intersection.observe(canvas);
    motion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    document.addEventListener("transitionend", finishColorTransition);
    window.addEventListener("resize", updateProjection);
    return () => {
      syncRef.current = () => {};
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      theme.disconnect();
      motion.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      document.removeEventListener("transitionend", finishColorTransition);
      window.removeEventListener("resize", updateProjection);
    };
  }, []);

  useEffect(() => {
    formationRef.current.setTarget(formation, performance.now());
    syncRef.current();
  }, [active, formation]);

  return <canvas {...props} ref={canvasRef} className={classNames(styles.root, className)}
    data-openbitfun-component="voice-particle-logo" data-openbitfun-part="root" aria-hidden="true" />;
}
