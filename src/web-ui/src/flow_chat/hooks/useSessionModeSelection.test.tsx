/**
 * @vitest-environment jsdom
 */

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionModeSelection } from './useSessionModeSelection';

const mocks = vi.hoisted(() => ({
  updateSessionMode: vi.fn(),
  publish: vi.fn(),
  reportFailure: vi.fn(),
  committed: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: { updateSessionMode: mocks.updateSessionMode },
}));

function Probe({
  sessionId = 'session-1',
  draft = false,
  publish = mocks.publish,
}: {
  sessionId?: string;
  draft?: boolean;
  publish?: (modeId: string) => void;
}) {
  const selection = useSessionModeSelection(
    {
      sessionId,
      draft,
      workspacePath: 'D:/workspace/project',
    },
    publish,
    mocks.reportFailure,
    mocks.committed,
  );
  return (
    <>
      <span data-testid="pending">{String(selection.isModeChangePending)}</span>
      <button type="button" onClick={() => selection.publishModeSelection('Standard')}>
        Hydrate
      </button>
      <button type="button" onClick={() => selection.requestModeChange('Standard')}>
        Select
      </button>
      <button type="button" onClick={() => selection.requestModeChange('ask')}>
        Select Ask
      </button>
    </>
  );
}

describe('useSessionModeSelection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.updateSessionMode.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps an explicit draft selection local until a host session exists', async () => {
    await act(async () => root.render(<Probe draft />));
    const select = Array.from(container.querySelectorAll('button'))[2];
    act(() => select.click());
    expect(mocks.publish).toHaveBeenCalledWith('ask');
    expect(mocks.committed).toHaveBeenCalledWith('ask');
    expect(mocks.updateSessionMode).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe('false');
  });

  it('keeps passive hydration local and rebinds an explicit same-id selection', async () => {
    await act(async () => {
      root.render(<StrictMode><Probe /></StrictMode>);
    });
    const [hydrate, select] = Array.from(container.querySelectorAll('button'));

    act(() => hydrate.click());
    expect(mocks.publish).toHaveBeenCalledWith('Standard');
    expect(mocks.updateSessionMode).not.toHaveBeenCalled();
    expect(mocks.committed).not.toHaveBeenCalled();

    await act(async () => {
      select.click();
      await Promise.resolve();
    });
    expect(mocks.updateSessionMode).toHaveBeenCalledWith({
      sessionId: 'session-1',
      modeId: 'Standard',
      workspacePath: 'D:/workspace/project',
      remoteConnectionId: undefined,
      remoteSshHost: undefined,
    });
    expect(mocks.publish).toHaveBeenLastCalledWith('Standard');
    expect(mocks.committed).toHaveBeenCalledWith('Standard');
  });

  it('publishes a completed request only to the session that issued it', async () => {
    let resolveRequest: (() => void) | undefined;
    mocks.updateSessionMode.mockImplementation(() => new Promise<void>(resolve => {
      resolveRequest = resolve;
    }));
    const publishA = vi.fn();
    const publishB = vi.fn();

    await act(async () => {
      root.render(<Probe sessionId="session-a" publish={publishA} />);
    });
    const select = Array.from(container.querySelectorAll('button'))[1];
    act(() => select.click());

    await act(async () => {
      root.render(<Probe sessionId="session-b" publish={publishB} />);
    });
    await act(async () => {
      resolveRequest?.();
      await Promise.resolve();
    });

    expect(publishA).toHaveBeenCalledWith('Standard');
    expect(publishB).not.toHaveBeenCalled();
  });

  it('serializes a pending update and preserves the latest explicit selection', async () => {
    const resolvers: Array<() => void> = [];
    mocks.updateSessionMode.mockImplementation(() => new Promise<void>(resolve => {
      resolvers.push(resolve);
    }));

    await act(async () => {
      root.render(<StrictMode><Probe /></StrictMode>);
    });
    const [, selectAgentic, selectAsk] = Array.from(container.querySelectorAll('button'));
    act(() => {
      selectAgentic.click();
      selectAsk.click();
    });
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe('true');
    expect(mocks.updateSessionMode).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0]();
      await Promise.resolve();
    });
    expect(mocks.updateSessionMode).toHaveBeenCalledTimes(2);
    expect(mocks.updateSessionMode).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      modeId: 'ask',
    }));
    expect(mocks.publish).toHaveBeenCalledWith('Standard');

    await act(async () => {
      resolvers[1]();
      await Promise.resolve();
    });
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenLastCalledWith('ask');
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe('false');
  });

  it('keeps the last successful mode visible when a queued selection fails', async () => {
    const resolvers: Array<() => void> = [];
    const rejecters: Array<(error: Error) => void> = [];
    mocks.updateSessionMode.mockImplementation(() => new Promise<void>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    }));

    await act(async () => {
      root.render(<Probe />);
    });
    const [, selectAgentic, selectAsk] = Array.from(container.querySelectorAll('button'));
    act(() => {
      selectAgentic.click();
      selectAsk.click();
    });
    await act(async () => {
      resolvers[0]();
      await Promise.resolve();
    });
    const failure = new Error('ask unavailable');
    await act(async () => {
      rejecters[1](failure);
      await Promise.resolve();
    });

    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith('Standard');
    expect(mocks.committed).toHaveBeenCalledOnce();
    expect(mocks.committed).toHaveBeenCalledWith('Standard');
    expect(mocks.reportFailure).toHaveBeenCalledWith(failure, 'ask');
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe('false');
  });
});
