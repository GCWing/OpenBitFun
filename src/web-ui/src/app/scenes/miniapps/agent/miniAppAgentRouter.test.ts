/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest';

import { handleMiniAppAgentRequest, type MiniAppAgentRouterDeps } from './miniAppAgentRouter';
import {
  registerMiniAppAgentSurface,
  updateMiniAppAgentSurfaceStatus,
} from './miniAppAgentSurfaceRegistry';
import { MiniAppAgentSurfaceError } from './miniAppAgentProtocol';

const HTML = `
  <main>
    <h1>Score</h1>
    <button data-testid="reset">Reset</button>
    <input aria-label="Player" value="ada" />
  </main>
`;

interface Harness {
  deps: MiniAppAgentRouterDeps;
  frameWindow: Window;
  document: Document;
  announce(data: Record<string, unknown>): void;
}

const cleanups: (() => void)[] = [];

function createHarness(options: { readable?: boolean; ready?: boolean } = {}): Harness {
  const doc = document.implementation.createHTMLDocument('Demo');
  doc.body.innerHTML = HTML;
  const frameWindow = {
    postMessage: (payload: Record<string, unknown>) => {
      const requestId = String(payload.requestId ?? '');
      queueMicrotask(() => {
        const event = new MessageEvent('message', {
          data: {
            type: 'openbitfun:miniapp-agent-response',
            requestId,
            ok: true,
            // Matches the injected runtime: declared state plus automatic
            // observation travel in one envelope.
            value: {
              state: { echo: payload.method },
              auto: { source: 'declared', canvasText: [], frames: 3 },
            },
          },
        });
        Object.defineProperty(event, 'source', { value: frameWindow });
        window.dispatchEvent(event);
      });
    },
  } as unknown as Window;

  const iframe = options.readable === false
    ? Object.defineProperty({}, 'contentDocument', { get() { throw new Error('cross-origin'); } }) as unknown as HTMLIFrameElement
    : ({ contentDocument: doc, contentWindow: frameWindow, getBoundingClientRect: () => ({ width: 800, height: 600 }) } as unknown as HTMLIFrameElement);

  const deps: MiniAppAgentRouterDeps = {
    openTimeoutMs: 200,
    presentApp: async () => {
      const unregister = registerMiniAppAgentSurface({
        appId: 'demo',
        iframe,
        strictRuntime: options.readable === false,
        instanceId: 'instance-1',
        ready: false,
      });
      cleanups.push(unregister);
      updateMiniAppAgentSurfaceStatus('demo', { ready: options.ready !== false });
      return { instanceId: 'instance-1' };
    },
  };

  return {
    deps,
    frameWindow,
    document: doc,
    announce: (data) => {
      const event = new MessageEvent('message', { data });
      Object.defineProperty(event, 'source', { value: frameWindow });
      window.dispatchEvent(event);
    },
  };
}

function execute(method: string, params: Record<string, unknown> = {}) {
  return {
    requestId: `req-${method}`,
    action: 'execute',
    command: { appId: 'demo', instanceId: 'instance-1', method, params },
  };
}

async function errorOf(run: Promise<unknown>): Promise<MiniAppAgentSurfaceError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(MiniAppAgentSurfaceError);
    return error as MiniAppAgentSurfaceError;
  }
  throw new Error('expected a typed surface error');
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('MiniApp agent router', () => {
  it('opens the app and reports the capabilities it can actually provide', async () => {
    const harness = createHarness();
    // The request carries the host's runtime fact, but the mounted runner owns
    // the surface truth, so a readable frame stays readable either way.
    const surface = await handleMiniAppAgentRequest(
      { requestId: 'req-open', action: 'open', appId: 'demo', strictRuntime: true },
      harness.deps,
    );
    expect(surface).toMatchObject({
      appId: 'demo',
      instanceId: 'instance-1',
      width: 800,
      height: 600,
      capabilities: ['dom', 'accessibility', 'input', 'element-position-click-v1'],
      bridgeCapabilities: [],
      // Nothing was declared yet, so the action vocabulary is unknown, not empty.
      declaredActions: [],
    });
  });

  it('reports a presentation transfer so a moved window is visible to the caller', async () => {
    const harness = createHarness();
    const deps: MiniAppAgentRouterDeps = {
      ...harness.deps,
      presentApp: async (appId) => ({ ...(await harness.deps.presentApp(appId)), presentedFrom: 'window' }),
    };
    const surface = await handleMiniAppAgentRequest(
      { requestId: 'req-open', action: 'open', appId: 'demo' },
      deps,
    );
    expect(surface).toMatchObject({ instanceId: 'instance-1', presentedFrom: 'window' });
  });

  it('omits the transfer marker when the app was already a tab', async () => {
    const harness = createHarness();
    const surface = await handleMiniAppAgentRequest(
      { requestId: 'req-open', action: 'open', appId: 'demo' },
      harness.deps,
    );
    expect(surface).not.toHaveProperty('presentedFrom');
  });

  it('promises no DOM control for an opaque frame', async () => {    const harness = createHarness({ readable: false });
    const surface = await handleMiniAppAgentRequest({ requestId: 'req-open', action: 'open', appId: 'demo' }, harness.deps);
    expect(surface.capabilities).toEqual([]);
    expect(surface.strictRuntime).toBe(true);
  });

  it('routes DOM actions through the surface runtime', async () => {
    const harness = createHarness();
    await handleMiniAppAgentRequest({ requestId: 'req-open', action: 'open', appId: 'demo' }, harness.deps);

    const inspect = await handleMiniAppAgentRequest(execute('inspect', { maxNodes: 40, maxDepth: 6 }), harness.deps);
    expect(Array.isArray(inspect.tree)).toBe(true);

    const found = await handleMiniAppAgentRequest(
      execute('find', { locator: { testId: 'reset' } }),
      harness.deps,
    ) as { matches: { nodeKey: string }[] };
    expect(found.matches).toHaveLength(1);

    const clicked = await handleMiniAppAgentRequest(execute('click', { nodeKey: found.matches[0].nodeKey }), harness.deps);
    expect(clicked).toMatchObject({ target: found.matches[0].nodeKey });
  });

  it('preserves long text, surrounding whitespace, and empty replacement text', async () => {
    const harness = createHarness();
    await handleMiniAppAgentRequest({ requestId: 'open', action: 'open', appId: 'demo' }, harness.deps);
    const found = await handleMiniAppAgentRequest(execute('find', { locator: { role: 'textbox' } }), harness.deps) as { matches: { nodeKey: string }[] };
    const nodeKey = found.matches[0].nodeKey;
    for (const text of ['  padded text  ', 'x'.repeat(450), '']) {
      await handleMiniAppAgentRequest(execute('type', { nodeKey, text }), harness.deps);
      expect(harness.document.querySelector('input')!.value).toBe(text);
      await handleMiniAppAgentRequest(execute('type', { nodeKey, text: 'END', clear: false }), harness.deps);
      expect(harness.document.querySelector('input')!.value).toBe(`${text}END`);
    }
  });

  it('stops an open request when its device activation ends', async () => {
    const harness = createHarness({ ready: false });
    const controller = new AbortController();
    const pending = handleMiniAppAgentRequest(
      { requestId: 'open', action: 'open', appId: 'demo' },
      { ...harness.deps, signal: controller.signal },
    );
    controller.abort();
    expect((await errorOf(pending)).code).toBe('SURFACE_UNAVAILABLE');
  });

  it('relays bridge calls and stores the announced capabilities', async () => {
    const harness = createHarness();
    await handleMiniAppAgentRequest({ requestId: 'req-open', action: 'open', appId: 'demo' }, harness.deps);
    harness.announce({
      type: 'openbitfun:miniapp-agent-ready',
      appId: 'demo',
      schemaVersion: 'agent.v1',
      capabilities: ['observe'],
      actions: ['start', 'autoplay'],
    });

    const observed = await handleMiniAppAgentRequest(
      execute('bridge_observe', { requestId: 'bridge-1' }),
      harness.deps,
    );
    expect(observed).toMatchObject({
      state: { echo: 'observe' },
      auto: { source: 'declared' },
      capabilities: ['observe'],
      // The vocabulary rides along with every answer so the Agent never has to
      // guess an action name or read the app's source to learn one.
      actions: ['start', 'autoplay'],
    });

    const missingAct = await errorOf(handleMiniAppAgentRequest(
      execute('bridge_act', { requestId: 'bridge-2', action: { type: 'restart' } }),
      harness.deps,
    ));
    expect(missingAct.code).toBe('BRIDGE_UNAVAILABLE');
  });

  it('refuses a retired sampling-window method instead of half-implementing it', async () => {
    const harness = createHarness();
    await handleMiniAppAgentRequest({ requestId: 'req-open', action: 'open', appId: 'demo' }, harness.deps);

    // Sampling is a bounded loop over bridge_observe in the tool, so the surface
    // must not grow a second implementation that could drift from it.
    const watched = await errorOf(handleMiniAppAgentRequest(
      execute('bridge_watch', { requestId: 'watch-1', durationMs: 250, pollMs: 250 }),
      harness.deps,
    ));
    expect(watched.code).toBe('INVALID_PARAMS');
  });

  it('refuses a stale instance, a missing surface, and unknown methods', async () => {
    const harness = createHarness();
    await handleMiniAppAgentRequest({ requestId: 'req-open', action: 'open', appId: 'demo' }, harness.deps);

    const staleInstance = await errorOf(handleMiniAppAgentRequest({
      requestId: 'req-stale',
      action: 'execute',
      command: { appId: 'demo', instanceId: 'instance-2', method: 'inspect' },
    }, harness.deps));
    expect(staleInstance.code).toBe('SURFACE_UNAVAILABLE');

    const missing = await errorOf(handleMiniAppAgentRequest({
      requestId: 'req-missing',
      action: 'execute',
      command: { appId: 'other-app', method: 'inspect' },
    }, harness.deps));
    expect(missing.code).toBe('SURFACE_UNAVAILABLE');

    const unsupported = await errorOf(handleMiniAppAgentRequest(execute('evaluate'), harness.deps));
    expect(unsupported.code).toBe('INVALID_PARAMS');
  });

  it('reports unknown actions and missing parameters instead of acting', async () => {
    const harness = createHarness();
    await handleMiniAppAgentRequest({ requestId: 'req-open', action: 'open', appId: 'demo' }, harness.deps);

    expect((await errorOf(handleMiniAppAgentRequest({ requestId: 'req-1', action: 'nope' }, harness.deps))).code)
      .toBe('INVALID_PARAMS');
    expect((await errorOf(handleMiniAppAgentRequest({ action: 'execute' }, harness.deps))).code)
      .toBe('INVALID_PARAMS');
    expect((await errorOf(handleMiniAppAgentRequest(execute('click'), harness.deps))).code)
      .toBe('INVALID_PARAMS');
  });

  it('rejects existing-session commands while its frame is not ready', async () => {
    const harness = createHarness({ ready: false });
    await harness.deps.presentApp('demo');
    for (const method of ['inspect', 'find', 'key', 'bridge_act']) {
      const error = await errorOf(handleMiniAppAgentRequest(execute(method), harness.deps));
      expect(error.code).toBe('SURFACE_UNAVAILABLE');
    }
    updateMiniAppAgentSurfaceStatus('demo', { ready: true });
    await expect(handleMiniAppAgentRequest(execute('inspect'), harness.deps)).resolves.toHaveProperty('tree');
  });

  it('refuses an expired request before dispatching a live mutation', async () => {
    const harness = createHarness();
    await handleMiniAppAgentRequest({ requestId: 'req-open', action: 'open', appId: 'demo' }, harness.deps);
    const error = await errorOf(handleMiniAppAgentRequest({
      ...execute('click'),
      expiresAt: Date.now() - 1,
    }, harness.deps));
    expect(error.code).toBe('TIMEOUT');
  });

  it('times out when the presented app never becomes controllable', async () => {
    const harness = createHarness({ ready: false });
    const error = await errorOf(handleMiniAppAgentRequest(
      { requestId: 'req-open', action: 'open', appId: 'demo' },
      { ...harness.deps, openTimeoutMs: 50 },
    ));
    expect(error.code).toBe('TIMEOUT');
  });
});
