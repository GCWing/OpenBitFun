#!/usr/bin/env node
/**
 * Seed the isolated E2E sandbox memory database with failure-bookkeeping fixtures.
 *
 * The memory settings surface (Settings > AI > Session & Memory > Memory) renders
 * the persisted phase-1 failure rows (`jobs` with `kind = memory_stage1` and
 * `status = error`), the global phase-2 error, and the stored phase-1 output
 * count. This script writes those rows directly into the sandbox database so the
 * spec can verify rendering, the "clear failed records" action, and the failure
 * expiry sweep without depending on a real provider outage.
 *
 * Rows written (all timestamps relative to the run, so the fixtures stay
 * meaningful no matter when the suite runs):
 *   A. memory_stage1 / a1111111-1111-4111-8111-111111111111  error, retry budget
 *      exhausted, failed 20 days ago, provider JSON rejection in `last_error`.
 *      Older than the default `max_failure_report_days` (14), so the sweep must
 *      expire it.
 *   B. memory_stage1 / b2222222-2222-4222-8222-222222222222  error, 2 retries
 *      left, failed 1 day ago, subagent timeout in `last_error`. Inside the
 *      report window, so the sweep must keep it.
 *   C. memory_consolidate_global / global  done, finished 1 hour ago, with the
 *      same timeout in `last_error`, which renders the phase-2 error row.
 *   D. one `stage1_outputs` row for thread B, already selected for phase 2, with
 *      a recent source watermark and non-empty memory text, so the status card
 *      reports exactly one stored output that must survive both the clear action
 *      and the expiry sweep.
 *
 * The schema is created with the EXACT statements owned by
 * `openbitfun_services_core::memory_store::initialize_memory_schema`
 * (`src/crates/services/services-core/src/memory_store.rs`). Column names and
 * column order are part of that contract: `recreate_table_if_shape_differs`
 * drops a table whose `PRAGMA table_info` column list differs from the expected
 * one, which would silently delete these fixtures on the next host read. Any
 * existing database whose shape does not match is therefore a hard error here
 * instead of a silent overwrite.
 *
 * Storage safety: the resolved database MUST live under `tests/e2e`, so this
 * script can never write the developer's real OpenBitFun profile.
 *
 * Usage:
 *   node ./scripts/seed-memory-failure-fixtures.mjs
 *
 * Env:
 *   OPENBITFUN_E2E_USER_ROOT   sandbox user root override (preferred)
 *   OPENBITFUN_USER_ROOT       sandbox user root override
 *   OPENBITFUN_E2E_STORAGE_ROOT / OPENBITFUN_E2E_STORAGE_ROOT fallback root
 *
 * The script is idempotent: every row is an upsert on its primary key, and the
 * relative timestamps are recomputed on each run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const E2E_DIR = path.resolve(PROJECT_ROOT, 'tests', 'e2e');

/** Session ids are also the `jobs.job_key` of a phase-1 row. */
const STALE_SESSION_ID = 'a1111111-1111-4111-8111-111111111111';
const RECENT_SESSION_ID = 'b2222222-2222-4222-8222-222222222222';

const DAY_SECONDS = 24 * 60 * 60;

/** Provider rejection stored verbatim by the phase-1 failure path. */
const PROVIDER_JSON_LAST_ERROR =
  'Service error: Memory phase1 model call failed: OpenAI Streaming API client error '
  + '403 Forbidden: {"error":{"message":"Access to model denied. Please make sure you are '
  + 'eligible for using the model.","id":"33890c86-aa3d-485c-96e6-f985832b7706",'
  + '"type":"AccessDenied.Unpurchased","code":"AccessDenied.Unpurchased"}}';

/** Subagent timeout the phase-2 runner reports when consolidation is cut off. */
const CONSOLIDATION_TIMEOUT_LAST_ERROR =
  "Timeout: Subagent 'MemoryPhase2' timed out after 1200 seconds";

/** Column contract of `jobs` (order matters). */
const EXPECTED_JOBS_COLUMNS = [
  'kind',
  'job_key',
  'status',
  'worker_id',
  'ownership_token',
  'started_at',
  'finished_at',
  'lease_until',
  'retry_at',
  'retry_remaining',
  'last_error',
  'input_watermark',
  'last_success_watermark',
];

/** Column contract of `stage1_outputs` (order matters). */
const EXPECTED_STAGE1_COLUMNS = [
  'thread_id',
  'workspace_path',
  'rollout_path',
  'source_updated_at',
  'raw_memory',
  'rollout_summary',
  'rollout_slug',
  'generated_at',
  'usage_count',
  'last_usage',
  'selected_for_phase2',
  'selected_for_phase2_source_updated_at',
];

/** Copied verbatim from `initialize_memory_schema` in `memory_store.rs`. */
const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stage1_outputs (
    thread_id TEXT PRIMARY KEY NOT NULL,
    workspace_path TEXT NOT NULL,
    rollout_path TEXT NOT NULL,
    source_updated_at INTEGER NOT NULL,
    raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL,
    rollout_slug TEXT,
    generated_at INTEGER NOT NULL,
    usage_count INTEGER,
    last_usage INTEGER,
    selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
    selected_for_phase2_source_updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_stage1_outputs_source_updated_at
    ON stage1_outputs(source_updated_at DESC, thread_id DESC);

CREATE TABLE IF NOT EXISTS jobs (
    kind TEXT NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    ownership_token TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    lease_until INTEGER,
    retry_at INTEGER,
    retry_remaining INTEGER NOT NULL,
    last_error TEXT,
    input_watermark INTEGER,
    last_success_watermark INTEGER,
    PRIMARY KEY (kind, job_key)
);

CREATE INDEX IF NOT EXISTS idx_jobs_kind_status_retry_lease
    ON jobs(kind, status, retry_at, lease_until);
`;

const UPSERT_JOB_SQL = `
INSERT INTO jobs (
    kind, job_key, status, worker_id, ownership_token, started_at, finished_at,
    lease_until, retry_at, retry_remaining, last_error, input_watermark,
    last_success_watermark
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(kind, job_key) DO UPDATE SET
    status = excluded.status,
    worker_id = excluded.worker_id,
    ownership_token = excluded.ownership_token,
    started_at = excluded.started_at,
    finished_at = excluded.finished_at,
    lease_until = excluded.lease_until,
    retry_at = excluded.retry_at,
    retry_remaining = excluded.retry_remaining,
    last_error = excluded.last_error,
    input_watermark = excluded.input_watermark,
    last_success_watermark = excluded.last_success_watermark
`;

const UPSERT_STAGE1_SQL = `
INSERT INTO stage1_outputs (
    thread_id, workspace_path, rollout_path, source_updated_at, raw_memory,
    rollout_summary, rollout_slug, generated_at, usage_count, last_usage,
    selected_for_phase2, selected_for_phase2_source_updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
    workspace_path = excluded.workspace_path,
    rollout_path = excluded.rollout_path,
    source_updated_at = excluded.source_updated_at,
    raw_memory = excluded.raw_memory,
    rollout_summary = excluded.rollout_summary,
    rollout_slug = excluded.rollout_slug,
    generated_at = excluded.generated_at,
    usage_count = excluded.usage_count,
    last_usage = excluded.last_usage,
    selected_for_phase2 = excluded.selected_for_phase2,
    selected_for_phase2_source_updated_at = excluded.selected_for_phase2_source_updated_at
`;

function fail(message) {
  console.error(`[seed-failure] ERROR: ${message}`);
  process.exit(1);
}

function runtimeRoot() {
  return process.env.OPENBITFUN_E2E_STORAGE_ROOT
    ? path.resolve(process.env.OPENBITFUN_E2E_STORAGE_ROOT)
    : path.join(E2E_DIR, '.openbitfun', 'runtime');
}

/** Same precedence as `tests/e2e/helpers/sandbox-utils.ts`. */
function userRoot() {
  return process.env.OPENBITFUN_E2E_USER_ROOT
    ? path.resolve(process.env.OPENBITFUN_E2E_USER_ROOT)
    : process.env.OPENBITFUN_USER_ROOT
      ? path.resolve(process.env.OPENBITFUN_USER_ROOT)
      : path.join(runtimeRoot(), 'user-root');
}

function homeRoot() {
  return process.env.OPENBITFUN_E2E_HOME
    ? path.resolve(process.env.OPENBITFUN_E2E_HOME)
    : process.env.OPENBITFUN_HOME
      ? path.resolve(process.env.OPENBITFUN_HOME)
      : path.join(runtimeRoot(), 'home');
}

function memoriesDatabaseFile() {
  return path.join(userRoot(), 'data', 'memories', 'memories.sqlite');
}

/** Normalize separators so the sandbox guard works on every platform. */
function normalized(value) {
  return value.replace(/\\/g, '/').toLowerCase();
}

const databaseFile = memoriesDatabaseFile();

if (!normalized(databaseFile).includes('tests/e2e')) {
  fail(
    'refusing to write outside the E2E sandbox: the resolved memory database '
    + `path does not contain "tests/e2e" (resolved: ${databaseFile}). `
    + 'Set OPENBITFUN_E2E_STORAGE_ROOT to an isolated sandbox root.',
  );
}

const nowUnixSecs = Math.floor(Date.now() / 1000);
const home = homeRoot();
const workspacePath = path.join(home, 'projects', 'memory-failure-fixture', 'workspace');

function jobStatement(row) {
  return { sql: UPSERT_JOB_SQL, params: [
    row.kind,
    row.jobKey,
    row.status,
    row.workerId ?? null,
    row.ownershipToken ?? null,
    row.startedAt ?? null,
    row.finishedAt ?? null,
    row.leaseUntil ?? null,
    row.retryAt ?? null,
    row.retryRemaining,
    row.lastError ?? null,
    row.inputWatermark ?? null,
    row.lastSuccessWatermark ?? null,
  ] };
}

/**
 * Fixture rows for one run.
 *
 * `now` is captured once so every row is judged against the same clock by the
 * expiry sweep, which compares `COALESCE(finished_at, started_at)` with
 * `now - max_failure_report_days * 86400`.
 */
function fixtureStatements(now) {
  const staleFailureAt = now - 20 * DAY_SECONDS;
  const recentFailureAt = now - 1 * DAY_SECONDS;
  const consolidationFinishedAt = now - 60 * 60;

  const staleJob = jobStatement({
    kind: 'memory_stage1',
    jobKey: STALE_SESSION_ID,
    status: 'error',
    startedAt: staleFailureAt,
    finishedAt: staleFailureAt,
    retryRemaining: 0,
    lastError: PROVIDER_JSON_LAST_ERROR,
  });

  const recentJob = jobStatement({
    kind: 'memory_stage1',
    jobKey: RECENT_SESSION_ID,
    status: 'error',
    startedAt: recentFailureAt,
    finishedAt: recentFailureAt,
    retryRemaining: 2,
    lastError: CONSOLIDATION_TIMEOUT_LAST_ERROR,
  });

  const consolidationJob = jobStatement({
    kind: 'memory_consolidate_global',
    jobKey: 'global',
    status: 'done',
    startedAt: consolidationFinishedAt,
    finishedAt: consolidationFinishedAt,
    retryRemaining: 3,
    lastError: CONSOLIDATION_TIMEOUT_LAST_ERROR,
    inputWatermark: consolidationFinishedAt,
  });

  const stage1Output = {
    sql: UPSERT_STAGE1_SQL,
    params: [
      RECENT_SESSION_ID,
      workspacePath,
      path.join(home, 'projects', 'memory-failure-fixture', 'sessions', RECENT_SESSION_ID, 'rollout.jsonl'),
      recentFailureAt,
      'Durable project conventions from the memory failure-bookkeeping fixture: '
        + 'the smoke marker is MEMORY_E2E_OK and the verification command is `pnpm run verify:smoke`.',
      `Session ${RECENT_SESSION_ID} recorded the durable project conventions used by the memory E2E fixture.`,
      'memory-failure-fixture',
      recentFailureAt,
      0,
      null,
      1,
      recentFailureAt,
    ],
  };

  return [staleJob, recentJob, consolidationJob, stage1Output];
}

/** `PRAGMA table_info` column names, or an empty array when the table is absent. */
function tableColumns(runQuery, tableName) {
  return runQuery(`PRAGMA table_info(${tableName})`).map(row => String(row[1]));
}

function assertTableShape(columns, expected, tableName) {
  if (columns.length === 0) {
    return;
  }
  if (columns.length !== expected.length || columns.some((name, index) => name !== expected[index])) {
    fail(
      `existing table ${tableName} has columns [${columns.join(', ')}] but the host expects `
      + `[${expected.join(', ')}]. The host would drop this table on its next read `
      + '(recreate_table_if_shape_differs), deleting the fixtures. Delete '
      + `${databaseFile} and re-run this script.`,
    );
  }
}

/** Render parameters as SQL literals for the sqlite3 CLI fallback. */
function toLiteral(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.trunc(value)) : 'NULL';
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function inlineStatement(statement) {
  let parameterIndex = 0;
  const text = statement.sql.replace(/\?/g, () => {
    const literal = toLiteral(statement.params[parameterIndex]);
    parameterIndex += 1;
    return literal;
  });
  return `${text.trim().replace(/;?$/, ';')}`;
}

async function applyWithNodeSqlite() {
  const { DatabaseSync } = await import('node:sqlite');

  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec('PRAGMA busy_timeout = 5000;');
    database.exec(CREATE_SCHEMA_SQL);

    const runQuery = (sql) => database.prepare(sql).all().map(row => Object.values(row));
    assertTableShape(tableColumns(runQuery, 'jobs'), EXPECTED_JOBS_COLUMNS, 'jobs');
    assertTableShape(
      tableColumns(runQuery, 'stage1_outputs'),
      EXPECTED_STAGE1_COLUMNS,
      'stage1_outputs',
    );

    const statements = fixtureStatements(nowUnixSecs);
    for (const statement of statements) {
      database.prepare(statement.sql).run(...statement.params);
    }

    return {
      engine: `node:sqlite (${process.version})`,
      failedRows: database
        .prepare(
          `SELECT job_key, status, retry_remaining, COALESCE(finished_at, started_at), last_error
           FROM jobs WHERE kind = 'memory_stage1' AND status = 'error'
           ORDER BY COALESCE(finished_at, started_at, 0) DESC, job_key ASC`,
        )
        .all(),
      outputCount: Number(
        database.prepare('SELECT COUNT(*) AS count FROM stage1_outputs').get().count,
      ),
      consolidationStatus: database
        .prepare(
          "SELECT status, last_error FROM jobs WHERE kind = 'memory_consolidate_global' AND job_key = 'global'",
        )
        .get(),
    };
  } finally {
    database.close();
  }
}

function runSqliteCli(sqlText) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', [databaseFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A redirected/headless host must not flash a console window.
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`sqlite3 exited with code ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(sqlText);
  });
}

async function applyWithSqliteCli() {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  const statements = fixtureStatements(nowUnixSecs);
  const script = [
    'PRAGMA busy_timeout = 5000;',
    CREATE_SCHEMA_SQL,
    ...statements.map(inlineStatement),
  ].join('\n');

  await runSqliteCli(script);

  const failedRows = await runSqliteCli(
    `.mode json
SELECT job_key, status, retry_remaining, COALESCE(finished_at, started_at) AS failed_at, last_error
FROM jobs WHERE kind = 'memory_stage1' AND status = 'error'
ORDER BY COALESCE(finished_at, started_at, 0) DESC, job_key ASC;`,
  );
  const outputCount = await runSqliteCli(
    'SELECT COUNT(*) FROM stage1_outputs;',
  );
  const consolidationStatus = await runSqliteCli(
    ".mode json\nSELECT status, last_error FROM jobs WHERE kind = 'memory_consolidate_global' AND job_key = 'global';",
  );

  const parseJson = (text) => {
    const trimmed = text.trim();
    return trimmed ? JSON.parse(trimmed) : [];
  };

  return {
    engine: 'sqlite3 CLI (node:sqlite unavailable)',
    failedRows: parseJson(failedRows),
    outputCount: Number.parseInt(outputCount.trim(), 10),
    consolidationStatus: parseJson(consolidationStatus)[0] ?? null,
  };
}

console.log('[seed-failure] Memory failure-bookkeeping fixtures');
console.log(`[seed-failure]   database      : ${databaseFile}`);
console.log(`[seed-failure]   memory home   : ${home}`);

let observed = null;
try {
  observed = await applyWithNodeSqlite();
} catch (error) {
  console.log(`[seed-failure] node:sqlite path failed (${String(error).slice(0, 300)}); falling back to the sqlite3 CLI`);
  try {
    observed = await applyWithSqliteCli();
  } catch (fallbackError) {
    fail(`could not write the fixtures: ${String(fallbackError)}`);
  }
}

console.log(`[seed-failure]   engine        : ${observed.engine}`);
console.log(`[seed-failure]   failed rows   : ${JSON.stringify(observed.failedRows)}`);
console.log(`[seed-failure]   outputs       : ${observed.outputCount}`);
console.log(`[seed-failure]   phase2 job    : ${JSON.stringify(observed.consolidationStatus)}`);

// The seeder only upserts its own rows: it never deletes stage1_outputs or job
// rows another run produced, because those are live host state. A leftover row
// therefore means this sandbox is dirty, not that the fixtures failed to write.
const dirtySandboxHint =
  ` The fixtures are upserts only, so a leftover row means ${databaseFile} still `
  + 'carries state from an earlier run; wipe the sandbox with '
  + '`pnpm --dir tests/e2e run seed:memory-e2e` (it clears the runtime root) before re-running.';

if (observed.outputCount !== 1) {
  fail(
    `expected exactly one stage1_outputs row after seeding, observed ${observed.outputCount}.`
    + dirtySandboxHint,
  );
}
if (observed.failedRows.length !== 2) {
  fail(
    `expected exactly two failed stage1 rows after seeding, observed ${observed.failedRows.length}.`
    + dirtySandboxHint,
  );
}

console.log('[seed-failure] Ready.');
