import React from 'react';

export type ConnectionStateTone = 'success' | 'warning' | 'neutral';

/**
 * A connection state as the device card draws it: a coloured dot and a quiet
 * label. A live link breathes, like the card's in-use signal.
 */
export function ConnectionStateMark({ tone, live = tone === 'success', children }: {
  tone: ConnectionStateTone;
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className="openbitfun-remote-connect__state-mark"
      data-openbitfun-component="remote-connect-dialog"
      data-openbitfun-part="stateMark"
      data-tone={tone}
      data-live={live || undefined}
    >
      <span className="openbitfun-remote-connect__state-dot" aria-hidden="true" />
      {children}
    </span>
  );
}
