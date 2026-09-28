import type { MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "../../components/Icon/Icon";
import { IconButton } from "../../components/IconButton/IconButton";

export interface ToolCardCopyButtonProps {
  className?: string;
  copied?: boolean;
  copiedLabel?: string;
  disabled?: boolean;
  label: string;
  onPress: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  testId?: string;
}

export function ToolCardCopyButton({
  className,
  copied = false,
  copiedLabel,
  disabled,
  label,
  onPress,
  testId,
}: ToolCardCopyButtonProps) {
  const resolvedLabel = copied && copiedLabel ? copiedLabel : label;

  return (
    <IconButton
      aria-label={resolvedLabel}
      className={className}
      data-openbitfun-action="copy"
      data-openbitfun-part="copyButton"
      data-openbitfun-state={copied ? "copied" : undefined}
      disabled={disabled}
      icon={<Icon name={copied ? "check-line" : "duplicate"} size="sm" />}
      onClick={onPress}
      size="sm"
      data-testid={testId}
      title={resolvedLabel}
      variant="quiet"
    />
  );
}
