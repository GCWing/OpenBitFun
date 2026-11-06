import { neutralMotionFrames, type MotionClip, type MotionPart } from "./subagentMotion";

const parts: readonly MotionPart[] = ["body", "lever", "face", "eyes"];
export type SubagentMotionRenderMode = "svg" | "layers";
type Rig = Record<MotionPart, SVGGElement | HTMLElement>;

function createRig(svg: SVGSVGElement, renderMode: SubagentMotionRenderMode) {
  const original = Array.from(svg.childNodes, (node) => node.cloneNode(true));
  const stem = svg.querySelector(":scope > rect");
  const body = svg.querySelector(":scope > path");
  const knob = svg.querySelector(":scope > circle");
  const eyes = svg.querySelector(":scope > g");
  if (!stem || !body || !knob || !eyes) {
    throw new Error("The Subagent artwork no longer matches its motion rig.");
  }
  const group = (part: MotionPart, children: Element[]) => {
    const element = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
    element.dataset.motionPart = part;
    element.style.transformBox = 'fill-box';
    element.style.transformOrigin = part === 'body' || part === 'lever' ? 'center bottom' : 'center';
    element.append(...children);
    return element;
  };
  const lever = group("lever", [stem, knob]);
  const eyeRig = group("eyes", [eyes]);
  const face = group("face", [eyeRig]);
  const bodyRig = group("body", [lever, body, face]);
  svg.append(bodyRig);
  const svgRig = { body: bodyRig, lever, face, eyes: eyeRig };
  const restore = () => svg.replaceChildren(...original);
  if (renderMode === "layers") {
    const layered = createLayerRig(svg, svgRig, { stem, body, knob, eyes });
    if (layered) return { rig: layered.rig, restore: () => { layered.dispose(); restore(); } };
  }
  return { rig: svgRig satisfies Rig, restore };
}

/** Opt-in for a standalone artwork surface, retaining its SVG layout box. */
function createLayerRig(svg: SVGSVGElement, rig: Record<MotionPart, SVGGElement>, artwork: Record<"stem" | "body" | "knob" | "eyes", Element>) {
  const parent = svg.parentElement;
  const view = svg.ownerDocument.defaultView;
  const box = svg.viewBox.baseVal;
  const aspect = svg.preserveAspectRatio.baseVal;
  if (!parent || !view?.ResizeObserver || parent.childElementCount !== 1 || box.width <= 0 || box.height <= 0
      || aspect.align !== 6 || aspect.meetOrSlice !== 1 || !svg.clientWidth || !svg.clientHeight) return;
  let bounds: DOMRect[];
  try { bounds = parts.map(part => rig[part].getBBox()); } catch { return; }
  if (bounds.some(rect => ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0)) return;
  const document = svg.ownerDocument;
  const overlay = document.createElement("span");
  overlay.dataset.subagentMotionLayer = "true";
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "visible" });
  const canvas = document.createElement("span");
  Object.assign(canvas.style, { position: "absolute", left: "0", top: "0", width: `${box.width}px`, height: `${box.height}px`, transformOrigin: "0 0" });
  overlay.append(canvas);
  const layer = (...children: Element[]) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    element.setAttribute("width", String(box.width)); element.setAttribute("height", String(box.height));
    Object.assign(element.style, { position: "absolute", left: "0", top: "0", overflow: "visible" });
    element.append(...children); return element;
  };
  const group = (part: MotionPart, children: Element[]) => {
    const boundsForPart = bounds[parts.indexOf(part)]!;
    const element = document.createElement("span");
    element.dataset.motionPart = part;
    Object.assign(element.style, { position: "absolute", left: "0", top: "0", width: `${box.width}px`, height: `${box.height}px`,
      transformOrigin: `${boundsForPart.x + boundsForPart.width / 2}px ${boundsForPart.y + boundsForPart.height * (part === "body" || part === "lever" ? 1 : 0.5)}px` });
    element.append(...children); return element;
  };
  const lever = group("lever", [layer(artwork.stem, artwork.knob)]);
  const eyes = group("eyes", [layer(artwork.eyes)]);
  const face = group("face", [eyes]);
  const body = group("body", [lever, layer(artwork.body), face]);
  canvas.append(body);
  rig.body.remove();
  const oldPosition = parent.style.position;
  const positioned = view.getComputedStyle(parent).position === "static";
  if (positioned) parent.style.position = "relative";
  parent.append(overlay);
  // The untouched outer SVG remains the layout placeholder. HTML transforms
  // live outside SVG; foreignObject transform layers misplace pixels in WebKit.
  const fit = () => {
    const width = svg.clientWidth, height = svg.clientHeight;
    const scale = Math.min(width / box.width, height / box.height);
    canvas.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${(width - box.width * scale) / 2 - box.x * scale}, ${(height - box.height * scale) / 2 - box.y * scale})`;
  };
  fit();
  const observer = new view.ResizeObserver(fit);
  observer.observe(svg);
  return { rig: { body, lever, face, eyes } satisfies Rig, dispose: () => {
    observer.disconnect(); overlay.remove();
    if (positioned && parent.style.position === "relative") parent.style.position = oldPosition;
  } };
}

/** One player owns every size sample, all animation handles, and completion. */
export function createSubagentMotionPlayer(host: HTMLElement, onFinish: () => void, selector = '.subagent-motion-art svg', renderMode: SubagentMotionRenderMode = "svg") {
  const rigs = Array.from(host.querySelectorAll<SVGSVGElement>(selector), svg => createRig(svg, renderMode));
  let animations: Animation[] = [];
  let revision = 0;
  let paused = false;
  let suspended = false;
  let reduced = false;
  let rate = 1;

  function cancel() {
    revision += 1;
    animations.forEach((animation) => animation.cancel());
    animations = [];
  }

  function syncPlayback() {
    animations.forEach((animation) => {
      if (animation.playState === "finished") return;
      if (paused || suspended || reduced) animation.pause();
      else animation.play();
    });
  }

  function play(clip: MotionClip, { repeat = clip.loop, fromCurrent = true, notify = true } = {}) {
    if (reduced) return;
    const prepared = rigs.flatMap(({ rig }) => parts.map((part) => {
      const element = rig[part];
      const frames = (clip.tracks[part] ?? neutralMotionFrames()).map((keyframe) => ({ ...keyframe }));
      if (fromCurrent && !repeat && frames[0]) {
        const current = host.ownerDocument.defaultView!.getComputedStyle(element);
        frames[0] = { ...frames[0], transform: current.transform, opacity: current.opacity };
      }
      return { element, frames };
    }));
    cancel();
    const currentRevision = revision;
    const startTime = host.ownerDocument.timeline?.currentTime;
    animations = prepared.map(({ element, frames }) => {
      const animation = element.animate(frames, {
        duration: clip.duration,
        iterations: repeat ? Infinity : 1,
        fill: "both",
      });
      animation.playbackRate = rate;
      if (typeof startTime === "number") animation.startTime = startTime;
      return animation;
    });
    syncPlayback();
    if (notify && !repeat) {
      void Promise.all(animations.map((animation) => animation.finished)).then(() => {
        if (currentRevision === revision) onFinish();
      }).catch(() => { /* A new action or unmount cancels the previous playback. */ });
    }
  }

  return {
    play,
    setPaused(value: boolean) { paused = value; syncPlayback(); },
    setSuspended(value: boolean) { suspended = value; syncPlayback(); },
    setRate(value: number) {
      rate = value;
      animations.forEach((animation) => animation.updatePlaybackRate(rate));
    },
    setReduced(value: boolean) {
      reduced = value;
      if (reduced) cancel();
    },
    dispose() { cancel(); rigs.forEach(({ restore }) => restore()); },
  };
}

export type SubagentMotionPlayer = ReturnType<typeof createSubagentMotionPlayer>;
