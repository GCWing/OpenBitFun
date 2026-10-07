import { neutralMotionFrames, type MotionClip, type MotionPart } from "./subagentMotion";

const parts: readonly MotionPart[] = ["body", "lever", "face", "eyes"];
type Rig = Record<MotionPart, SVGGElement>;

function createRig(svg: SVGSVGElement) {
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
  return {
    rig: { body: bodyRig, lever, face, eyes: eyeRig } satisfies Rig,
    restore: () => svg.replaceChildren(...original),
  };
}

/** One player owns every size sample, all animation handles, and completion. */
export function createSubagentMotionPlayer(host: HTMLElement, onFinish: () => void, selector = '.subagent-motion-art svg') {
  const rigs = Array.from(host.querySelectorAll<SVGSVGElement>(selector), createRig);
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
