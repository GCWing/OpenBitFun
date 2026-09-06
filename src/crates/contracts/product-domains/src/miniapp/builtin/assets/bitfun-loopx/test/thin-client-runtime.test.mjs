import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireFromWebUi = createRequire(
  new URL('../../../../../../../../../web-ui/package.json', import.meta.url),
);
const { JSDOM, VirtualConsole } = requireFromWebUi('jsdom');

const ASSET_ROOT = new URL('../', import.meta.url);

async function readAsset(name) {
  return readFile(new URL(name, ASSET_ROOT), 'utf8');
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function installBrowserShims(window) {
  window.requestAnimationFrame = (callback) => {
    queueMicrotask(() => callback(Date.now()));
    return 1;
  };
  window.cancelAnimationFrame = () => {};
  window.setInterval = () => 1;
  window.clearInterval = () => {};
  window.document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.showModal = () => {
      dialog.open = true;
      dialog.setAttribute('open', '');
    };
    dialog.close = () => {
      dialog.open = false;
      dialog.removeAttribute('open');
    };
  });
}

function issueKey(number = 2382) {
  return {
    repository: {
      host: 'github.com',
      owner: 'GCWing',
      repository: 'BitFun',
    },
    kind: 'issue',
    number,
  };
}

function taskSnapshot(now) {
  return {
    taskId: 'task-2382-1',
    batchId: 'batch-1',
    identity: { item: issueKey(), attempt: 1 },
    generation: 2,
    revision: 7,
    goalId: 'goal-2382',
    agentId: 'agent-loopx',
    state: 'running',
    phase: 'agent_running',
    workspacePath: 'D:\\BitFun-worktrees\\issue-2382',
    modelId: 'primary',
    grantedScopes: [
      'workspace_read',
      'workspace_write',
      'git_local',
      'github_read',
      'agent_execution',
    ],
    currentTurnId: 'turn-4',
    currentTool: 'cargo test',
    lastOutputAt: now - 5000,
    lastAgentSummary: null,
    lastAgentSummaryAt: null,
    deadlineAt: now + 120000,
    retryAt: null,
    error: null,
    settlement: {},
    createdAt: now - 60000,
    updatedAt: now - 5000,
  };
}

function controllerSnapshot(now, task) {
  const available = (version, detail) => ({
    status: 'available',
    version,
    detail,
    checkedAt: now - 1000,
  });
  return {
    schemaVersion: 1,
    streamId: 'stream-runtime-1',
    cursor: 2,
    revision: 11,
    executionDomain: 'local_desktop',
    executionSupport: 'supported',
    unsupportedReason: null,
    environment: {
      revision: 4,
      status: 'degraded',
      core: {
        sidecar: available('0.5.1', 'Pinned adapter ready'),
        gitWorktree: available('2.51.0', 'Worktree service ready'),
        agentModel: available('primary', 'Model available'),
      },
      optional: {
        pythonFallback: {
          status: 'unavailable',
          detail: 'Optional fallback is not installed',
          checkedAt: now - 1000,
        },
        githubAuth: available('gh', 'Authenticated'),
      },
      checkedAt: now - 1000,
    },
    tasks: [task],
    generatedAt: now,
  };
}

function historyEvents(now) {
  return [
    {
      streamId: 'stream-runtime-1',
      cursor: 1,
      taskId: 'task-2382-1',
      generation: 2,
      revision: 6,
      kind: 'task_created',
      level: 'info',
      source: 'controller',
      phase: 'queued',
      message: 'Task created after intake confirmation',
      important: true,
      details: { attempt: '1' },
      occurredAt: now - 10000,
    },
    {
      streamId: 'stream-runtime-1',
      cursor: 2,
      taskId: 'task-2382-1',
      generation: 2,
      revision: 7,
      kind: 'log',
      level: 'info',
      source: 'agent',
      phase: 'agent_running',
      message: 'Tool started: ExecCommand',
      important: false,
      toolName: 'ExecCommand',
      deadlineAt: now + 120000,
      details: {
        activity: 'started',
        toolName: 'ExecCommand',
        summary: 'cargo test -p bitfun-core',
      },
      occurredAt: now - 5000,
    },
  ];
}

function intakePreview(now) {
  return {
    fingerprint: 'sha256:runtime-preview',
    target: { targetType: 'item', item: issueKey() },
    repository: issueKey().repository,
    workspace: {
      disposition: 'existing_worktree',
      path: 'D:\\BitFun-worktrees\\issue-2382',
      repositoryVerified: true,
    },
    candidates: [{
      key: issueKey(),
      url: 'https://github.com/GCWing/BitFun/issues/2382',
      title: 'Keep LoopX tasks alive outside the MiniApp tab',
      state: 'open',
      fromRepository: false,
      hasImages: false,
      defaultSelected: true,
    }],
    truncated: false,
    model: { modelId: 'primary', available: true, supportsImages: true },
    permissionScopes: [
      'workspace_read',
      'workspace_write',
      'agent_execution',
      'publish',
    ],
    resolvedAt: now,
    expiresAt: now + 60000,
  };
}

test('thin client boots from host state and completes the confirmed intake flow', async () => {
  const [html, ui] = await Promise.all([
    readAsset('index.html'),
    readAsset('ui.js'),
  ]);
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error));
  const dom = new JSDOM(html, {
    url: 'https://miniapp.invalid/builtin-bitfun-loopx/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  installBrowserShims(window);

  const now = Date.now();
  const task = taskSnapshot(now);
  const snapshot = controllerSnapshot(now, task);
  const events = historyEvents(now);
  const preview = intakePreview(now);
  const callOrder = [];
  const attachRequests = [];
  const eventRequests = [];
  const resolveRequests = [];
  const createRequests = [];
  const storedHistory = [];
  const forbiddenAccesses = [];
  let eventListener = null;

  const loopx = {
    onEvent(listener) {
      callOrder.push('onEvent');
      eventListener = listener;
    },
    offEvent(listener) {
      assert.equal(listener, eventListener);
    },
    async attach(request) {
      callOrder.push('attach');
      attachRequests.push(request);
      return { snapshot: structuredClone(snapshot) };
    },
    async eventsSince(request) {
      eventRequests.push(request);
      return {
        status: 'current',
        streamId: snapshot.streamId,
        events: structuredClone(events),
        nextCursor: snapshot.cursor,
        hasMore: false,
      };
    },
    async turnOutputSince(request) {
      return {
        status: 'current',
        taskId: task.taskId,
        turnId: task.currentTurnId,
        streamId: 'output-stream-1',
        events: request.afterCursor > 0 ? [] : [{
          cursor: 1,
          turnId: task.currentTurnId,
          roundId: 'round-1',
          kind: 'thinking',
          text: 'Inspecting the issue and repository state',
          toolName: null,
          toolState: null,
          isEnd: true,
        }, {
          cursor: 2,
          turnId: task.currentTurnId,
          roundId: 'round-1',
          kind: 'tool',
          text: 'cargo test -p bitfun-core',
          toolName: 'ExecCommand',
          toolState: 'started',
          isEnd: false,
        }],
        nextCursor: 2,
        hasMore: false,
        message: null,
      };
    },
    async resolveIntake(request) {
      resolveRequests.push(request);
      return { preview: structuredClone(preview) };
    },
    async createTask(request) {
      createRequests.push(request);
      return {
        outcomes: [{
          item: issueKey(),
          kind: 'opened_existing',
          taskId: task.taskId,
          attempt: 1,
        }],
        snapshotRevision: snapshot.revision,
      };
    },
    async action() {
      assert.fail('the intake smoke test must not dispatch task actions');
    },
  };
  const appTarget = {
    locale: 'en-US',
    loopx,
    storage: {
      async get() { return []; },
      async set(key, value) { storedHistory.push([key, structuredClone(value)]); },
    },
    onLocaleChange() {},
    onActivate() {},
  };
  window.app = new Proxy(appTarget, {
    get(target, property, receiver) {
      if (['agent', 'call', 'worker'].includes(String(property))) {
        forbiddenAccesses.push(String(property));
      }
      return Reflect.get(target, property, receiver);
    },
  });

  try {
    window.eval(ui);
    // The merged timeline renders one compact block per output kind: the
    // turn's thinking summary block plus the running tool block.
    await waitFor(() => window.document.querySelectorAll('#log-list .log-row').length === 2, 'initial rendering');

    assert.deepEqual(callOrder.slice(0, 2), ['onEvent', 'attach']);
    assert.deepEqual(plain(attachRequests[0]), {});
    assert.deepEqual(plain(eventRequests), [{
      streamId: snapshot.streamId,
      afterCursor: 0,
      limit: 250,
    }]);
    assert.equal(window.document.querySelector('#loopx-app').getAttribute('aria-busy'), 'false');
    assert.equal(window.document.querySelector('#task-count').textContent, '1');
    assert.match(window.document.querySelector('#task-items').textContent, /GCWing\/BitFun · Issue #2382/);
    assert.equal(window.document.querySelector('#environment-status').textContent, 'Degraded');
    assert.match(window.document.querySelector('#core-environment-list').textContent, /0\.5\.1/);
    assert.match(window.document.querySelector('#log-list').textContent, /Issue #2382/);
    assert.match(window.document.querySelector('#log-list').textContent, /Inspecting the issue/);
    assert.match(window.document.querySelector('#log-list').textContent, /cargo test -p bitfun-core/);

    assert.equal(typeof eventListener, 'function');
    eventListener({
      event: {
        streamId: snapshot.streamId,
        cursor: 3,
        taskId: task.taskId,
        generation: 2,
        revision: 7,
        kind: 'log',
        level: 'warning',
        source: 'git',
        phase: 'agent_running',
        message: 'Validation produced one warning',
        important: false,
        details: {},
        occurredAt: now,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.doesNotMatch(window.document.querySelector('#log-list').textContent, /Validation produced one warning/);

    const connectionChanges = [];
    const connectionObserver = new window.MutationObserver(() => {
      connectionChanges.push(window.document.querySelector('#connection-label').textContent);
    });
    connectionObserver.observe(window.document.querySelector('#connection-label'), {
      childList: true,
      characterData: true,
      subtree: true,
    });
    eventListener({
      event: {
        streamId: snapshot.streamId,
        cursor: 4,
        taskId: task.taskId,
        generation: 2,
        revision: 8,
        kind: 'state_changed',
        level: 'info',
        source: 'controller',
        phase: 'queued',
        message: 'Task returned to the queue',
        important: false,
        details: {},
        occurredAt: now,
      },
    });
    await waitFor(() => attachRequests.length === 2, 'background snapshot refresh');
    await new Promise((resolve) => setTimeout(resolve, 0));
    connectionObserver.disconnect();
    assert.equal(window.document.querySelector('#connection-label').textContent, 'Connected');
    assert.ok(!connectionChanges.includes('Resynchronizing'));

    const originalDateNow = window.Date.now;
    const resumedAt = originalDateNow() + 60000;
    window.Date.now = () => resumedAt;
    window.dispatchEvent(new window.Event('focus'));
    await waitFor(() => attachRequests.length === 3, 'host resume reattach');
    assert.equal(attachRequests[2].resumeDetected, true);
    window.Date.now = originalDateNow;

    const input = window.document.querySelector('#intake-input');
    input.value = 'https://github.com/GCWing/BitFun/issues/2382';
    window.document.querySelector('#intake-form').dispatchEvent(new window.Event('submit', {
      bubbles: true,
      cancelable: true,
    }));
    await waitFor(() => window.document.querySelector('#intake-dialog').open, 'intake dialog');

    assert.deepEqual(plain(resolveRequests), [{
      input: 'https://github.com/GCWing/BitFun/issues/2382',
      modelId: 'auto',
    }]);
    assert.equal(window.document.querySelector('#preview-repository').textContent, 'GCWing/BitFun');
    assert.equal(
      window.document.querySelector('#preview-workspace').textContent,
      'D:\\BitFun-worktrees\\issue-2382',
    );
    assert.match(window.document.querySelector('#candidate-list').textContent, /Keep LoopX tasks alive/);
    assert.equal(window.document.querySelector('input[name="candidate"]').checked, true);
    // High-risk scopes render unchecked by default but the intake gate now
    // requires an explicit grant of every preview scope before creation:
    // simulate the owner checking `publish` before confirming.
    assert.equal(
      window.document.querySelector('input[name="permission"][value="publish"]').checked,
      false,
    );
    const publishGrant = window.document.querySelector('input[name="permission"][value="publish"]');
    publishGrant.checked = true;
    publishGrant.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.deepEqual(plain(storedHistory), [[
      'loopx.intakeHistory',
      ['https://github.com/GCWing/BitFun/issues/2382'],
    ]]);
    assert.equal(
      window.document.querySelector('#intake-history option').value,
      'https://github.com/GCWing/BitFun/issues/2382',
    );

    window.document.querySelector('#intake-confirm-form').dispatchEvent(new window.Event('submit', {
      bubbles: true,
      cancelable: true,
    }));
    await waitFor(() => createRequests.length === 1 && !window.document.querySelector('#intake-dialog').open, 'task creation');

    assert.equal(createRequests[0].previewFingerprint, preview.fingerprint);
    assert.deepEqual(plain(createRequests[0].selectedItems), [issueKey()]);
    assert.deepEqual(plain(createRequests[0].grantedScopes), [
      'workspace_read',
      'workspace_write',
      'agent_execution',
      'publish',
    ]);
    assert.equal(createRequests[0].modelId, 'primary');
    assert.equal(createRequests[0].retryTerminal, false);
    assert.ok(createRequests[0].clientRequestId);
    assert.match(window.document.querySelector('#notice').textContent, /existing task.*duplicate/i);
    assert.equal(
      window.document.querySelector('[data-task-id="task-2382-1"]').getAttribute('aria-pressed'),
      'true',
    );
    // The creation flow focuses the task logs in the issue workspace; a
    // running task renders no decision card (only waiting/recovery states do).
    assert.equal(window.document.querySelector('#issue-view').hidden, false);
    assert.equal(window.document.querySelector('#issue-decision-card').hidden, true);
    assert.deepEqual(forbiddenAccesses, []);
    assert.deepEqual(jsdomErrors, []);
  } finally {
    window.close();
  }
});

test('task rail is flat and exposes one repository recovery action', async () => {
  const [html, ui] = await Promise.all([
    readAsset('index.html'),
    readAsset('ui.js'),
  ]);
  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error));
  const dom = new JSDOM(html, {
    url: 'https://miniapp.invalid/builtin-bitfun-loopx/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  installBrowserShims(window);

  const now = Date.now();
  const makeTask = (taskId, number, state, phase, overrides = {}) => ({
    ...taskSnapshot(now),
    taskId,
    identity: {
      item: issueKey(number),
      attempt: 1,
      title: `Issue ${number}`,
      description: '',
    },
    state,
    phase,
    currentTurnId: null,
    currentTool: null,
    error: null,
    ...overrides,
  });
  const waiting = makeTask('task-waiting', 42, 'waiting_for_user', 'waiting_for_approval', {
    identity: {
      item: issueKey(42),
      attempt: 1,
      title: '8.29 upgrade from 2.0.2 to 2.0.4: plugin tree failed to load, waiting for service: apiProxy',
      description: '',
    },
    pendingGateId: 'todo_release_approval',
    pendingGateMessage: 'Approve repository write scope for the issue repair',
    pendingGateActionKind: 'gate',
    lastAgentSummary: 'Implementation has not started because repository write requires parent approval. The repair will add an apiProxy compatibility shim and resilient plugin startup.',
    lastAgentSummaryAt: now - 2000,
  });
  const failed = makeTask('task-failed', 43, 'recovery_required', 'recovering', {
    error: 'LoopX process exited with status 1',
  });
  const resolvedUpstream = makeTask('task-resolved-upstream', 46, 'recovery_required', 'recovering', {
    error: 'Settlement metadata was incomplete',
    lastAgentSummary: 'The original failure path is covered-upstream no-follow-up; no PR is required.',
    lastAgentSummaryAt: now - 1500,
  });
  const running = makeTask('task-running', 44, 'running', 'agent_running');
  const queued = makeTask('task-queued', 45, 'queued', 'queued');
  const snapshot = controllerSnapshot(now, running);
  snapshot.tasks = [queued, running, failed, waiting, resolvedUpstream];
  snapshot.cursor = 1;
  snapshot.revision = 24;
  const events = [{
    streamId: snapshot.streamId,
    cursor: 1,
    taskId: waiting.taskId,
    generation: waiting.generation,
    revision: waiting.revision,
    kind: 'approval_required',
    level: 'warning',
    source: 'controller',
    phase: 'waiting_for_approval',
    message: 'Approve repository write scope for the issue repair',
    important: true,
    details: { gateId: 'todo_release_approval', actionKind: 'gate' },
    occurredAt: now - 1000,
  }];
  let eventListener = null;
  window.app = {
    locale: 'en-US',
    loopx: {
      onEvent(listener) {
        eventListener = listener;
      },
      offEvent(listener) {
        assert.equal(listener, eventListener);
      },
      async attach() {
        return { snapshot: structuredClone(snapshot) };
      },
      async eventsSince() {
        return {
          status: 'current',
          streamId: snapshot.streamId,
          events: structuredClone(events),
          nextCursor: snapshot.cursor,
          hasMore: false,
        };
      },
      async turnOutputSince() {
        return {
          status: 'current',
          taskId: running.taskId,
          turnId: running.currentTurnId,
          streamId: 'output-stream-1',
          events: [],
          nextCursor: 0,
          hasMore: false,
          message: null,
        };
      },
      async resolveIntake() {
        return { preview: { candidates: [] } };
      },
      async action() {
        assert.fail('this test must not submit a decision');
      },
    },
    onLocaleChange() {},
    onActivate() {},
  };

  try {
    window.eval(ui);
    await waitFor(
      () => window.document.querySelectorAll('#task-items .task-item').length === 5,
      'flat task list',
    );
    await waitFor(
      () => !window.document.querySelector('#approval-alert').hidden
        && window.document.querySelector('[data-task-id="task-waiting"]').getAttribute('aria-pressed') === 'true',
      'automatic approval focus',
    );

    assert.equal(window.document.querySelectorAll('#task-items .task-group').length, 0);
    // The rail reads in actual execution order: running first, then the
    // queue, then parked/awaiting-owner tasks, then finished work.
    assert.deepEqual(
      [...window.document.querySelectorAll('#task-items .task-item')].map((item) => item.dataset.taskId),
      ['task-running', 'task-queued', 'task-waiting', 'task-failed', 'task-resolved-upstream'],
    );
    assert.equal(window.document.querySelector('#repository-actions').hidden, false);
    assert.match(window.document.querySelector('#resume-repository').textContent, /repository tasks \(1\)/i);
    assert.match(
      window.document.querySelector('[data-task-id="task-waiting"]').textContent,
      /Pending approval/,
    );
    assert.equal(window.document.querySelector('#approval-alert').hidden, false);
    assert.match(
      window.document.querySelector('[data-task-id="task-failed"]').textContent,
      /Pending recovery/,
    );
    window.document.querySelector('#reset-loopx').click();
    assert.equal(window.document.querySelector('#reset-loopx-dialog').open, true);
    assert.match(window.document.querySelector('#reset-loopx-message').textContent, /5 tasks, 1 log event/);
    window.document.querySelector('#reset-loopx-cancel').click();
    assert.equal(window.document.querySelector('#reset-loopx-dialog').open, false);

    window.document.querySelector('[data-task-id="task-waiting"]').click();
    // The waiting task renders the decision card mirroring the pending gate;
    // the stale five-stage pipeline projection is gone.
    assert.equal(window.document.querySelector('#issue-decision-card').hidden, false);
    assert.match(
      window.document.querySelector('#issue-decision-card').textContent,
      /Needs your decision/i,
    );
    assert.match(
      window.document.querySelector('#issue-decision-card').textContent,
      /Approve repository write scope for the issue repair/i,
    );
    assert.equal(window.document.querySelector('#issue-description-panel').hidden, false);
    await waitFor(
      () => /temporarily unavailable/.test(window.document.querySelector('#issue-description').textContent),
      'selected task metadata refresh',
    );
    assert.match(window.document.querySelector('#issue-summary').textContent, /Implementation has not started because repository write requires parent approval/i);
    assert.equal(window.document.querySelector('#task-actions button'), null);
    assert.equal(window.document.querySelector('#issue-approval-panel').hidden, false);
    assert.match(window.document.querySelector('#issue-title').textContent, /plugin tree failed to load/i);
    assert.match(
      window.document.querySelector('#issue-approval-title').textContent,
      /continue handling this issue/i,
    );
    assert.match(
      window.document.querySelector('#issue-approval-message').textContent,
      /requested a decision/i,
    );
    assert.match(
      window.document.querySelector('#issue-approval-raw-text').textContent,
      /Approve repository write scope for the issue repair/,
    );
    assert.match(window.document.querySelector('#issue-approval-approve-effect').textContent, /perform the current operation and continue processing/i);
    assert.match(window.document.querySelector('#issue-approval-reject-effect').textContent, /do not perform this operation or continue to later steps/i);
    assert.doesNotMatch(window.document.querySelector('#issue-view').textContent, /Root cause|todo_|settlement_result|durable_writeback|bounded stage/i);

    const resolvedButton = window.document.querySelector('[data-task-id="task-resolved-upstream"]');
    assert.match(resolvedButton.textContent, /Resolved upstream/);
    assert.equal(resolvedButton.dataset.state, 'completed');
    resolvedButton.click();
    assert.equal(window.document.querySelector('#issue-state-pill').textContent, 'Resolved upstream');
    // Resolved-upstream tasks render no decision card; the summary carries
    // the closure conclusion.
    assert.equal(window.document.querySelector('#issue-decision-card').hidden, true);
    assert.match(window.document.querySelector('#issue-summary').textContent, /covered-upstream no-follow-up/i);
    assert.equal(window.document.querySelector('#task-actions button'), null);
    assert.deepEqual(jsdomErrors, []);
  } finally {
    window.close();
  }
});
