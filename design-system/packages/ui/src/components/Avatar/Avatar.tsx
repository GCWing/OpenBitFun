import { Children, useState, type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import styles from "./Avatar.module.css";

export type AvatarSize = "sm" | "md" | "lg";
export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> { alt?: string; children?: ReactNode; icon?: ReactNode; onError?: () => void; shape?: "circle" | "square"; size?: AvatarSize; src?: string; }
export interface AvatarGroupProps extends HTMLAttributes<HTMLDivElement> { children: ReactNode; maxCount?: number; }

export function Avatar({ alt = "", children, className, icon, onError, shape = "circle", size = "md", src, ...props }: AvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <span {...props} className={classNames(styles.root, className)} data-openbitfun-component="avatar" data-openbitfun-shape={shape} data-size={size}>
      {src && !imageFailed
        ? <img alt={alt} className={styles.image} data-openbitfun-part="image" onError={() => { setImageFailed(true); onError?.(); }} src={src} />
        : icon !== undefined
          ? <span className={styles.content} data-openbitfun-icon-slot="true" data-openbitfun-part="icon">{icon}</span>
          : <span className={styles.content} data-openbitfun-part="text">{children}</span>}
    </span>
  );
}

export function AvatarGroup({ children, className, maxCount = 5, ...props }: AvatarGroupProps) {
  const items = Children.toArray(children);
  const visible = maxCount > 0 ? items.slice(0, maxCount) : items;
  const hiddenCount = Math.max(0, items.length - visible.length);
  return <div {...props} className={classNames(styles.group, className)} data-openbitfun-component="avatar-group">{visible}{hiddenCount > 0 && <Avatar aria-label={`${hiddenCount} more`}>+{hiddenCount}</Avatar>}</div>;
}
