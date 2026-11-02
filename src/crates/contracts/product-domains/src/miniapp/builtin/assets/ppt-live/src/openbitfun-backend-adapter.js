// OpenBitFun backend adapter for PPT Live.
//
// The MiniApp agent bridge (`app.agent.*`) is the only generation path. A
// single cowork agent turn loads OpenBitFun's pinned built-in `ppt-design` skill
// and produces the entire deck through its project.json + slides/ file protocol.

import {
  PPT_DESIGN_SKILL_KEY,
  buildAgentPrompt,
} from './agent-prompt.js';

const EVENT_LISTENERS = new Set();
export { PPT_DESIGN_SKILL_KEY };

function emitEvent(event) {
  EVENT_LISTENERS.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // A UI listener must not break the host stream.
    }
  });
}

function installAgentBackend(app) {
  let agentEventsHooked = false;
  const ensureAgentEvents = () => {
    if (agentEventsHooked) return;
    agentEventsHooked = true;
    app.agent.onEvent((event) => {
      if (!event || typeof event !== 'object') return;
      emitEvent(event);
    });
  };

  app.backend = {
    protocol: 'files',
    async ensureSession(options = {}) {
      if (!app.agent.ensureSession) {
        throw new Error('PPT Live session initialization is unavailable');
      }
      return app.agent.ensureSession({
        sessionName: 'PPT Live',
        sessionId: options.sessionId,
        appDataWorkspace: options.appDataWorkspace,
      });
    },
    async call(action, input, options = {}) {
      if (action !== 'ppt.generate') {
        throw new Error(`Unsupported PPT Live action: ${action}`);
      }
      ensureAgentEvents();
      const result = await app.agent.run(buildAgentPrompt(input), {
        runId: options.idempotencyKey,
        sessionName: 'PPT Live',
        displayText: options.displayText || input.instruction,
        sessionId: options.sessionId,
        appDataWorkspace: options.appDataWorkspace,
        imageContexts: options.imageContexts,
      });
      if (!result?.sessionId || !result?.turnId) {
        throw new Error('PPT Live agent backend did not return sessionId/turnId');
      }
      return {
        sessionId: result.sessionId,
        turnId: result.turnId,
        actionRunId: result.actionRunId || result.turnId,
      };
    },
    onEvent(listener) {
      EVENT_LISTENERS.add(listener);
    },
    offEvent(listener) {
      EVENT_LISTENERS.delete(listener);
    },
    async cancel(sessionId, turnId) {
      await app.agent.cancel(sessionId, turnId);
    },
    async turnText(sessionId, turnId) {
      const result = await app.agent.turnText(sessionId, turnId);
      return { text: result?.text || '' };
    },
    async cancelStaleRuns() {
      await app.agent.cancelStaleRuns();
    },
  };
}

export function installOpenBitFunBackendAdapter(app = window.app) {
  if (!app || app.backend?.call) return;
  if (app.agent?.run) installAgentBackend(app);
}
