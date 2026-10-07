import { useLayoutEffect, useMemo, useRef } from "react";
import { useReducedMotion } from "../../internal/useReducedMotion";
import styles from "./ToolCardRollingNumber.module.css";

/** Higher wheels move only during the last unit before their carry. */
function digitPosition(value: number, place: number): number {
  const unit = 10 ** place;
  const digit = Math.floor(value / unit) % 10;
  const carry = Math.max(0, value % unit - (unit - 1));
  return digit + carry;
}

/** Internal change-summary renderer; formatting remains owned by the host. */
export function ToolCardRollingNumber({ value }: { value: number | string }) {
  const text = String(value);
  const target = /^\d+(?:[,\u00a0\u202f ]\d{3})*$/.test(text)
    ? Number(text.replace(/[,\u00a0\u202f ]/g, "")) : NaN;
  const supported = Number.isSafeInteger(target) && target >= 0;
  const reducedMotion = useReducedMotion();
  const rootRef = useRef<HTMLSpanElement>(null);
  const wheels = useRef(new Map<number, HTMLSpanElement>());
  const current = useRef(target);
  const parts = useMemo(() => {
    let place = (text.match(/\d/g)?.length ?? 0) - 1;
    return Array.from(text, character => {
      if (!/\d/.test(character)) return { character, place: null, key: `separator-${place}` };
      const digitPlace = place--;
      return { character, place: digitPlace, key: `digit-${digitPlace}` };
    });
  }, [text]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const view = root?.ownerDocument.defaultView;
    const paint = (value: number) => {
      current.current = value;
      for (const [place, wheel] of wheels.current) {
        wheel.style.transform = `translateY(-${digitPosition(value, place)}lh)`;
        wheel.style.visibility = place > 0 && value < 10 ** place - 1 ? "hidden" : "visible";
      }
    };
    if (!supported || reducedMotion || !root || !view
      || !view.requestAnimationFrame || !Number.isFinite(current.current) || target <= current.current) {
      paint(target);
      return;
    }
    const durationToken = view.getComputedStyle(root).getPropertyValue("--openbitfun-motion-duration-base").trim();
    const duration = parseFloat(durationToken) * (durationToken.endsWith("ms") ? 1 : 1000);
    if (!Number.isFinite(duration) || duration <= 0) {
      paint(target);
      return;
    }
    // Retarget from the visible position so rapid stream batches never restart
    // from an unseen intermediate total or build a long animation backlog.
    const from = current.current;
    const started = view.performance.now();
    paint(from);
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - started) / duration));
      const eased = 1 - (1 - progress) ** 3;
      paint(progress === 1 ? target : from + (target - from) * eased);
      if (progress < 1) frame = view.requestAnimationFrame(tick);
    };
    frame = view.requestAnimationFrame(tick);
    return () => view.cancelAnimationFrame(frame);
  }, [reducedMotion, supported, target]);

  if (!supported || reducedMotion) return <>{text}</>;

  return (
    <span ref={rootRef} className={styles.root} data-rolling-number={text}>
      <span className={styles.accessibleValue}>{text}</span>
      <span aria-hidden="true" className={styles.wheels}>
        {parts.map(part => part.place === null ? (
          <span key={part.key}>{part.character}</span>
        ) : (
          <span key={part.key} className={styles.window} data-digit-place={part.place}>
            <span
              className={styles.strip}
              ref={node => {
                if (node) wheels.current.set(part.place!, node);
                else wheels.current.delete(part.place!);
              }}
              style={{ transform: `translateY(-${digitPosition(target, part.place)}lh)` }}
            >
              {Array.from({ length: 11 }, (_, digit) => (
                <span key={digit} className={styles.digit}>
                  {digit === 0 && part.place! > 0 && part === parts[0] ? "\u00a0" : digit % 10}
                </span>
              ))}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}
