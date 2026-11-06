/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../types/flow-chat';
import {
  sessionSupportsThreadGoal,
  useComposerCapabilities,
  type ComposerCapabilities,
} from './useComposerCapabilities';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface CapabilitiesProbeProps {
  sessionId: string;
  session: Session | undefined;
  onCapabilities: (capabilities: ComposerCapabilities) => void;
}

function CapabilitiesProbe({ sessionId, session, onCapabilities }: CapabilitiesProbeProps) {
  onCapabilities(useComposerCapabilities({
    sessionId,
    session,
    hostMasksDispatch: false,
    displayAsChild: false,
  }));
  return null;
}

describe('sessionSupportsThreadGoal', () => {
  it('supports OpenBitFun runtime primary agents, including Claw', () => {
    expect(sessionSupportsThreadGoal({ config: { agentType: 'Claw' }, mode: 'Claw' })).toBe(true);
  });

  it('does not advertise OpenBitFun thread goals for ACP-owned agents', () => {
    expect(
      sessionSupportsThreadGoal({ config: { agentType: 'acp:codex' }, mode: 'acp:codex' }),
    ).toBe(false);
    expect(sessionSupportsThreadGoal({ config: {}, mode: 'acp:claude-code' })).toBe(false);
  });
});

describe('composer slash command surface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const readCapabilities = (sessionId: string, session: Session | undefined) => {
    let capabilities: ComposerCapabilities | null = null;
    act(() => {
      root.render(
        <CapabilitiesProbe
          sessionId={sessionId}
          session={session}
          onCapabilities={next => { capabilities = next; }}
        />,
      );
    });
    if (!capabilities) throw new Error('capabilities were not reported');
    return capabilities as ComposerCapabilities;
  };

  it('offers /model wherever the composer renders the model selector', () => {
    const local = readCapabilities(
      'local-session',
      { config: { agentType: 'Standard' } } as unknown as Session,
    );
    expect(local.ops.has('model')).toBe(true);

    // A detached target owns its model choice through the composer's probe, so
    // the command stays local to the renderer instead of becoming turn text.
    const detached = readCapabilities(
      'dispatch-session',
      { config: { agentType: 'Standard', dispatchJobId: 'job-1' } } as unknown as Session,
    );
    expect(detached.dispatchTransport).toBe(true);
    expect(detached.ops.has('model')).toBe(true);
  });
});
