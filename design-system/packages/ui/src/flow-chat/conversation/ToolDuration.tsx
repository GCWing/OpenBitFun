import type { ReactNode } from 'react';
import { Timer, Infinity as InfinityIcon } from 'lucide-react';
import { Icon } from '../../components/Icon/Icon';
import './ToolDuration.css';

export function formatDurationLive(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatDurationPrecise(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export interface ToolDurationProps {
  isRunning: boolean;
  /** Show the leading timer icon for a live duration. */
  showIcon?: boolean;
  elapsedMs?: number;
  remainingMs?: number | null;
  timeoutMs?: number;
  timeoutDisabled?: boolean;
  open?: boolean;
  completedDurationMs?: number;
  showCompletedDuration?: boolean;
  completedStatus?: 'success' | 'error' | 'cancelled';
  completionLabel?: string;
  children?: ReactNode;
}

/** Controlled duration anatomy. Clock, timeout mutations and overlays belong to the host. */
export function ToolDuration({
  isRunning, showIcon = true, elapsedMs = 0, remainingMs, timeoutMs, timeoutDisabled = false, open = false,
  completedDurationMs, showCompletedDuration = true, completedStatus, completionLabel, children,
}: ToolDurationProps) {
  if (!isRunning) {
    if (completedDurationMs == null || !showCompletedDuration) return null;
    return <span data-openbitfun-component="tool-timeout-indicator" data-openbitfun-part="root" data-openbitfun-mode="completed"
      className={`duration-text duration-text--completed${completedStatus ? ` duration-text--completed-${completedStatus}` : ''}`}
      title={completionLabel} aria-label={completionLabel}>
      <span data-openbitfun-component="tool-timeout-indicator" data-openbitfun-part="duration">{formatDurationPrecise(completedDurationMs)}</span>
    </span>;
  }
  const hasTimeout = Boolean(timeoutMs && timeoutMs > 0);
  const displayRemaining = timeoutDisabled ? null : remainingMs;
  const isWarning = displayRemaining != null && hasTimeout && displayRemaining < timeoutMs! * 0.2;
  return <span data-openbitfun-component="tool-timeout-indicator" data-openbitfun-part="root" data-openbitfun-mode="live"
    data-openbitfun-state={[isWarning && 'warning', timeoutDisabled && 'disabled', open && 'open'].filter(Boolean).join(' ')} className="tool-timeout-indicator">
    <span data-openbitfun-component="tool-timeout-indicator" data-openbitfun-part="duration" className={`duration-text duration-text--live ${isWarning ? 'duration-text--warning' : ''}`}>
      {showIcon && <Icon glyph={Timer} size="sm" />}
      <span data-openbitfun-component="tool-timeout-indicator" data-openbitfun-part="elapsed" className="duration-elapsed">{formatDurationLive(elapsedMs)}</span>
      {hasTimeout && <>
        <span className="duration-separator">/</span>
        <span data-openbitfun-component="tool-timeout-indicator" data-openbitfun-part="timeout"
          className={`duration-timeout ${timeoutDisabled ? 'duration-timeout--disabled' : ''} ${isWarning ? 'duration-timeout--warning' : ''}`}>
          {timeoutDisabled ? <Icon glyph={InfinityIcon} size="sm" className="duration-timeout--infinity" />
            : formatDurationLive(displayRemaining ?? timeoutMs!)}
        </span>
      </>}
    </span>
    {children}
  </span>;
}
