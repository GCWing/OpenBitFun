import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { Icon, StatusPill } from "@openbitfun/ui";
import { MobileComposer, MobileIconButton, MobileMessage, MobilePageHeader, MobileTabBar } from "@openbitfun/ui/mobile";
import { OpenBitFunSolidMark } from "@openbitfun/ui/brand";
import { useI18n } from "../i18n";
import "./MultiSurfaceMorph.css";

/* The design system is one system across four surfaces, and a homepage picture that shows only the
   desktop window tells half the story. This frame is that picture with the rest of the story: the
   same product — the same parts, the same welcome screen — shown as a desktop window, a phone, a
   watch, and a pair of glasses, morphing between them.

   How it is built, and why:
   - One frame, four states. Only the frame's own box (inline-size, block-size, radius) changes
     between surfaces, animated through `@property`-registered lengths, so the shape itself is what
     moves. The surfaces inside it do not stretch or reflow: they are laid out at the size they are
     meant to be read at and cross-fade while the box travels.
   - The desktop surface is the caller's own picture (`children`), unchanged — it is the state the
     page already shipped, and it is authored for the frame's widest state.
   - The other three surfaces are assembled from the system's own mobile parts (MobilePageHeader,
     MobileMessage, MobileComposer, MobileTabBar, MobileIconButton), so the phone/watch/glasses faces
     cannot drift from the parts a product would actually use.
   - Durations and easings come from the motion tokens, so a reduced-motion environment collapses the
     morph to nothing without any per-sheet media query, and the loop itself stops for readers who ask
     for reduced motion (the loop prefers a settled desktop window), for the tab being hidden, and for
     the frame being off-screen. */
export type ProductSurface = "web" | "phone" | "watch" | "glasses";

/** The order the surfaces are shown in: the desktop window, then the smaller and stranger devices. */
const SURFACES: readonly ProductSurface[] = ["web", "phone", "watch", "glasses"];

/** How long each settled surface is held. The desktop window is the picture the page is about, so it
    rests there; the three devices are shown long enough to be read. The morph itself takes the CSS
    token's time (`lazy`, 1s) on top of these. */
const HOLDS: Record<ProductSurface, number> = { web: 3800, phone: 2400, watch: 2200, glasses: 2600 };

/** A voice waveform, written out rather than randomised so it reads as a signal, not as noise. */
const WAVE = [26, 58, 40, 82, 100, 62, 36, 88, 54, 28];

export interface MultiSurfaceMorphProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The desktop surface: the caller's own picture of the product, at the frame's widest state. */
  children: ReactNode;
}

export function MultiSurfaceMorph({ children, className }: MultiSurfaceMorphProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 1120, height: 560 });
  const [index, setIndex] = useState(0);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);

  /* The four geometries are lengths, and they are given to the frame in px: a percentage can only
     morph into another percentage, so the desktop state's own size is measured and handed down. */
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      setStage({ width: Math.round(bounds.width), height: Math.round(bounds.height) });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotionAllowed(!preference.matches);
    sync();
    preference.addEventListener("change", sync);
    return () => preference.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const element = stageRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => setOnScreen(entries.some(entry => entry.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sync = () => setTabVisible(!document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const cycling = motionAllowed && onScreen && tabVisible;
  const surface = SURFACES[index] ?? "web";

  useEffect(() => {
    if (!cycling) return;
    const timer = window.setTimeout(() => setIndex(current => (current + 1) % SURFACES.length), HOLDS[surface]);
    return () => window.clearTimeout(timer);
  }, [cycling, surface]);

  return (
    <div ref={stageRef} className={className ? `design-morph ${className}` : "design-morph"} data-surface={surface}
      style={{ "--_morph-stage-w": `${stage.width}px`, "--_morph-stage-h": `${stage.height}px` } as CSSProperties}>
      <div className="design-morph-frame">
        <Surface active={surface === "web"} name="web">{children}</Surface>
        <Surface active={surface === "phone"} name="phone"><PhoneSurface /></Surface>
        <Surface active={surface === "watch"} name="watch"><WatchSurface /></Surface>
        <Surface active={surface === "glasses"} name="glasses"><GlassesSurface /></Surface>
      </div>
    </div>
  );
}

/* A surface is a stage: it fills whatever the frame currently is, and only the one that matches the
   current state is shown. The hidden three are out of the accessibility tree as well as out of sight
   — the whole frame is a picture, and a picture of a phone is not a phone. */
function Surface({ active, children, name }: { active: boolean; children: ReactNode; name: ProductSurface }) {
  return (
    <div className={`design-morph-surface design-morph-surface--${name}`} data-active={active} aria-hidden={!active}>
      {children}
    </div>
  );
}

/* Phone: the same conversation as the desktop window, in the shape a phone gives it — a page header,
   the transcript, the composer above the bottom navigation. */
function PhoneSurface() {
  const { t } = useI18n();
  return (
    <div className="design-morph-phone">
      <MobilePageHeader className="design-morph-phone-head" leading={<OpenBitFunSolidMark size={22} />}
        title={t("design.homePreview.assistant")} subtitle="Claw" />
      <div className="design-morph-phone-thread">
        <MobileMessage roleType="user">{t("design.homePreview.composerPlaceholder")}</MobileMessage>
        <MobileMessage roleType="assistant">{t("design.homePreview.support")}</MobileMessage>
      </div>
      <MobileComposer className="design-morph-phone-composer" aria-label={t("components.preview.composerLabel")}
        leading={<MobileIconButton appearance="plain" aria-label={t("components.preview.add")}
          icon={<Icon name="plus" />} tabIndex={-1} />}
        endActions={<MobileIconButton appearance="plain" aria-label={t("components.preview.composerSend")}
          icon={<Icon name="arrow-up" />} tabIndex={-1} />}>
        <span className="design-home-preview-placeholder">{t("design.homePreview.composerPlaceholder")}</span>
      </MobileComposer>
      <MobileTabBar className="design-morph-phone-tabs" label={t("design.homePreview.sessions")} value="assistant"
        safeArea={false}
        items={[
          { icon: <Icon name="spark" />, label: t("design.homePreview.assistant"), value: "assistant" },
          { icon: <Icon name="list-todo" />, label: t("design.homePreview.taskBoard"), value: "task-board" },
          { icon: <Icon name="mini-app" />, label: t("design.homePreview.miniApp"), value: "mini-app" },
        ]} />
    </div>
  );
}

/* Watch: the surface with no room for a window at all. What survives the shrink is the state — the
   assistant listening — so the face is the mark, a live-looking waveform, and the one control that
   matters at this size. */
function WatchSurface() {
  const { t } = useI18n();
  return (
    <div className="design-morph-watch">
      <div className="design-morph-watch-face">
        <OpenBitFunSolidMark className="design-morph-watch-mark" size={28} />
        <span className="design-morph-watch-wave" aria-hidden="true">
          {WAVE.map((height, index) => (
            <i key={index} style={{ "--_morph-wave": `${height}%` } as CSSProperties} />
          ))}
        </span>
        <MobileIconButton className="design-morph-watch-mic" appearance="floating" tabIndex={-1}
          aria-label={t("design.homePreview.composerVoice")} icon={<Icon name="mic" />} />
      </div>
    </div>
  );
}

/* Glasses: a heads-up display, not a screen. The same prompt and the same answer state as the other
   surfaces, held in the one strip of glass the device has. */
function GlassesSurface() {
  const { t } = useI18n();
  return (
    <div className="design-morph-glasses">
      <span className="design-morph-glasses-lens" aria-hidden="true" />
      <div className="design-morph-glasses-hud">
        <OpenBitFunSolidMark size={18} />
        <span className="design-morph-glasses-line">{t("design.homePreview.composerPlaceholder")}</span>
        <StatusPill emphasis tone="success">{t("design.homePreview.contextAsk")}</StatusPill>
        <span className="design-morph-glasses-mic" aria-hidden="true"><Icon name="mic" /></span>
      </div>
    </div>
  );
}
