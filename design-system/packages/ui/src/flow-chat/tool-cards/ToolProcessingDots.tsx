import { OpenBitFunBrandMotion } from "../../brand/OpenBitFunBrandMotion";
import { classNames } from "../../internal/classNames";
import styles from "./ToolProcessingDots.module.css";

export type ToolProcessingDotsSize = 10 | 12 | 14 | 16;

export interface ToolProcessingDotsProps {
  className?: string;
  size?: ToolProcessingDotsSize;
}

/** Compatibility entry for processing indicators; artwork is owned by the brand component. */
export function ToolProcessingDots({
  className,
  size = 14,
}: ToolProcessingDotsProps) {
  return (
    <span
      aria-hidden="true"
      className={classNames(styles.root, className)}
      data-openbitfun-component="flow-chat-tool-card"
      data-openbitfun-part="processing"
      data-size={size}
      role="presentation"
    >
      <OpenBitFunBrandMotion variant="construction" size={size} />
    </span>
  );
}
