import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ASSET_ROOT = new URL('../', import.meta.url);

async function readAsset(name) {
  return readFile(new URL(name, ASSET_ROOT), 'utf8');
}

function openingTags(source, tagName) {
  return [...source.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gi'))]
    .map((match) => match[0]);
}

function tagWithMarker(source, tagName, marker, description) {
  const tag = openingTags(source, tagName).find((candidate) => marker.test(candidate));
  assert.ok(tag, `missing ${description}`);
  return tag;
}

function hasAccessibleName(tag) {
  return /\baria-label(?:ledby)?\s*=\s*(['"])[^'"]+\1/i.test(tag);
}

function executableWorkerSource(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();
}

test('LoopX UI is a thin client of the host-owned controller', async () => {
  const ui = await readAsset('ui.js');
  const requiredMethods = [
    'attach',
    'resolveIntake',
    'createTask',
    'action',
    'eventsSince',
    'turnOutputSince',
  ];

  for (const method of requiredMethods) {
    assert.ok(
      new RegExp(`\\bapp\\.loopx\\.${method}\\s*\\(`).test(ui),
      `ui.js must use app.loopx.${method}`,
    );
  }
  assert.ok(
    /\bapp\.loopx\.onEvent\s*\(/.test(ui),
    'ui.js must subscribe to the host loopx:event stream',
  );

  const allowedLoopxMethods = new Set([
    ...requiredMethods,
    'listModels',
    'onEvent',
    'offEvent',
  ]);
  const usedLoopxMethods = [
    ...ui.matchAll(/\bapp\.loopx\.([A-Za-z][A-Za-z0-9_]*)/g),
  ].map((match) => match[1]);
  assert.ok(usedLoopxMethods.length > 0, 'ui.js must use the LoopX namespace');
  for (const method of usedLoopxMethods) {
    assert.ok(
      allowedLoopxMethods.has(method),
      `ui.js uses unsupported app.loopx method: ${method}`,
    );
  }
  assert.match(ui, /remediationAction\s*===\s*['"]install_loopx['"]/);
  assert.match(ui, /performAction\(['"]install_loopx['"]/);
  assert.match(ui, /window\.setTimeout\(\(\)\s*=>\s*\{[\s\S]*submitLoopxInstallation\(\)[\s\S]*\},\s*50\)/);
  for (const phase of [
    'pointer_down',
    'click_handler_entered',
    'ui_pending_rendered',
    'request_task_started',
    'bridge_call_started',
  ]) {
    assert.match(ui, new RegExp(`emitInstallDiagnostic\\(['"]${phase}['"]`));
  }
  assert.doesNotMatch(ui, /\bupdateControls\s*\(/);

  const forbiddenSurfaces = [
    [/\bapp\.agent\b/, 'MiniApp-owned Agent lifecycle'],
    [/\bapp\.call\s*\(/, 'legacy generic worker calls'],
    [/\b(?:app\.)?worker\.call\s*\(/, 'direct worker calls'],
    [/\bapp\.(?:fs|shell)\b/, 'direct filesystem or shell APIs'],
    [/\b(?:argvPrefix|projectDirs?|srcDir)\b/, 'iframe-controlled CLI or checkout paths'],
    [/--registry\b|registry\.json|\bregistry(?:Path|Args)\b/i, 'direct registry CLI access'],
    // The word alone appears in user-facing cadence copy and comments; only
    // actual heartbeat scheduling constructs (calls or starter functions)
    // are forbidden — the host owns every wake-up.
    [/\bheartbeat(?!-prompt)[a-z_]*\s*\(|\b(?:start|stop|schedule|restart)Heartbeat\b/i, 'iframe-owned heartbeat scheduling'],
  ];
  for (const [pattern, description] of forbiddenSurfaces) {
    assert.ok(!pattern.test(ui), `ui.js must not contain ${description}`);
  }
});

test('LoopX worker remains an execution-free compatibility stub', async () => {
  const worker = await readAsset('worker.js');

  assert.ok(
    /compatibility|intentionally empty/i.test(worker),
    'worker.js must document its compatibility-only purpose',
  );
  assert.ok(
    executableWorkerSource(worker) === 'module.exports = {};',
    'worker.js may only export an empty compatibility module',
  );
});

test('LoopX metadata disables the Node worker runtime', async () => {
  const meta = JSON.parse(await readAsset('meta.json'));

  assert.equal(meta.permissions?.node?.enabled, false);
});

test('LoopX HTML exposes an accessible intake, task rail, and log-first workspace', async () => {
  const html = await readAsset('index.html');
  const intakeHeader = tagWithMarker(
    html,
    'header',
    /\b(?:id|class)\s*=\s*(['"])[^'"]*intake[^'"]*\1/i,
    'intake header landmark',
  );
  const intakeForm = tagWithMarker(
    html,
    'form',
    /\b(?:id|class)\s*=\s*(['"])[^'"]*intake[^'"]*\1/i,
    'intake form',
  );
  const taskRail = openingTags(html, 'aside').find((tag) => (
    /\b(?:id|class)\s*=\s*(['"])[^'"]*(?:task|rail)[^'"]*\1/i.test(tag)
  ));
  const logLandmark = [
    ...openingTags(html, 'main'),
    ...openingTags(html, 'section'),
  ].find((tag) => (
    /\b(?:id|class)\s*=\s*(['"])[^'"]*log[^'"]*\1/i.test(tag)
  ));
  const logList = tagWithMarker(
    html,
    '[A-Za-z][A-Za-z0-9:-]*',
    /\bid\s*=\s*(['"])log-list\1/i,
    '#log-list',
  );

  assert.ok(intakeHeader, 'the intake controls must be grouped in a header');
  assert.ok(hasAccessibleName(intakeForm), 'the intake form needs an accessible name');
  assert.ok(taskRail, 'missing task rail aside landmark');
  assert.ok(hasAccessibleName(taskRail), 'the task rail needs an accessible name');
  assert.ok(logLandmark, 'missing main log landmark');
  assert.match(logLandmark, /\baria-labelledby\s*=\s*(['"])[^'"]+\1/i);
  assert.match(logLandmark, /\bid\s*=\s*(['"])log-workspace\1/i);
  assert.match(logLandmark, /\btabindex\s*=\s*(['"])-1\1/i);
  assert.match(logList, /\brole\s*=\s*(['"])log\1/i);
  assert.match(logList, /\baria-live\s*=\s*(['"])off\1/i);

  const labelledBy = logLandmark.match(/\baria-labelledby\s*=\s*(['"])([^'"]+)\1/i)?.[2];
  assert.ok(labelledBy, 'the log landmark must reference its visible title');
  assert.match(
    html,
    new RegExp(`\\bid\\s*=\\s*(['"])${labelledBy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'i'),
    'the log landmark must reference an existing title element',
  );

  const intakeOffset = html.indexOf(intakeHeader);
  const railOffset = html.indexOf(taskRail);
  const logOffset = html.indexOf(logLandmark);
  assert.ok(
    intakeOffset < railOffset && railOffset < logOffset,
    'the document order must be top intake, task rail, then primary log view',
  );

  assert.match(html, /\blist\s*=\s*(['"])intake-history\1/i);
  assert.match(html, /\bid\s*=\s*(['"])resume-repository\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-decision-card\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-description-panel\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-number\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-view\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-title\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-state-pill\1/i);
  assert.match(html, /\bid\s*=\s*(['"])follow-banner\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-approval-message\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-summary\1/i);
  assert.match(html, /\bid\s*=\s*(['"])timeline-title\1/i);
  assert.match(html, /\bid\s*=\s*(['"])log-empty-text\1/i);
  assert.match(html, /\bid\s*=\s*(['"])approval-alert\1/i);
  assert.match(html, /\bid\s*=\s*(['"])environment-remediation\1/i);
  assert.match(html, /\bid\s*=\s*(['"])install-loopx\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-approval-panel\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-approval-approve\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-approval-reject\1/i);
  assert.match(html, /\bid\s*=\s*(['"])issue-description-panel\1/i);
  assert.ok(
    html.indexOf('id="issue-approval-panel"') < html.indexOf('id="issue-decision-card"')
      && html.indexOf('id="issue-decision-card"') < html.indexOf('id="issue-description-panel"')
      && html.indexOf('id="issue-description-panel"') < html.indexOf('id="issue-timeline"'),
    'the approval request, decision card, issue description, and timeline must stack in priority order',
  );
  for (const removedId of [
    'sync-button',
    'mode-key',
    'mode-full',
    'mode-output',
    'log-search',
    'errors-only',
    'export-logs',
    'liveness-panel',
    'approval-alert-review',
    'issue-stage-walker',
    'gate-dialog',
    'issue-detail-dialog',
    'show-all-events',
    'log-title',
    'issue-approval-background',
    'issue-approval-impact',
    'issue-outcome',
    'issue-evidence-list',
    'issue-next-action',
    'issue-progress-panel',
    'issue-progress-summary',
  ]) {
    assert.doesNotMatch(html, new RegExp(`\\bid\\s*=\\s*(['"])${removedId}\\1`, 'i'));
  }
});

test('LoopX keeps intake history and renders one flat repository task list', async () => {
  const ui = await readAsset('ui.js');

  assert.match(ui, /app\.storage\.get\s*\(INTAKE_HISTORY_STORAGE_KEY\)/);
  assert.match(ui, /app\.storage\.set\s*\(INTAKE_HISTORY_STORAGE_KEY/);
  assert.match(ui, /sortedTaskList\(tasks\)\.forEach\(\(task\)\s*=>\s*fragment\.append\(taskButton\(task\)\)\)/);
  assert.doesNotMatch(ui, /group\.className\s*=\s*['"]task-group['"]/);
  assert.match(ui, /makeActionButton\(text\('resume'\),\s*'resume',\s*task\)/);
  assert.match(ui, /task\.lastAgentSummary/);
  assert.match(ui, /function isResolvedUpstream\(task\)/);
  assert.match(ui, /function issueContext\(task\)/);
  assert.match(ui, /function renderTimeline\(\)/);
  assert.match(ui, /function displayedTask\(\)/);
  assert.doesNotMatch(ui, /issueApiProxy|issueInputModality|issueMacFocus/);
  assert.match(ui, /resumeDetected:\s*true/);
  assert.match(ui, /outputBlockDomKey/);
  assert.match(ui, /syncApprovalAttention/);
  assert.match(ui, /task\.pendingGateId/);
  assert.match(ui, /visibilitychange/);
  assert.match(ui, /pageshow/);
  assert.match(ui, /STALE_ACTIVE_REATTACH_MS/);
  assert.match(ui, /focusedTaskId/);
  assert.match(ui, /focusTaskLogs\(focusedTaskId\s*\|\|\s*null\)/);
  assert.match(ui, /selectTask\(taskId\s*\|\|\s*null\)/);
  assert.match(ui, /resetLoopxDialog\.close\(\)[\s\S]*resettingLoopxBackground/);
});

test('LoopX recovery copy keeps zh/en parity for plan-exhausted cards', async () => {
  const ui = await readAsset('ui.js');
  const keys = [
    'decisionCardTitlePlanExhausted',
    'decisionCardPlanExhaustedHint',
    'recoveryReasonPlanExhausted',
  ];
  for (const key of keys) {
    const occurrences = [...ui.matchAll(new RegExp(`${key}\s*:`, 'g'))].length;
    assert.equal(
      occurrences,
      2,
      `copy key ${key} must exist once per locale (zh-CN and en-US), found ${occurrences}`,
    );
  }
  // The recovery card must branch on the plan-exhausted reason so the card is
  // not stuck with the generic settlement-unverified copy.
  assert.match(
    ui,
    /planExhausted\s*=\s*recovery\s*&&\s*task\.recoveryReason\s*===\s*['"]plan_exhausted['"]/,
  );
  assert.match(ui, /['"]decisionCardTitlePlanExhausted['"]/);
  assert.match(ui, /['"]decisionCardPlanExhaustedHint['"]/);
});
