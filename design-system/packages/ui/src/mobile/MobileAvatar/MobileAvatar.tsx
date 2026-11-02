import { type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import styles from "./MobileAvatar.module.css";

export type MobileAvatarShape = "circle" | "rounded";
export type MobileAvatarSize = "xs" | "sm" | "md" | "lg";
export type MobileAvatarStatus = "online" | "away" | "busy" | "offline";

export interface MobileAvatarProps extends HTMLAttributes<HTMLSpanElement> {
  alt?: string;
  children?: ReactNode;
  name?: string;
  shape?: MobileAvatarShape;
  size?: MobileAvatarSize;
  src?: string;
  status?: MobileAvatarStatus;
  statusLabel?: string;
}

/** Two letters is all a fallback can carry before it stops being readable at avatar scale. */
function initialsOf(name: string) {
  const parts = name.split(/[\s\-_]+/).filter(Boolean);
  return parts.slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("");
}

/** A mobile identity mark: character artwork, an image, or initials. The status dot carries its own
    label when the caller supplies one, because a colour alone is not a status. */
export function MobileAvatar({
  alt,
  children,
  className,
  name,
  shape = "circle",
  size = "md",
  src,
  status,
  statusLabel,
  ...props
}: MobileAvatarProps) {
  const label = alt || name;
  return (
    <span
      {...props}
      aria-label={label}
      className={classNames(styles.root, className)}
      data-openbitfun-component="mobile-avatar"
      data-shape={shape}
      data-size={size}
      role={label ? "img" : undefined}
    >
      {children !== undefined && children !== null
        ? <span aria-hidden="true" className={styles.content} data-openbitfun-part="content">{children}</span>
        : src !== undefined && src !== null
          ? <img alt="" className={styles.image} data-openbitfun-part="image" draggable={false} height={48} src={src} width={48} />
          : <span aria-hidden="true" className={styles.initials} data-openbitfun-part="initials">{initialsOf(name ?? "")}</span>}
      {status !== undefined && status !== null && (
        <span
          aria-label={statusLabel}
          aria-hidden={statusLabel ? undefined : true}
          className={styles.status}
          data-openbitfun-part="status"
          data-status={status}
          role={statusLabel ? "img" : undefined}
        />
      )}
    </span>
  );
}
