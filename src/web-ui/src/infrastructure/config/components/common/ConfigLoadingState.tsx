import React, { useEffect, useState } from 'react';
import { LoadingState } from '@openbitfun/ui';
import './ConfigPageState.scss';

/**
 * Reserve content geometry immediately; delay only the loading announcement.
 * Returning null during the grace period collapses surrounding settings sections.
 */
const LOADING_VISIBLE_DELAY_MS = 200;

export interface ConfigLoadingStateProps {
  label: string;
  className?: string;
  /** Override the grace period; 0 paints immediately. */
  graceMs?: number;
  variant?: 'form' | 'list' | 'statistics';
  rows?: number;
}

export const ConfigLoadingState: React.FC<ConfigLoadingStateProps> = ({
  label,
  className = '',
  graceMs = LOADING_VISIBLE_DELAY_MS,
  variant = 'form',
  rows = 3,
}) => {
  const [visible, setVisible] = useState(graceMs <= 0);

  useEffect(() => {
    if (graceMs <= 0) {
      setVisible(true);
      return;
    }

    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), graceMs);
    return () => window.clearTimeout(timer);
  }, [graceMs]);

  return (
    <div
      className={['openbitfun-config-loading-state', className].filter(Boolean).join(' ')}
      aria-busy="true"
      aria-label={label}
      data-loading-variant={variant}
      data-openbitfun-component="config"
      data-openbitfun-part="loadingState"
    >
      <div className="openbitfun-config-loading-state__skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div className="openbitfun-config-loading-state__row" key={index}>
            <span className="openbitfun-config-loading-state__copy" />
            <span className="openbitfun-config-loading-state__control" />
          </div>
        ))}
      </div>
      <div className="openbitfun-config-loading-state__status" role="status" aria-live="polite">
        {visible ? <LoadingState size="sm">{label}</LoadingState> : null}
      </div>
    </div>
  );
};
