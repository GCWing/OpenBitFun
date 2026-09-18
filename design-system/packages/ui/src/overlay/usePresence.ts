import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../internal/useReducedMotion";

export type PresenceState = "entering" | "entered" | "exiting";

export interface PresenceSnapshot {
  present: boolean;
  state: PresenceState;
}

export function usePresence(open: boolean, exitDurationMs: number): PresenceSnapshot {
  const [present, setPresent] = useState(open);
  const [state, setState] = useState<PresenceState>(open ? "entered" : "exiting");
  const presentRef = useRef(present);
  const stateRef = useRef(state);
  stateRef.current = state;
  const previousOpenRef = useRef(false);
  const exitDeadlineRef = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  // `useReducedMotion` deliberately returns true for SSR. Presence effects only
  // run in a browser, so collapse timing only when the browser explicitly
  // exposes and matches the preference. This also keeps non-visual DOM hosts
  // on the ordinary mount and exit lifecycle.
  const prefersReducedMotion = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && reducedMotion;

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;
    const updateState = (next: PresenceState) => {
      stateRef.current = next;
      setState(next);
    };

    const finishExit = () => {
      exitDeadlineRef.current = null;
      presentRef.current = false;
      setPresent(false);
    };

    // Once an exit has committed, keep its original deadline and geometry.
    // A motion-preference change may settle an entrance, but must not tear down
    // content that its owner is retaining until `onExitComplete`.
    if (!open && presentRef.current && stateRef.current === "exiting" && exitDeadlineRef.current !== null) {
      const view = typeof window === "undefined" ? null : window;
      if (!view) {
        finishExit();
        return;
      }
      const remainingMs = Math.max(0, exitDeadlineRef.current - Date.now());
      const timer = view.setTimeout(finishExit, remainingMs);
      return () => view.clearTimeout(timer);
    }

    if (prefersReducedMotion) {
      exitDeadlineRef.current = null;
      presentRef.current = open;
      setPresent(open);
      updateState(open ? "entered" : "exiting");
      return;
    }
    if (open) {
      exitDeadlineRef.current = null;
      const wasPresent = presentRef.current;
      if (!wasPresent) {
        presentRef.current = true;
        setPresent(true);
      }
      // An interrupted exit still has a rendered surface. Reverse its transition
      // from the current painted value instead of resetting to the entrance pose.
      if (wasPresent && stateRef.current === "exiting") {
        updateState("entered");
        return;
      }
      // A preference change from reduced to ordinary motion must not replay an
      // entrance on a surface that is already open. The `entering` branch also
      // lets React strict effects cancel and restart the two-frame handoff.
      if (wasOpen && stateRef.current !== "entering") return;
      updateState("entering");
      const view = typeof window === "undefined" ? null : window;
      if (!view) {
        updateState("entered");
        return;
      }
      let firstFrame = 0;
      let secondFrame = 0;
      firstFrame = view.requestAnimationFrame(() => {
        secondFrame = view.requestAnimationFrame(() => updateState("entered"));
      });
      return () => {
        view.cancelAnimationFrame(firstFrame);
        view.cancelAnimationFrame(secondFrame);
      };
    }

    if (!presentRef.current) return;
    updateState("exiting");
    exitDeadlineRef.current = Date.now() + exitDurationMs;
    const view = typeof window === "undefined" ? null : window;
    if (!view) {
      finishExit();
      return;
    }
    const timer = view.setTimeout(finishExit, exitDurationMs);
    return () => view.clearTimeout(timer);
  }, [exitDurationMs, open, prefersReducedMotion]);

  return { present, state };
}
