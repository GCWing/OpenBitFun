import { forwardRef, useEffect, useId, useRef, type HTMLAttributes } from "react";
import { startBrandPlayback } from "../../brand/brandPlayback";
import { classNames } from "../../internal/classNames";
import type { IconSize } from "../Icon";
import styles from "./ThinkingIndicator.module.css";

// Preserve the seven nodes and eight edges of Icon/assets/thinking.svg.
// Every edge points downwards, so drawing and retracting share one path.
const edges = [
  "M19.5 3.75 3.5 10.5", "M19.5 3.75 35.5 10.5",
  "M3.5 10.5 19.5 19.5", "M35.5 10.5 19.5 19.5",
  "M19.5 19.5 3.5 28.5", "M19.5 19.5 35.5 28.5",
  "M3.5 28.5 19.5 35.25", "M35.5 28.5 19.5 35.25",
];
// Trace each branch as one path so velocity continues through its junctions.
// The node cutouts below still prevent either line from crossing a visible dot.
const branches = [
  "M19.5 3.75 3.5 10.5 19.5 19.5 3.5 28.5 19.5 35.25",
  "M19.5 3.75 35.5 10.5 19.5 19.5 35.5 28.5 19.5 35.25",
];
const nodes = [
  [19.5, 3.75], [3.5, 10.5], [35.5, 10.5], [19.5, 19.5],
  [3.5, 28.5], [35.5, 28.5], [19.5, 35.25],
] as const;
// Node bounds are x=-0.5..39.5 and y=-0.25..39.25. Center the canvas on
// (19.5, 19.5) and retain padding for every complete circle at all icon sizes.
const viewBox = "-1.5 -1.5 42 42";
// Cut every node out of the edge layers; translucent nodes must never reveal
// either the resting track or the animated signal beneath them.
const edgeClipPath = [
  "M-1.5 -1.5H40.5V40.5H-1.5Z",
  ...nodes.map(([cx, cy]) => `M${cx - 4} ${cy}a4 4 0 1 0 8 0a4 4 0 1 0-8 0Z`),
].join(" ");
const nodeLevels = [0, 1, 1, 2, 3, 3, 4];
// Broad, overlapping fades bridge the parts of each trace hidden by a node.
const nodeFormation = [0, 0.08, 0.155, 0.23, 0.32];
const nodeDissolution = [0.84, 0.775, 0.71, 0.645, 0.58];
const playback = { duration: 2200, iterations: Infinity };
const easing = "cubic-bezier(0.45, 0, 0.55, 1)";

function createFormationAnimations(svg: SVGSVGElement): Animation[] {
  const animations: Animation[] = [];
  // Keep the static mark as the fallback until native playback is available.
  svg.setAttribute("data-playing", "true");
  // Ease only the complete drawing/retraction, never each short edge.
  svg.querySelectorAll<SVGPathElement>("[data-signal-edge]").forEach(edge => {
    animations.push(edge.animate([
      { offset: 0, strokeDashoffset: "1", opacity: 0 },
      { offset: 0.02, strokeDashoffset: "1", opacity: 1, easing },
      { offset: 0.43, strokeDashoffset: "0", opacity: 1 },
      { offset: 0.62, strokeDashoffset: "0", opacity: 1, easing },
      { offset: 0.95, strokeDashoffset: "1", opacity: 0 },
      { offset: 1, strokeDashoffset: "1", opacity: 0 },
    ], playback));
  });
  svg.querySelectorAll<SVGCircleElement>("[data-signal-node]").forEach((node, index) => {
    const level = nodeLevels[index]!;
    const form = nodeFormation[level]!;
    const dissolve = nodeDissolution[level]!;
    animations.push(node.animate([
      { offset: 0, opacity: 0 },
      { offset: form, opacity: 0, easing },
      { offset: form + (level === 0 ? 0.12 : 0.15), opacity: 1 },
      { offset: dissolve, opacity: 1, easing },
      { offset: dissolve + 0.16, opacity: 0 },
      { offset: 1, opacity: 0 },
    ], playback));
  });
  const startTime = svg.ownerDocument.timeline.currentTime;
  if (startTime !== null) animations.forEach(animation => { animation.startTime = startTime; });
  return animations;
}

export interface ThinkingIndicatorProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children" | "aria-label"> {
  /** The host owns activity; completing or stopping returns to the original mark. */
  active?: boolean;
  label?: string;
  size?: IconSize;
}

/** Form the original mark, hold it, then dissolve it in reverse order. */
export const ThinkingIndicator = forwardRef<HTMLSpanElement, ThinkingIndicatorProps>(function ThinkingIndicator({
  active = true, className, label, size = "sm", ...props
}, ref) {
  const edgeClipId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!active || !svg) return;
    const stop = startBrandPlayback(svg, () => createFormationAnimations(svg));
    return () => {
      stop();
      svg.removeAttribute("data-playing");
    };
  }, [active]);

  return <span {...props} ref={ref} className={classNames(styles.root, className)}
    data-openbitfun-component="thinking-indicator" data-active={active} data-size={size}
    aria-hidden={label ? undefined : "true"} aria-label={label} role={label ? "img" : undefined}>
    <svg ref={svgRef} viewBox={viewBox} fill="none" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={edgeClipId} clipPathUnits="userSpaceOnUse">
          <path d={edgeClipPath} clipRule="evenodd" />
        </clipPath>
      </defs>
      <g className={styles.track} clipPath={`url(#${edgeClipId})`} stroke="currentColor" strokeLinecap="round" strokeWidth="2">
        {edges.map(d => <path d={d} key={d} />)}
      </g>
      <g className={styles.nodes} fill="currentColor">
        {nodes.map(([cx, cy]) => <circle cx={cx} cy={cy} r="4" key={`${cx}-${cy}`} />)}
      </g>
      <g className={styles.signal} clipPath={`url(#${edgeClipId})`} stroke="currentColor" strokeLinecap="round" strokeWidth="2">
        {branches.map(d => <path d={d} pathLength="1" strokeDasharray="1 1" strokeDashoffset="1" data-signal-edge="" key={d} />)}
      </g>
      <g className={styles.signal} fill="currentColor">
        {nodes.map(([cx, cy]) => <circle cx={cx} cy={cy} r="4" data-signal-node="" key={`${cx}-${cy}`} />)}
      </g>
    </svg>
  </span>;
});
