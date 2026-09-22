/**
 * Adaptive typewriter for streaming text.
 *
 * Incoming content is often batched (EventBatcher). This hook drains the
 * backlog with rAF-aligned ticks, soft acceleration from backlog depth, and
 * a hard per-paint character cap so reveals stay stepped rather than snapped.
 *
 * When the model stream ends (`animate` becomes false) the hook keeps
 * revealing at the maximum finish rate until the backlog is drained — it
 * never snaps the remaining text into view. History / non-animated mounts
 * still start at the full target text.
 */

import { useState, useEffect, useRef } from 'react';

interface GraphemeSegment {
  index: number;
  segment: string;
}

interface GraphemeSegmenter {
  segment: (text: string) => Iterable<GraphemeSegment>;
}

type GraphemeSegmenterConstructor = new (
  locale?: string | string[],
  options?: { granularity: 'grapheme' },
) => GraphemeSegmenter;

let cachedGraphemeSegmenter: GraphemeSegmenter | null | undefined;

function getGraphemeSegmenter(): GraphemeSegmenter | null {
  if (cachedGraphemeSegmenter !== undefined) return cachedGraphemeSegmenter;
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: GraphemeSegmenterConstructor;
  }).Segmenter;
  cachedGraphemeSegmenter = Segmenter
    ? new Segmenter(undefined, { granularity: 'grapheme' })
    : null;
  return cachedGraphemeSegmenter;
}

/**
 * Move a requested UTF-16 offset to the end of its grapheme. This prevents a
 * paint from exposing half an emoji, combining sequence, or ZWJ family.
 */
export function safeGraphemeRevealEnd(
  text: string,
  requestedEnd: number,
  knownBoundary = 0,
): number {
  const clampedEnd = Math.max(0, Math.min(text.length, Math.floor(requestedEnd)));
  if (clampedEnd === 0 || clampedEnd === text.length) return clampedEnd;
  const segmentStart = Math.max(0, Math.min(clampedEnd, Math.floor(knownBoundary)));
  const remaining = text.slice(segmentStart);

  const segmenter = getGraphemeSegmenter();
  if (segmenter) {
    for (const part of segmenter.segment(remaining)) {
      const segmentEnd = segmentStart + part.index + part.segment.length;
      if (segmentEnd >= clampedEnd) return segmentEnd;
    }
    return text.length;
  }

  // Older WebViews without Intl.Segmenter still must not split surrogate
  // pairs. Array.from iterates Unicode code points rather than UTF-16 units.
  let codePointEnd = segmentStart;
  for (const codePoint of Array.from(remaining)) {
    codePointEnd += codePoint.length;
    if (codePointEnd >= clampedEnd) return codePointEnd;
  }
  return text.length;
}

function getPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Steady reveal rate while backlog is small (live streaming). */
export const TYPEWRITER_BASE_CHARS_PER_SEC = 90;

/**
 * Extra chars/sec added per backlog character during live streaming.
 * Example: backlog 100 → +200 chars/sec on top of base (before cap).
 */
export const TYPEWRITER_ACCEL_CHARS_PER_SEC_PER_BACKLOG = 2;

/** Live-stream ceiling before finish mode. */
export const TYPEWRITER_MAX_CHARS_PER_SEC = 720;

/**
 * Absolute ceiling used after the model stream ends. Drain remaining text
 * as fast as stepped paints allow.
 */
export const TYPEWRITER_FINISH_CHARS_PER_SEC = 2400;

/** Live streaming hard cap per React paint. */
export const TYPEWRITER_MAX_CHARS_PER_PAINT = 18;

/** Finish-mode hard cap per React paint — still stepped, much faster. */
export const TYPEWRITER_FINISH_MAX_CHARS_PER_PAINT = 64;

/**
 * Minimum time between setState paints during live streaming. Keeps Markdown
 * from being forced to a full re-parse on every display frame.
 */
export const TYPEWRITER_MIN_PAINT_INTERVAL_MS = 16;

/** Finish mode paints every animation frame budget. */
export const TYPEWRITER_FINISH_MIN_PAINT_INTERVAL_MS = 8;

export interface TypewriterOptions {
  /** Skip playback and drain immediately, e.g. when the owning body is hidden.
   * Unlike animate=false (stream finished), this does not animate the backlog.
   */
  revealImmediately?: boolean;
  /**
   * Replay the whole current text on mount. Defaults to false: mounting starts
   * from the current text and only reveals later appended content.
   *
   * Replaying on mount is almost never what you want in the message list. The
   * list is virtualized, so a still-streaming block that scrolls out of view and
   * back remounts — replaying would reset it to an empty string and re-grow it,
   * which the user sees as the conversation refreshing itself.
   */
  replayOnMount?: boolean;
}

export interface TypewriterCharsPerSecInput {
  backlog: number;
  /** True when the model stream has ended but characters remain to reveal. */
  finishing?: boolean;
}

export interface TypewriterResult {
  displayText: string;
  /** True while displayed text is still catching up to the target. */
  isRevealing: boolean;
}

/**
 * Soft-accelerated reveal rate for the current backlog.
 * Finish mode jumps to the absolute maximum drain rate.
 */
export function computeTypewriterCharsPerSec(
  backlogOrInput: number | TypewriterCharsPerSecInput,
  finishingArg?: boolean
): number {
  const backlog = typeof backlogOrInput === 'number'
    ? backlogOrInput
    : backlogOrInput.backlog;
  const finishing = typeof backlogOrInput === 'number'
    ? Boolean(finishingArg)
    : Boolean(backlogOrInput.finishing);

  if (finishing) {
    return TYPEWRITER_FINISH_CHARS_PER_SEC;
  }

  const safeBacklog = Math.max(0, backlog);
  return Math.min(
    TYPEWRITER_BASE_CHARS_PER_SEC
      + safeBacklog * TYPEWRITER_ACCEL_CHARS_PER_SEC_PER_BACKLOG,
    TYPEWRITER_MAX_CHARS_PER_SEC
  );
}

export interface TypewriterRevealCommitInput {
  backlog: number;
  fractionalCarry: number;
  maxCharsPerPaint?: number;
}

export interface TypewriterRevealCommit {
  chars: number;
  fractionalCarry: number;
}

/**
 * Commit accumulated fractional characters into an integer paint step.
 */
export function commitTypewriterReveal(
  input: TypewriterRevealCommitInput
): TypewriterRevealCommit {
  const backlog = Math.max(0, Math.floor(input.backlog));
  const maxCharsPerPaint = Math.max(
    1,
    input.maxCharsPerPaint ?? TYPEWRITER_MAX_CHARS_PER_PAINT
  );
  let fractionalCarry = Number.isFinite(input.fractionalCarry)
    ? Math.max(0, input.fractionalCarry)
    : 0;

  if (backlog <= 0) {
    return { chars: 0, fractionalCarry: 0 };
  }

  const chars = Math.min(
    backlog,
    Math.floor(fractionalCarry),
    maxCharsPerPaint
  );
  fractionalCarry = Math.max(0, fractionalCarry - chars);
  return { chars, fractionalCarry };
}

export function useTypewriter(
  targetText: string,
  animate: boolean,
  options: TypewriterOptions = {}
): TypewriterResult {
  const replayOnMount = options.replayOnMount ?? false;
  const revealImmediately = options.revealImmediately ?? false;
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(getPrefersReducedMotion);
  const shouldReplayInitialText = animate && replayOnMount && !prefersReducedMotion && !revealImmediately;
  const [displayText, setDisplayText] = useState(shouldReplayInitialText ? '' : targetText);
  const revealedRef = useRef(shouldReplayInitialText ? 0 : targetText.length);
  const targetRef = useRef(targetText);
  const animateRef = useRef(animate);
  const rafRef = useRef<number | null>(null);
  const lastTickMsRef = useRef<number | null>(null);
  const lastPaintMsRef = useRef(0);
  const fractionalCarryRef = useRef(0);

  const isRevealing = !revealImmediately && !prefersReducedMotion
    && (animate || displayText.length < targetText.length);

  useEffect(() => {
    animateRef.current = animate;
    targetRef.current = targetText;

    const pageIsHidden = typeof document !== 'undefined'
      && document.visibilityState === 'hidden';
    if (revealImmediately || prefersReducedMotion || pageIsHidden) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTickMsRef.current = null;
      lastPaintMsRef.current = 0;
      fractionalCarryRef.current = 0;
      revealedRef.current = targetText.length;
      setDisplayText(targetText);
      return;
    }

    // Reset when target shrinks (e.g. new round).
    if (targetText.length < revealedRef.current) {
      revealedRef.current = 0;
      fractionalCarryRef.current = 0;
      lastPaintMsRef.current = 0;
      setDisplayText('');
    }

    // History / completed mounts that never started a reveal stay fully shown.
    // If we are still behind when `animate` flips false, fall through and keep
    // draining with the typewriter instead of snapping the remainder.
    if (!animate && revealedRef.current >= targetText.length) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTickMsRef.current = null;
      fractionalCarryRef.current = 0;
      revealedRef.current = targetText.length;
      setDisplayText(targetText);
      return;
    }

    const tick = (nowMs: number) => {
      rafRef.current = null;

      const target = targetRef.current;
      let revealed = revealedRef.current;

      if (target.length < revealed) {
        revealed = 0;
        revealedRef.current = 0;
        fractionalCarryRef.current = 0;
      }

      const backlog = target.length - revealed;
      if (backlog <= 0) {
        lastTickMsRef.current = null;
        fractionalCarryRef.current = 0;
        if (revealedRef.current !== target.length) {
          revealedRef.current = target.length;
          setDisplayText(target);
        }
        return;
      }

      const lastTickMs = lastTickMsRef.current;
      lastTickMsRef.current = nowMs;
      const finishing = !animateRef.current;
      const minPaintInterval = finishing
        ? TYPEWRITER_FINISH_MIN_PAINT_INTERVAL_MS
        : TYPEWRITER_MIN_PAINT_INTERVAL_MS;
      const maxCharsPerPaint = finishing
        ? TYPEWRITER_FINISH_MAX_CHARS_PER_PAINT
        : TYPEWRITER_MAX_CHARS_PER_PAINT;
      const dtMs = lastTickMs === null
        ? minPaintInterval
        : Math.min(100, Math.max(0, nowMs - lastTickMs));

      const charsPerSec = computeTypewriterCharsPerSec({ backlog, finishing });
      fractionalCarryRef.current += (charsPerSec * dtMs) / 1000;
      fractionalCarryRef.current = Math.min(
        fractionalCarryRef.current,
        backlog + maxCharsPerPaint
      );

      const sincePaint = nowMs - lastPaintMsRef.current;
      const canPaint = lastPaintMsRef.current === 0
        || sincePaint >= minPaintInterval;

      if (canPaint) {
        const committed = commitTypewriterReveal({
          backlog,
          fractionalCarry: fractionalCarryRef.current,
          maxCharsPerPaint,
        });
        fractionalCarryRef.current = committed.fractionalCarry;

        if (committed.chars > 0) {
          const next = safeGraphemeRevealEnd(
            target,
            revealed + committed.chars,
            revealed,
          );
          revealedRef.current = next;
          lastPaintMsRef.current = nowMs;
          setDisplayText(target.slice(0, next));
        }
      }

      if (revealedRef.current < targetRef.current.length) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        lastTickMsRef.current = null;
      }
    };

    if (rafRef.current === null && targetText.length > revealedRef.current) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [targetText, animate, prefersReducedMotion, revealImmediately]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (event: MediaQueryListEvent) => setPrefersReducedMotion(event.matches);
    setPrefersReducedMotion(media.matches);
    media.addEventListener?.('change', handleChange);
    return () => media.removeEventListener?.('change', handleChange);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const revealLatestImmediately = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const target = targetRef.current;
      lastTickMsRef.current = null;
      lastPaintMsRef.current = 0;
      fractionalCarryRef.current = 0;
      revealedRef.current = target.length;
      setDisplayText(target);
    };
    document.addEventListener('visibilitychange', revealLatestImmediately);
    return () => document.removeEventListener('visibilitychange', revealLatestImmediately);
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return { displayText: revealImmediately ? targetText : displayText, isRevealing };
}
