export const subagentBasicMotionIds = [
  "idle", "look", "hoverBlink", "press", "nod", "working", "waiting", "success", "blocked",
] as const;
export const subagentTransitionIds = ["enter", "exit", "settle"] as const;
const subagentMotionIds = [...subagentBasicMotionIds, ...subagentTransitionIds] as const;

export type SubagentMotionId = typeof subagentMotionIds[number];
export type MotionPart = "body" | "lever" | "face" | "eyes";
export type MotionTracks = Partial<Record<MotionPart, Keyframe[]>>;
export interface MotionClip {
  duration: number;
  loop?: boolean;
  tracks: MotionTracks;
}

const frame = (offset: number, transform = "none", opacity = 1): Keyframe => ({
  offset, transform, opacity, easing: "cubic-bezier(0.4, 0, 0.2, 1)",
});

export const subagentMotionClips: Record<SubagentMotionId, MotionClip> = {
  idle: {
    duration: 3600, loop: true,
    tracks: {
      // Keep the base anchored while making both breath phases readable at 28px.
      body: [frame(0), frame(0.3, "scale(0.982, 1.045)"), frame(0.7, "scale(1.025, 0.958)"), frame(1)],
      lever: [frame(0), frame(0.38, "translateY(-3px) rotate(-4deg)"), frame(0.78, "translateY(2px) rotate(2.5deg)"), frame(1)],
      // The first blink arrives within half a second, with a visible closed hold.
      eyes: [frame(0), frame(0.1), frame(0.135, "scaleY(0.04)"), frame(0.165, "scaleY(0.04)"), frame(0.21), frame(1)],
    },
  },
  look: {
    duration: 1100,
    tracks: {
      body: [frame(0), frame(0.3, "rotate(2deg)"), frame(0.7, "rotate(2deg)"), frame(1)],
      lever: [frame(0), frame(0.4, "rotate(6deg)"), frame(0.7, "rotate(6deg)"), frame(1)],
      face: [frame(0), frame(0.28, "translate(6px, -3px)"), frame(0.72, "translate(6px, -3px)"), frame(1)],
    },
  },
  hoverBlink: {
    duration: 2800, loop: true,
    tracks: {
      // The avatar reaches its hover scale first; one short blink then repeats while held.
      eyes: [frame(0), frame(0.13), frame(0.15, "scaleY(0.06)"), frame(0.18, "scaleY(0.06)"), frame(0.21), frame(1)],
    },
  },
  press: {
    duration: 760,
    tracks: {
      body: [frame(0), frame(0.24, "scale(1.065, 0.9)"), frame(0.34, "scale(1.065, 0.9)"), frame(0.57, "translateY(-5px) scale(0.97, 1.045)"), frame(0.8, "scale(1.015, 0.982)"), frame(1)],
      lever: [frame(0), frame(0.34, "translateY(5px) rotate(3deg)"), frame(0.59, "translateY(-4px) rotate(-8deg)"), frame(0.8, "rotate(4deg)"), frame(1)],
      eyes: [frame(0), frame(0.3, "scaleY(0.78)"), frame(0.63), frame(1)],
    },
  },
  nod: {
    duration: 760,
    tracks: {
      body: [frame(0), frame(0.34, "translateY(3px) scale(1.025, 0.964)"), frame(0.7, "scale(0.994, 1.008)"), frame(1)],
      lever: [frame(0), frame(0.42, "translateY(7px)"), frame(0.75, "translateY(-2px)"), frame(1)],
      face: [frame(0), frame(0.34, "translateY(3px)"), frame(0.76), frame(1)],
      eyes: [frame(0), frame(0.38, "scaleY(0.74)"), frame(0.72), frame(1)],
    },
  },
  working: {
    duration: 1600, loop: true,
    tracks: {
      // Two grounded beats: eyes lead, the body leans, then the joystick follows.
      // Authored SVG units scale down by about 6x in a 40px card avatar.
      body: [
        frame(0), frame(0.2, "rotate(3deg) scale(1.018, 0.97)"),
        frame(0.3, "rotate(3deg) scale(1.018, 0.97)"), frame(0.46),
        frame(0.64, "rotate(-3deg) scale(1.018, 0.97)"),
        frame(0.74, "rotate(-3deg) scale(1.018, 0.97)"), frame(0.94), frame(1),
      ],
      lever: [
        frame(0), frame(0.25, "translateY(3px) rotate(14deg)"),
        frame(0.33, "translateY(3px) rotate(14deg)"), frame(0.5),
        frame(0.69, "translateY(3px) rotate(-14deg)"),
        frame(0.77, "translateY(3px) rotate(-14deg)"), frame(0.98), frame(1),
      ],
      face: [
        frame(0), frame(0.16, "translate(5px, 2px)"),
        frame(0.28, "translate(5px, 2px)"), frame(0.44),
        frame(0.6, "translate(-5px, 2px)"),
        frame(0.72, "translate(-5px, 2px)"), frame(0.92), frame(1),
      ],
      eyes: [frame(0), frame(0.8), frame(0.84, "scaleY(0.08)"), frame(0.87, "scaleY(0.08)"), frame(0.91), frame(1)],
    },
  },
  waiting: {
    duration: 1600,
    tracks: {
      body: [frame(0), frame(0.3, "scale(0.995, 1.012)"), frame(1, "scale(0.995, 1.012)")],
      lever: [frame(0), frame(0.28, "rotate(4deg)"), frame(0.6), frame(1)],
      face: [frame(0), frame(0.28, "translateY(-4px)"), frame(1, "translateY(-4px)")],
      eyes: [frame(0), frame(0.3, "scaleY(1.07)"), frame(1, "scaleY(1.07)")],
    },
  },
  success: {
    duration: 1000,
    tracks: {
      body: [frame(0), frame(0.16, "scale(1.05, 0.93)"), frame(0.35, "translateY(-19px) scale(0.97, 1.035)"), frame(0.46, "translateY(-21px)"), frame(0.67, "scale(1.045, 0.945)"), frame(0.85, "scale(0.993, 1.01)"), frame(1)],
      lever: [frame(0), frame(0.22, "translateY(3px) rotate(3deg)"), frame(0.48, "rotate(-10deg)"), frame(0.72, "rotate(6deg)"), frame(1)],
      eyes: [frame(0), frame(0.3, "scaleY(0.24)"), frame(0.65, "scaleY(0.24)"), frame(0.88), frame(1)],
    },
  },
  blocked: {
    duration: 820,
    tracks: {
      body: [frame(0), frame(0.14, "scale(1.012, 0.97)"), frame(0.3, "translateX(-3px) rotate(-1.8deg)"), frame(0.48, "translateX(2px) rotate(1.2deg)"), frame(0.68, "rotate(-0.5deg)"), frame(1)],
      lever: [frame(0), frame(0.25, "rotate(7deg)"), frame(0.48, "rotate(-5deg)"), frame(0.7, "rotate(2deg)"), frame(1)],
      eyes: [frame(0), frame(0.2, "scaleY(0.7)"), frame(0.55, "scaleY(0.7)"), frame(1)],
    },
  },
  enter: {
    duration: 680,
    tracks: {
      body: [frame(0, "translateY(14px) scale(0.88)", 0), frame(0.58, "translateY(-4px) scale(0.98, 1.03)"), frame(0.8, "scale(1.015, 0.98)"), frame(1)],
      lever: [frame(0, "rotate(-7deg)"), frame(0.65, "rotate(4deg)"), frame(1)],
    },
  },
  exit: {
    duration: 420,
    tracks: { body: [frame(0), frame(1, "translateY(10px) scale(0.9)", 0)] },
  },
  settle: { duration: 420, tracks: {} },
};

export const subagentMotionSequence: readonly SubagentMotionId[] = [
  "enter", "nod", "working", "waiting", "working", "success", "settle",
];

export const neutralMotionFrames = () => [frame(0), frame(1)];

export function lookMotionClip(x: number, y: number): MotionClip {
  return {
    duration: 180,
    tracks: {
      body: [frame(0), frame(1, `rotate(${x * 2}deg)`)],
      lever: [frame(0), frame(1, `rotate(${x * 5}deg)`)],
      face: [frame(0), frame(1, `translate(${x * 6}px, ${y * 4}px)`)],
    },
  };
}

export const pressHoldClip: MotionClip = {
  duration: 140,
  tracks: {
    body: [frame(0), frame(1, "scale(1.065, 0.9)")],
    lever: [frame(0), frame(1, "translateY(5px) rotate(3deg)")],
    eyes: [frame(0), frame(1, "scaleY(0.78)")],
  },
};

export const pressReleaseClip: MotionClip = {
  duration: 520,
  tracks: {
    body: [frame(0), frame(0.42, "translateY(-5px) scale(0.97, 1.045)"), frame(0.73, "scale(1.015, 0.982)"), frame(1)],
    lever: [frame(0), frame(0.45, "translateY(-4px) rotate(-8deg)"), frame(0.75, "rotate(4deg)"), frame(1)],
  },
};
