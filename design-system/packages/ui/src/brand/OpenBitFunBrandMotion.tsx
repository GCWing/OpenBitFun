import { useEffect, useRef, type CSSProperties, type SVGProps } from "react";
import { classNames } from "../internal/classNames";
import { startBrandPlayback } from "./brandPlayback";
import markSource from "./assets/openbitfun-mark.svg?raw";
import styles from "./brand.module.css";

const CONTOUR_COUNT = 15;
const FLOW_CYCLE_MS = 18000;
const COUNTER_ROTATE_CYCLE_MS = 1000;
const COUNTER_ROTATE_TURN_MS = 420;
const CONSTRUCTION_TIMING = {
  drawEnd: 1050,
  fillEnd: 1400,
  holdEnd: 1650,
  unfillEnd: 2000,
  retractEnd: 3050,
  cycleEnd: 3200,
  innerDelay: 100,
  strokeFade: 80,
};
const CONSTRUCTION_EASING = "cubic-bezier(0.35, 0, 0.65, 1)";
const FLOW_LAYERS = [
  { length: 34, opacity: 0.12 },
  { length: 26, opacity: 0.14 },
  { length: 18, opacity: 0.36 },
];

type Point = [number, number];

function createContour(index: number): string {
  const progress = index / (CONTOUR_COUNT - 1);
  const radius = 79 + 23 * progress;
  // Preserve the original ribbon: flat inner edge, pointed outer crown.
  const angle = (-60 - 30 * progress) * Math.PI / 180;
  const vertices = Array.from({ length: 6 }, (_, vertex): Point => {
    const theta = angle + vertex * Math.PI / 3;
    return [128 + radius * Math.cos(theta), 128 + radius * Math.sin(theta)];
  });
  const corners = vertices.map((vertex, i) => {
    // Both modulo indices stay inside the six vertices created above.
    const previous = vertices[(i + 5) % 6]!;
    const next = vertices[(i + 1) % 6]!;
    const toward = (target: Point): Point => [
      vertex[0] + (target[0] - vertex[0]) * 0.16,
      vertex[1] + (target[1] - vertex[1]) * 0.16,
    ];
    return {
      entry: toward(previous),
      exit: toward(next),
      vertex,
    };
  });
  const point = (values: number[]) => values.map(value => value.toFixed(3)).join(' ');
  return corners.map((corner, i) =>
    `${i === 0 ? 'M' : 'L'} ${point(corner.entry)} Q ${point(corner.vertex)} ${point(corner.exit)}`,
  ).join(' ') + ' Z';
}

const contours = Array.from({ length: CONTOUR_COUNT }, (_, index) => createContour(index));
const authoredContours = Array.from(markSource.matchAll(/<path\b[^>]*\sd="([^"]+)"/g), match => match[1]!);
const innerContour = authoredContours[0];
const outerContour = authoredContours[authoredContours.length - 1];
if (!innerContour || !outerContour || authoredContours.length < 2) {
  throw new Error("The OpenBitFun mark must provide its authored inner and outer contours.");
}
// Preserve the master's exact proportions and cubic corners. Pad its 120px canvas
// by two units on each side so the icon-weight strokes fit throughout each turn.
const markContours = [outerContour, innerContour];
const markSilhouette = markContours.join(" ");
const MARK_VIEW_BOX = "-2 -2 124 124";

function createConstructionAnimations(svg: SVGSVGElement): Animation[] {
  const outer = svg.querySelector<SVGPathElement>('[data-brand-construction="outer"]');
  const inner = svg.querySelector<SVGPathElement>('[data-brand-construction="inner"]');
  const fill = svg.querySelector<SVGPathElement>('[data-brand-construction="fill"]');
  if (!outer || !inner || !fill) return [];

  const timing = CONSTRUCTION_TIMING;
  // Match the travel speed of the authored contours while leaving a small lead.
  const innerDuration = Math.min(
    timing.drawEnd - timing.innerDelay,
    timing.drawEnd * inner.getTotalLength() / outer.getTotalLength(),
  );
  const frame = (time: number, values: Keyframe): Keyframe => ({
    ...values,
    offset: time / timing.cycleEnd,
  });
  const animate = (element: Element, keyframes: Keyframe[]) => element.animate(keyframes, {
    duration: timing.cycleEnd,
    iterations: Infinity,
    easing: "linear",
  });
  const trace = (path: SVGPathElement, start: number, end: number, reverse = false): Animation[] => {
    const hiddenOffset = reverse ? "-100" : "100";
    const retractHiddenOffset = reverse ? "100" : "-100";
    // Mirror the drawing interval within the return phase, with one shared hold.
    const retractStart = timing.retractEnd - end;
    const retractEnd = timing.retractEnd - start;
    return [
      animate(path, [
        ...(start > 0 ? [frame(0, { strokeDashoffset: hiddenOffset })] : []),
        frame(start, { strokeDashoffset: hiddenOffset, easing: CONSTRUCTION_EASING }),
        frame(end, { strokeDashoffset: "0" }),
        frame(retractStart, { strokeDashoffset: "0", easing: CONSTRUCTION_EASING }),
        // Wipe from the other end, then reset the dash phase while fully hidden.
        frame(retractEnd, { strokeDashoffset: retractHiddenOffset, easing: "steps(1, end)" }),
        frame(timing.cycleEnd, { strokeDashoffset: hiddenOffset }),
      ]),
      // Fade the pen tip only as it moves; keep fill handoffs independent of travel.
      animate(path, [
        ...(start > 0 ? [frame(0, { opacity: 0 })] : []),
        frame(start, { opacity: 0, easing: CONSTRUCTION_EASING }),
        frame(start + timing.strokeFade, { opacity: 1 }),
        frame(timing.drawEnd, { opacity: 1, easing: CONSTRUCTION_EASING }),
        frame(timing.fillEnd, { opacity: 0 }),
        frame(timing.holdEnd, { opacity: 0, easing: CONSTRUCTION_EASING }),
        frame(timing.unfillEnd, { opacity: 1 }),
        frame(retractEnd - timing.strokeFade, { opacity: 1, easing: CONSTRUCTION_EASING }),
        frame(retractEnd, { opacity: 0 }),
        frame(timing.cycleEnd, { opacity: 0 }),
      ]),
    ];
  };

  const animations = [
    ...trace(outer, 0, timing.drawEnd),
    ...trace(inner, timing.innerDelay, timing.innerDelay + innerDuration, true),
    animate(fill, [
      frame(0, { opacity: 0 }),
      frame(timing.drawEnd, { opacity: 0, easing: CONSTRUCTION_EASING }),
      frame(timing.fillEnd, { opacity: 1 }),
      frame(timing.holdEnd, { opacity: 1, easing: CONSTRUCTION_EASING }),
      frame(timing.unfillEnd, { opacity: 0 }),
      frame(timing.cycleEnd, { opacity: 0 }),
    ]),
  ];
  const startTime = svg.ownerDocument.timeline?.currentTime;
  if (typeof startTime === "number") {
    animations.forEach(animation => { animation.startTime = startTime; });
  }
  return animations;
}

export interface OpenBitFunBrandMotionProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  active?: boolean;
  size?: number;
  label?: string;
  variant?: "flow" | "counter-rotate" | "construction";
}

export function OpenBitFunBrandMotion({ active = true, size = 192, label, variant = "flow", className, style, ...props }: OpenBitFunBrandMotionProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !active) return;
    return startBrandPlayback(svg, () => {
      if (variant === "construction") return createConstructionAnimations(svg);
      if (variant === "counter-rotate") {
        return Array.from(svg.querySelectorAll('[data-brand-rotation]')).map((rotor, index) => {
          const settledTransform = `rotate(${index === 0 ? 60 : -60}deg)`;
          return rotor.animate([
            { transform: "rotate(0deg)", offset: 0, easing: "cubic-bezier(0.65, 0, 0.35, 1)" },
            { transform: settledTransform, offset: COUNTER_ROTATE_TURN_MS / COUNTER_ROTATE_CYCLE_MS },
            // Hold for the rest of the beat; hexagonal symmetry closes the loop.
            { transform: settledTransform, offset: 1 },
          ], { duration: COUNTER_ROTATE_CYCLE_MS, iterations: Infinity, easing: "linear" });
        });
      }
      return Array.from(svg.querySelectorAll('[data-brand-flow]')).map((strand, index) => {
        const start = -index * 3;
        return strand.animate([
          { strokeDashoffset: String(start) },
          { strokeDashoffset: String(start - 100) },
        ], { duration: FLOW_CYCLE_MS, iterations: Infinity, easing: 'linear' });
      });
    });
  }, [active, variant]);

  return (
    <svg
      {...props}
      ref={svgRef}
      className={classNames(styles.flow, variant !== "flow" && styles.iconMotion, className)}
      style={{ ...style, "--_brand-motion-size": `${size}px` } as CSSProperties}
      data-openbitfun-component="openbitfun-brand-motion"
      data-openbitfun-part="root"
      data-openbitfun-active={active}
      data-openbitfun-variant={variant}
      viewBox={variant === "flow" ? "0 0 256 256" : MARK_VIEW_BOX}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {variant === "construction" ? <>
        <path d={markSilhouette} fill="currentColor" fillRule="evenodd" stroke="none" opacity={0.12} />
        {markContours.map((path, index) => (
          <path
            key={index} data-brand-construction={index === 0 ? "outer" : "inner"}
            d={path} pathLength={100} strokeDasharray="100 100" opacity={0}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path data-brand-construction="fill" d={markSilhouette} fill="currentColor" fillRule="evenodd" stroke="none" />
      </> : variant === "counter-rotate" ? markContours.map((path, index) => (
        <g key={index} className={styles.counterRotor} data-brand-rotation={index === 0 ? "outer" : "inner"}>
          <path d={path} vectorEffect="non-scaling-stroke" />
        </g>
      )) : contours.map((path, index) => (
        <g key={index}>
          <path d={path} opacity={index === 0 || index === CONTOUR_COUNT - 1 ? 0.58 : 0.34} />
          <g data-brand-flow="true" strokeDashoffset={-index * 3}>
            {FLOW_LAYERS.map(layer => (
              <path
                key={layer.length}
                d={path}
                pathLength={100}
                strokeDasharray={`${layer.length / 2} ${100 - layer.length} ${layer.length / 2} 0`}
                opacity={layer.opacity}
              />
            ))}
          </g>
        </g>
      ))}
    </svg>
  );
}
