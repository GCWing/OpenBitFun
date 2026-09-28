/**
 * SplashScreen — full-screen loading overlay shown on app start.
 *
 * Idle:    vector mark at the reference scale with a subtle breathing motion.
 * Exiting: logo scales up and fades; backdrop dissolves.
 */

import React, { useEffect, useCallback, useState } from 'react';
import { OpenBitFunMark } from '@openbitfun/ui/brand';
import './SplashScreen.scss';

const DEFAULT_LOADING_MESSAGE_DELAY_MS = 1800;

interface SplashScreenProps {
  isExiting: boolean;
  onExited: () => void;
  delayedMessage?: string;
  delayedMessageMs?: number;
}

const SplashScreen: React.FC<SplashScreenProps> = ({
  isExiting,
  onExited,
  delayedMessage,
  delayedMessageMs = DEFAULT_LOADING_MESSAGE_DELAY_MS,
}) => {
  const [showDelayedMessage, setShowDelayedMessage] = useState(false);
  const handleExited = useCallback(() => {
    onExited();
  }, [onExited]);

  useEffect(() => {
    setShowDelayedMessage(false);

    if (!delayedMessage || isExiting) {
      return;
    }

    const timer = window.setTimeout(() => {
      setShowDelayedMessage(true);
    }, delayedMessageMs);
    return () => window.clearTimeout(timer);
  }, [delayedMessage, delayedMessageMs, isExiting]);

  // Remove from DOM after exit animation completes (~650 ms).
  useEffect(() => {
    if (!isExiting) return;
    const timer = window.setTimeout(handleExited, 650);
    return () => window.clearTimeout(timer);
  }, [isExiting, handleExited]);

  return (
    <div data-openbitfun-component="splash-screen" data-openbitfun-part="root" data-openbitfun-state={isExiting ? 'exiting' : ''}
      className={`splash-screen${isExiting ? ' splash-screen--exiting' : ''}`}
      aria-hidden={!showDelayedMessage}
    >
      <div className="splash-screen__center" data-openbitfun-component="splash-screen" data-openbitfun-part="center">
        <div className="splash-screen__logo-wrap" data-openbitfun-component="splash-screen" data-openbitfun-part="logo">
          <OpenBitFunMark className="splash-screen__logo" motion="breathe" active={!isExiting} />
        </div>
        {showDelayedMessage && delayedMessage && !isExiting && (
          <div
            className="splash-screen__message splash-screen__message--visible"
            data-openbitfun-component="splash-screen"
            data-openbitfun-part="message"
            role="status"
            aria-live="polite"
          >
            {delayedMessage}
          </div>
        )}
      </div>
    </div>
  );
};

export default SplashScreen;
