import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SESSION_STORAGE_SCHEMA_VERSION = 2;
const MAX_PROJECT_SLUG_LEN = 120;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function defaultOpenBitFunHome() {
  if (process.env.OPENBITFUN_E2E_HOME) {
    return process.env.OPENBITFUN_E2E_HOME;
  }
  if (process.env.OPENBITFUN_E2E_USE_REAL_PROFILE === '1') {
    return process.env.OPENBITFUN_HOME || path.join(os.homedir(), '.openbitfun');
  }
  return path.resolve(__dirname, '..', '.openbitfun', 'runtime', 'home');
}

function defaultOpenBitFunUserRoot() {
  if (process.env.OPENBITFUN_E2E_USER_ROOT) {
    return process.env.OPENBITFUN_E2E_USER_ROOT;
  }
  if (process.env.OPENBITFUN_E2E_USE_REAL_PROFILE === '1') {
    return null;
  }
  return path.resolve(__dirname, '..', '.openbitfun', 'runtime', 'user-root');
}

function parseArgs(argv) {
  const options = {
    workspace: undefined,
    openbitfunHome: defaultOpenBitFunHome(),
    openbitfunUserRoot: defaultOpenBitFunUserRoot(),
    sessionPrefix: 'perf-long-session',
    scenario: 'mixed-visible',
    sessionCount: 80,
    longSessionIndex: 0,
    longTurns: 80,
    shortTurns: 1,
    assistantChars: 2_000,
    toolResultChars: 12_000,
    toolItems: 2,
    denseGroups: 160,
    lastActiveAtBase: undefined,
    lastActiveStepMs: 1_000,
    cleanup: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    switch (arg) {
      case '--workspace':
        options.workspace = next();
        break;
      case '--openbitfun-home':
        options.openbitfunHome = next();
        break;
      case '--openbitfun-user-root':
        options.openbitfunUserRoot = next();
        break;
      case '--session-prefix':
        options.sessionPrefix = next();
        break;
      case '--scenario':
        options.scenario = next();
        break;
      case '--session-count':
        options.sessionCount = Number(next());
        break;
      case '--long-session-index':
        options.longSessionIndex = Number(next());
        break;
      case '--long-turns':
        options.longTurns = Number(next());
        break;
      case '--short-turns':
        options.shortTurns = Number(next());
        break;
      case '--assistant-chars':
        options.assistantChars = Number(next());
        break;
      case '--tool-result-chars':
        options.toolResultChars = Number(next());
        break;
      case '--tool-items':
        options.toolItems = Number(next());
        break;
      case '--dense-groups':
        options.denseGroups = Number(next());
        break;
      case '--last-active-at-base':
        options.lastActiveAtBase = Number(next());
        break;
      case '--last-active-step-ms':
        options.lastActiveStepMs = Number(next());
        break;
      case '--cleanup':
        options.cleanup = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.workspace) {
    throw new Error('Missing --workspace');
  }
  for (const key of ['sessionCount', 'longSessionIndex', 'longTurns', 'shortTurns', 'assistantChars', 'toolResultChars', 'toolItems', 'denseGroups', 'lastActiveStepMs']) {
    if (!Number.isFinite(options[key]) || options[key] < 0) {
      throw new Error(`Invalid numeric value for ${key}`);
    }
  }
  if (options.lastActiveAtBase !== undefined && !Number.isFinite(options.lastActiveAtBase)) {
    throw new Error('Invalid numeric value for lastActiveAtBase');
  }
  if (options.lastActiveStepMs <= 0) {
    throw new Error('--last-active-step-ms must be greater than 0');
  }
  if (options.sessionCount < 1) {
    throw new Error('--session-count must be at least 1');
  }
  if (options.longSessionIndex >= options.sessionCount) {
    throw new Error('--long-session-index must be smaller than --session-count');
  }
  if (!options.sessionPrefix.trim()) {
    throw new Error('--session-prefix cannot be empty');
  }
  if (!['explore-only', 'mixed-visible', 'dense-visible', 'user-only-latest'].includes(options.scenario)) {
    throw new Error('--scenario must be one of: explore-only, mixed-visible, dense-visible, user-only-latest');
  }
  return options;
}

function printHelp() {
  console.log(`Generate OpenBitFun long-session performance fixtures.

Usage:
  node tests/e2e/scripts/generate-long-session-fixture.mjs --workspace <path> [options]

Options:
  --session-count <n>       Number of metadata rows to create. Default: 80
  --long-session-index <n>  Session index that receives long-turn content. Default: 0
  --long-turns <n>          Turn count for the selected long session. Default: 80
  --short-turns <n>         Turn count for other sessions. Default: 1
  --assistant-chars <n>     Assistant text chars per turn. Default: 2000
  --tool-result-chars <n>   Raw tool result chars per tool item. Default: 12000
  --tool-items <n>          Tool item count per turn. Default: 2
  --dense-groups <n>        Groups in the latest dense-visible turn. Default: 160
  --last-active-at-base <n> Epoch-ms lastActiveAt for session index 0. Default: Date.now()
  --last-active-step-ms <n> lastActiveAt decrement per session index. Default: 1000
  --session-prefix <text>   Session id prefix. Default: perf-long-session
  --scenario <name>         Fixture shape: mixed-visible, dense-visible, explore-only, or user-only-latest. Default: mixed-visible
  --openbitfun-home <path>      OpenBitFun home root. Default: OPENBITFUN_E2E_HOME or isolated tests/e2e/.openbitfun/runtime/home; OPENBITFUN_HOME is used only with OPENBITFUN_E2E_USE_REAL_PROFILE=1
  --openbitfun-user-root <path> OpenBitFun user config root for seeding active workspace. Default: OPENBITFUN_E2E_USER_ROOT or isolated tests/e2e/.openbitfun/runtime/user-root; skipped for real profile unless provided
  --cleanup                 Remove generated sessions for the prefix.
`);
}

function stableLocalWorkspaceRoot(workspacePath) {
  return fsSync.realpathSync(workspacePath).replace(/\\/g, '/');
}

function localWorkspaceStableStorageId(stableRoot) {
  const hash = crypto
    .createHash('sha256')
    .update('localhost\n')
    .update(stableRoot)
    .digest('hex')
    .slice(0, 32);
  return `local_${hash}`;
}

function projectRuntimeSlug(workspacePath) {
  const canonical = fsSync.realpathSync(workspacePath);
  const slug = canonical
    .split('')
    .map(ch => /[a-zA-Z0-9]/.test(ch) ? ch.toLowerCase() : '-')
    .join('')
    .replace(/^-+|-+$/g, '') || 'workspace';

  if (slug.length <= MAX_PROJECT_SLUG_LEN) {
    return slug;
  }

  const suffix = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  const maxPrefixLen = MAX_PROJECT_SLUG_LEN - suffix.length - 1;
  return `${slug.slice(0, maxPrefixLen).replace(/-+$/g, '')}-${suffix}`;
}

function repeatedText(chars, label) {
  if (chars <= label.length + 1) {
    return label.slice(0, chars);
  }
  return `${label} ${'x'.repeat(chars - label.length - 1)}`;
}

function repeatedMarkdown(chars, turnIndex) {
  const seed = [
    `Synthetic assistant response ${turnIndex}`,
    '',
    'The fixture keeps visible narrative content outside collapsed explore groups so scroll anchoring is tested against realistic heights.',
    '',
    '```ts',
    `export function fixtureTurn${turnIndex}() {`,
    `  return "turn-${turnIndex}-visible-content";`,
    '}',
    '```',
    '',
    '| Area | Observation |',
    '| --- | --- |',
    '| restore | checks latest-turn anchoring |',
    '| render | includes markdown, code, and table blocks |',
    '',
  ].join('\n');

  if (chars <= seed.length) {
    return seed.slice(0, chars);
  }

  const paragraph = `Visible markdown paragraph for turn ${turnIndex}. `;
  let content = seed;
  while (content.length < chars) {
    content += paragraph;
  }
  return content.slice(0, chars);
}

function makeMetadata({ sessionId, sessionName, workspacePath, createdAt, lastActiveAt, turnCount, toolItems, scenario }) {
  return {
    sessionId,
    sessionName,
    agentType: 'agentic',
    lastUserDialogAgentType: 'agentic',
    lastSubmittedAgentType: 'agentic',
    createdBy: null,
    sessionKind: 'standard',
    modelName: 'perf-fixture-model',
    createdAt,
    lastActiveAt,
    turnCount,
    messageCount: scenario === 'user-only-latest' ? (turnCount * 2) - 1 : turnCount * 2,
    toolCallCount: turnCount * toolItems,
    status: 'active',
    terminalSessionId: null,
    snapshotSessionId: null,
    tags: ['performance-fixture'],
    customMetadata: {
      generatedBy: 'tests/e2e/scripts/generate-long-session-fixture.mjs',
      fixtureVersion: 2,
      fixtureScenario: scenario,
      lastFinishedAt: lastActiveAt,
    },
    relationship: null,
    todos: null,
    deepReviewRunManifest: null,
    deepReviewCache: null,
    workspacePath,
    workspaceHostname: 'localhost',
    unreadCompletion: null,
    needsUserAttention: null,
  };
}

function makeState(workspacePath) {
  return {
    schema_version: SESSION_STORAGE_SCHEMA_VERSION,
    config: {
      max_context_tokens: 128128,
      auto_compact: true,
      enable_tools: true,
      safe_mode: true,
      max_turns: 200,
      enable_context_compression: true,
      compression_threshold: 0.8,
      workspace_path: workspacePath,
      workspace_id: null,
      remote_connection_id: null,
      remote_ssh_host: null,
      model_id: 'perf-fixture-model',
    },
    snapshot_session_id: null,
    last_user_dialog_agent_type: 'agentic',
    last_submitted_agent_type: 'agentic',
    compression_state: {
      last_compression_at: null,
      compression_count: 0,
    },
    runtime_state: 'Idle',
  };
}

function makeToolItems({ turnId, turnIndex, timestamp, toolResultChars, toolItems }) {
  return Array.from({ length: toolItems }, (_, toolIndex) => {
    const toolId = `${turnId}-tool-${toolIndex}`;
    return {
      id: toolId,
      toolName: 'Read',
      toolCall: {
        id: toolId,
        input: {
          filePath: `/workspace/perf-fixture-${turnIndex}-${toolIndex}.txt`,
        },
      },
      toolResult: {
        result: {
          output: repeatedText(toolResultChars, `raw result ${turnIndex}.${toolIndex}`),
          fixture: true,
        },
        success: true,
        resultForAssistant: repeatedText(
          Math.min(512, toolResultChars),
          `assistant result ${turnIndex}.${toolIndex}`,
        ),
        durationMs: 5,
      },
      aiIntent: 'Synthetic performance fixture tool result',
      startTime: timestamp + 10,
      endTime: timestamp + 15,
      durationMs: 5,
      queueWaitMs: 0,
      preflightMs: 0,
      confirmationWaitMs: 0,
      executionMs: 5,
      orderIndex: toolIndex,
      status: 'completed',
    };
  });
}

function makeTextItem({ turnId, turnIndex, timestamp, assistantChars, orderIndex }) {
  return {
    id: `${turnId}-text-0`,
    content: repeatedMarkdown(assistantChars, turnIndex),
    isStreaming: false,
    timestamp: timestamp + 20,
    isMarkdown: true,
    orderIndex,
    status: 'completed',
  };
}

function makeDenseTextItem({ turnId, turnIndex, groupIndex, timestamp, assistantChars, orderIndex }) {
  return {
    id: `${turnId}-dense-text-${groupIndex}`,
    content: repeatedMarkdown(
      Math.max(240, Math.min(assistantChars, 900)),
      `${turnIndex}-${groupIndex}`,
    ),
    isStreaming: false,
    timestamp: timestamp + 20 + groupIndex,
    isMarkdown: true,
    orderIndex,
    status: 'completed',
  };
}

function makeDenseToolItem({ turnId, turnIndex, groupIndex, timestamp, toolResultChars, orderIndex }) {
  const toolId = `${turnId}-dense-tool-${groupIndex}`;
  return {
    id: toolId,
    toolName: 'Read',
    toolCall: {
      id: toolId,
      input: {
        filePath: `/workspace/perf-dense-${turnIndex}-${groupIndex}.txt`,
      },
    },
    toolResult: {
      result: {
        output: repeatedText(
          Math.min(toolResultChars, 2_000),
          `dense raw result ${turnIndex}.${groupIndex}`,
        ),
        fixture: true,
      },
      success: true,
      resultForAssistant: repeatedText(
        Math.min(512, toolResultChars),
        `dense assistant result ${turnIndex}.${groupIndex}`,
      ),
      durationMs: 5,
    },
    aiIntent: 'Synthetic dense performance fixture tool result',
    startTime: timestamp + 10 + groupIndex,
    endTime: timestamp + 15 + groupIndex,
    durationMs: 5,
    queueWaitMs: 0,
    preflightMs: 0,
    confirmationWaitMs: 0,
    executionMs: 5,
    orderIndex,
    status: 'completed',
  };
}

function makeDenseLatestModelRounds({ turnId, turnIndex, timestamp, assistantChars, toolResultChars, denseGroups }) {
  const textItems = [];
  const toolItems = [];
  const groupCount = Math.max(1, denseGroups);

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const orderIndex = groupIndex;
    // Alternate dense tool/history groups with visible text so the fixture
    // exercises both progressive model-round rendering and latest content paint.
    if (groupIndex % 4 === 3 || groupIndex >= groupCount - 8) {
      textItems.push(makeDenseTextItem({
        turnId,
        turnIndex,
        groupIndex,
        timestamp,
        assistantChars,
        orderIndex,
      }));
    } else {
      toolItems.push(makeDenseToolItem({
        turnId,
        turnIndex,
        groupIndex,
        timestamp,
        toolResultChars,
        orderIndex,
      }));
    }
  }

  return [
    {
      id: `${turnId}-dense-round-0`,
      turnId,
      roundIndex: 0,
      timestamp: timestamp + 1,
      textItems,
      toolItems,
      thinkingItems: [],
      startTime: timestamp + 1,
      endTime: timestamp + 30,
      durationMs: 29,
      providerId: 'perf-fixture',
      modelId: 'perf-fixture-model',
      modelAlias: 'Perf Fixture',
      status: 'completed',
    },
  ];
}

function makeTurn({
  sessionId,
  turnIndex,
  totalTurns,
  timestamp,
  assistantChars,
  toolResultChars,
  toolItems,
  scenario,
  denseGroups,
}) {
  const turnId = `${sessionId}-turn-${String(turnIndex).padStart(4, '0')}`;
  const toolItemsData = makeToolItems({ turnId, turnIndex, timestamp, toolResultChars, toolItems });
  const isLatestTurn = turnIndex === totalTurns - 1;
  const modelRounds = scenario === 'user-only-latest' && isLatestTurn
    ? []
    : scenario === 'dense-visible' && isLatestTurn
    ? makeDenseLatestModelRounds({
      turnId,
      turnIndex,
      timestamp,
      assistantChars,
      toolResultChars,
      denseGroups,
    })
    : scenario === 'explore-only'
    ? [
      {
        id: `${turnId}-round-0`,
        turnId,
        roundIndex: 0,
        timestamp: timestamp + 1,
        textItems: [
          makeTextItem({ turnId, turnIndex, timestamp, assistantChars, orderIndex: toolItems }),
        ],
        toolItems: toolItemsData,
        thinkingItems: [],
        startTime: timestamp + 1,
        endTime: timestamp + 30,
        durationMs: 29,
        providerId: 'perf-fixture',
        modelId: 'perf-fixture-model',
        modelAlias: 'Perf Fixture',
        status: 'completed',
      },
    ]
    : [
      {
        id: `${turnId}-round-0`,
        turnId,
        roundIndex: 0,
        timestamp: timestamp + 1,
        textItems: [],
        toolItems: toolItemsData,
        thinkingItems: [],
        startTime: timestamp + 1,
        endTime: timestamp + 15,
        durationMs: 14,
        providerId: 'perf-fixture',
        modelId: 'perf-fixture-model',
        modelAlias: 'Perf Fixture',
        status: 'completed',
      },
      {
        id: `${turnId}-round-1`,
        turnId,
        roundIndex: 1,
        timestamp: timestamp + 20,
        textItems: [
          makeTextItem({ turnId, turnIndex, timestamp, assistantChars, orderIndex: 0 }),
        ],
        toolItems: [],
        thinkingItems: [],
        startTime: timestamp + 20,
        endTime: timestamp + 30,
        durationMs: 10,
        providerId: 'perf-fixture',
        modelId: 'perf-fixture-model',
        modelAlias: 'Perf Fixture',
        status: 'completed',
      },
    ];

  return {
    schema_version: SESSION_STORAGE_SCHEMA_VERSION,
    turnId,
    turnIndex,
    sessionId,
    timestamp,
    kind: 'user_dialog',
    agentType: 'agentic',
    userMessage: {
      id: `${turnId}-user`,
      content: `Synthetic user turn ${turnIndex}`,
      timestamp,
      metadata: {
        generatedBy: 'performance-fixture',
      },
    },
    modelRounds,
    startTime: timestamp,
    endTime: timestamp + 30,
    durationMs: 30,
    status: 'completed',
  };
}

async function readIndex(indexPath) {
  try {
    return JSON.parse(await fs.readFile(indexPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function seedWorkspaceState(options, workspacePath) {
  if (!options.openbitfunUserRoot) {
    return null;
  }

  const userRoot = path.resolve(options.openbitfunUserRoot);
  const workspaceDataPath = path.join(userRoot, 'data', 'workspace_data.json');
  const existing = await readJsonOptional(workspaceDataPath);
  const workspaces = existing?.workspaces && typeof existing.workspaces === 'object'
    ? { ...existing.workspaces }
    : {};
  const stableRoot = stableLocalWorkspaceRoot(workspacePath);
  const workspaceId = localWorkspaceStableStorageId(stableRoot);
  const workspaceName = path.basename(workspacePath) || 'Workspace';
  const nowIso = new Date().toISOString();
  const previous = workspaces[workspaceId] && typeof workspaces[workspaceId] === 'object'
    ? workspaces[workspaceId]
    : {};

  workspaces[workspaceId] = {
    ...previous,
    id: workspaceId,
    name: previous.name || workspaceName,
    rootPath: workspacePath,
    workspaceType: previous.workspaceType || 'Other',
    workspaceKind: 'normal',
    status: 'Active',
    languages: Array.isArray(previous.languages) ? previous.languages : [],
    openedAt: previous.openedAt || nowIso,
    lastAccessed: nowIso,
    description: previous.description ?? null,
    tags: Array.isArray(previous.tags) ? previous.tags : [],
    statistics: previous.statistics ?? null,
    relatedPaths: Array.isArray(previous.relatedPaths) ? previous.relatedPaths : [],
    metadata: {
      ...(previous.metadata && typeof previous.metadata === 'object' ? previous.metadata : {}),
      sshHost: 'localhost',
    },
  };

  const openedWorkspaceIds = Array.from(new Set([
    workspaceId,
    ...(
      Array.isArray(existing?.opened_workspace_ids)
        ? existing.opened_workspace_ids.filter(id => typeof id === 'string' && id !== workspaceId)
        : []
    ),
  ]));
  const recentWorkspaces = Array.from(new Set([
    workspaceId,
    ...(
      Array.isArray(existing?.recent_workspaces)
        ? existing.recent_workspaces.filter(id => typeof id === 'string' && id !== workspaceId)
        : []
    ),
  ])).slice(0, 20);

  await writeJson(workspaceDataPath, {
    format_version: 1,
    product_id: 'openbitfun',
    workspaces,
    opened_workspace_ids: openedWorkspaceIds,
    current_workspace_id: workspaceId,
    recent_workspaces: recentWorkspaces,
    recent_assistant_workspaces: Array.isArray(existing?.recent_assistant_workspaces)
      ? existing.recent_assistant_workspaces.filter(id => typeof id === 'string')
      : [],
    saved_at: nowIso,
  });

  return {
    workspaceId,
    workspaceDataPath,
  };
}

async function removeGeneratedSessions(sessionsRoot, sessionPrefix) {
  try {
    const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
    await Promise.all(entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith(sessionPrefix))
      .map(entry => fs.rm(path.join(sessionsRoot, entry.name), { recursive: true, force: true })));
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function writeIndex(sessionsRoot, generatedMetadata, sessionPrefix) {
  const indexPath = path.join(sessionsRoot, 'index.json');
  const existing = await readIndex(indexPath);
  const existingSessions = Array.isArray(existing?.sessions) ? existing.sessions : [];
  const retained = existingSessions.filter(session =>
    typeof session?.sessionId === 'string' && !session.sessionId.startsWith(sessionPrefix)
  );
  const sessions = [...generatedMetadata, ...retained]
    .sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0));

  await writeJson(indexPath, {
    schema_version: SESSION_STORAGE_SCHEMA_VERSION,
    updated_at: Date.now(),
    metadata_file_count: sessions.length,
    sessions,
  });
}

async function generate(options) {
  const workspacePath = fsSync.realpathSync(options.workspace);
  const slug = projectRuntimeSlug(workspacePath);
  const sessionsRoot = path.join(options.openbitfunHome, 'projects', slug, 'sessions');

  await fs.mkdir(sessionsRoot, { recursive: true });
  await removeGeneratedSessions(sessionsRoot, options.sessionPrefix);

  if (options.cleanup) {
    await writeIndex(sessionsRoot, [], options.sessionPrefix);
    return {
      action: 'cleanup',
      workspacePath,
      sessionsRoot,
      sessionPrefix: options.sessionPrefix,
      workspaceStateSeeded: false,
    };
  }

  const seededWorkspaceState = await seedWorkspaceState(options, workspacePath);

  const now = Date.now();
  const lastActiveAtBase = options.lastActiveAtBase ?? now;
  const generatedMetadata = [];
  for (let sessionIndex = 0; sessionIndex < options.sessionCount; sessionIndex += 1) {
    const sessionId = `${options.sessionPrefix}-${String(sessionIndex).padStart(3, '0')}`;
    const isLongSession = sessionIndex === options.longSessionIndex;
    const turnCount = isLongSession ? options.longTurns : options.shortTurns;
    const createdAt = now - sessionIndex * 60_000;
    const lastActiveAt = lastActiveAtBase - sessionIndex * options.lastActiveStepMs;
    const sessionDir = path.join(sessionsRoot, sessionId);
    const turnsDir = path.join(sessionDir, 'turns');
    const metadata = makeMetadata({
      sessionId,
      sessionName: isLongSession
        ? `Perf Fixture Long Session (${turnCount} turns)`
        : `Perf Fixture Session ${sessionIndex}`,
      workspacePath,
      createdAt,
      lastActiveAt,
      turnCount,
      toolItems: options.toolItems,
      scenario: options.scenario,
    });

    await fs.mkdir(turnsDir, { recursive: true });
    await writeJson(path.join(sessionDir, 'metadata.json'), {
      schema_version: SESSION_STORAGE_SCHEMA_VERSION,
      ...metadata,
    });
    await writeJson(path.join(sessionDir, 'state.json'), makeState(workspacePath));

    for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
      await writeJson(
        path.join(turnsDir, `turn-${String(turnIndex).padStart(4, '0')}.json`),
        makeTurn({
          sessionId,
          turnIndex,
          totalTurns: turnCount,
          timestamp: createdAt + turnIndex * 1_000,
          assistantChars: options.assistantChars,
          toolResultChars: options.toolResultChars,
          toolItems: options.toolItems,
          scenario: options.scenario,
          denseGroups: options.denseGroups,
        }),
      );
    }

    generatedMetadata.push(metadata);
  }

  await writeIndex(sessionsRoot, generatedMetadata, options.sessionPrefix);
  return {
    action: 'generate',
    workspacePath,
    openbitfunHome: options.openbitfunHome,
    openbitfunUserRoot: options.openbitfunUserRoot,
    sessionsRoot,
    sessionPrefix: options.sessionPrefix,
    workspaceStateSeeded: Boolean(seededWorkspaceState),
    workspaceStatePath: seededWorkspaceState?.workspaceDataPath,
    sessionCount: options.sessionCount,
    longSessionId: `${options.sessionPrefix}-${String(options.longSessionIndex).padStart(3, '0')}`,
    scenario: options.scenario,
    longTurns: options.longTurns,
    assistantChars: options.assistantChars,
    toolResultChars: options.toolResultChars,
    toolItems: options.toolItems,
    denseGroups: options.denseGroups,
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await generate(options);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('Run with --help for usage.');
  process.exit(1);
}
