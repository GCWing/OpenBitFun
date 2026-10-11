/**
 * Filesystem helpers for the isolated E2E sandbox.
 *
 * The embedded driver redirects the app under test into an isolated storage root
 * (`tests/e2e/.openbitfun/runtime`) through `OPENBITFUN_E2E_USER_ROOT` /
 * `OPENBITFUN_E2E_HOME`. These helpers resolve that sandbox from the Node test
 * process so a spec can inspect or patch on-disk state the app owns (session
 * metadata, memory files, config, logs) without ever touching the real user
 * profile.
 *
 * Paths mirror `openbitfun_core::infrastructure::app_paths::PathManager`:
 *   config        <user-root>/config/app.json
 *   memory db     <user-root>/data/memories/memories.sqlite
 *   memory root   <home>/memories
 *   session meta  <home>/projects/<slug>/sessions/<session-id>/metadata.json
 *   logs          <OPENBITFUN_E2E_LOG_DIR>/<session-timestamp>/app.log
 */
import * as fs from 'fs';
import * as path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

export function getE2eRuntimeRoot(): string {
  return process.env.OPENBITFUN_E2E_STORAGE_ROOT
    ? path.resolve(process.env.OPENBITFUN_E2E_STORAGE_ROOT)
    : path.join(PROJECT_ROOT, 'tests', 'e2e', '.openbitfun', 'runtime');
}

export function getE2eUserRoot(): string {
  return process.env.OPENBITFUN_E2E_USER_ROOT
    ? path.resolve(process.env.OPENBITFUN_E2E_USER_ROOT)
    : process.env.OPENBITFUN_USER_ROOT
      ? path.resolve(process.env.OPENBITFUN_USER_ROOT)
      : path.join(getE2eRuntimeRoot(), 'user-root');
}

export function getE2eHomeRoot(): string {
  return process.env.OPENBITFUN_E2E_HOME
    ? path.resolve(process.env.OPENBITFUN_E2E_HOME)
    : process.env.OPENBITFUN_HOME
      ? path.resolve(process.env.OPENBITFUN_HOME)
      : path.join(getE2eRuntimeRoot(), 'home');
}

export function getE2eLogDir(): string {
  return process.env.OPENBITFUN_E2E_LOG_DIR
    ? path.resolve(process.env.OPENBITFUN_E2E_LOG_DIR)
    : path.join(getE2eRuntimeRoot(), 'logs');
}

/** Host-local memory workspace root (`<home>/memories`). */
export function getMemoryRootDir(): string {
  return path.join(getE2eHomeRoot(), 'memories');
}

export function getMemoriesDatabaseFile(): string {
  return path.join(getE2eUserRoot(), 'data', 'memories', 'memories.sqlite');
}

export function getSandboxConfigFile(): string {
  return path.join(getE2eUserRoot(), 'config', 'app.json');
}

export function getProjectsRoot(): string {
  return path.join(getE2eHomeRoot(), 'projects');
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function directoryExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/** List immediate child names of a directory; empty array when it is missing. */
export function listDirectoryNames(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

/** Recursively collect files whose basename matches `fileName`. */
export function findFilesNamed(root: string, fileName: string): string[] {
  const found: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === fileName) {
        found.push(full);
      }
    }
  }

  return found;
}

/** All session metadata files under the sandbox `<home>/projects` tree. */
export function listSessionMetadataFiles(): string[] {
  return findFilesNamed(getProjectsRoot(), 'metadata.json');
}

export interface SessionMetadataFile {
  file: string;
  data: Record<string, unknown>;
}

export function readSessionMetadataFiles(): SessionMetadataFile[] {
  const result: SessionMetadataFile[] = [];
  for (const file of listSessionMetadataFiles()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      result.push({ file, data: parsed });
    } catch {
      // A half-written metadata file is not a test failure; skip it.
    }
  }
  return result;
}

export interface BackdateResult {
  file: string;
  sessionId: string;
  previousLastFinishedAt: number | null;
  newLastFinishedAt: number;
  turnCount: number;
  memoryMode: string | null;
}

/**
 * Backdate the newest memory-enabled session's `lastFinishedAt` so the Phase-1
 * idle gate (`min_rollout_idle_hours`) no longer skips it.
 *
 * The pipeline reads session metadata from disk, so patching the sandbox file is
 * the same input the background pass would see.
 */
export function backdateNewestMemorySessionLastFinishedAt(
  hoursAgo: number,
): BackdateResult | null {
  const candidates = readSessionMetadataFiles()
    .map(({ file, data }) => ({
      file,
      data,
      sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
      memoryMode: typeof data.memoryMode === 'string' ? data.memoryMode : null,
      turnCount: typeof data.turnCount === 'number' ? data.turnCount : 0,
      lastFinishedAt: typeof data.lastFinishedAt === 'number' ? data.lastFinishedAt : null,
    }))
    .filter(entry => entry.memoryMode === 'enabled');

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    if (right.turnCount !== left.turnCount) {
      return right.turnCount - left.turnCount;
    }
    return (right.lastFinishedAt ?? 0) - (left.lastFinishedAt ?? 0);
  });

  const target = candidates[0];
  const newLastFinishedAt = Date.now() - Math.round(hoursAgo * 60 * 60 * 1000);

  const next = {
    ...target.data,
    lastFinishedAt: newLastFinishedAt,
  };
  fs.writeFileSync(target.file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  return {
    file: target.file,
    sessionId: target.sessionId,
    previousLastFinishedAt: target.lastFinishedAt,
    newLastFinishedAt,
    turnCount: target.turnCount,
    memoryMode: target.memoryMode,
  };
}

/** Newest `app.log` under the sandbox log root, or null when none exists yet. */
export function findNewestAppLogFile(): string | null {
  const logs = findFilesNamed(getE2eLogDir(), 'app.log');
  if (logs.length === 0) {
    return null;
  }

  logs.sort((left, right) => {
    try {
      return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });

  return logs[0];
}

/**
 * Newest harness-captured app stdout log, or null when none exists yet.
 *
 * In embedded WebDriver mode the app logs to stdout only
 * (`build_log_targets` skips file targets while `OPENBITFUN_WEBDRIVER_PORT` is
 * set), so `app.log` never appears and `config/embedded-driver.ts` mirrors
 * stdout into `app-stdout-<timestamp>.log` for host-side assertions.
 */
export function findNewestAppStdoutLogFile(): string | null {
  const logs = fs.existsSync(getE2eLogDir())
    ? fs.readdirSync(getE2eLogDir())
      .filter(name => name.startsWith('app-stdout-') && name.endsWith('.log'))
      .map(name => path.join(getE2eLogDir(), name))
    : [];
  if (logs.length === 0) {
    return null;
  }

  logs.sort((left, right) => {
    try {
      return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });

  return logs[0];
}

export function readTextFile(filePath: string, maxBytes = 64 * 1024 * 1024): string {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) {
      return fs.readFileSync(filePath, 'utf8');
    }
    // Read only the tail of an oversized log; recent lines carry the evidence.
    const handle = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(handle, buffer, 0, maxBytes, stat.size - maxBytes);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return '';
  }
}

/** Lines of a text file that contain `needle` (case-sensitive). */
export function grepLines(filePath: string, needle: string): string[] {
  return readTextFile(filePath)
    .split(/\r?\n/)
    .filter(line => line.includes(needle));
}

/** Immediate child files of a directory (name + size + mtime). */
export function listFiles(dirPath: string): Array<{ name: string; size: number; mtimeMs: number }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const full = path.join(dirPath, entry.name);
    try {
      const stat = fs.statSync(full);
      files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Skip unreadable entries.
    }
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

/** Recursive relative listing of a directory tree, for evidence reports. */
export function listTree(root: string, maxDepth = 4): string[] {
  const out: string[] = [];

  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        out.push(`${relative}/`);
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = 0;
        }
        out.push(`${relative} (${size} B)`);
      }
    }
  };

  walk(root, 1);
  return out;
}

export default {
  getE2eRuntimeRoot,
  getE2eUserRoot,
  getE2eHomeRoot,
  getE2eLogDir,
  getMemoryRootDir,
  getMemoriesDatabaseFile,
  getSandboxConfigFile,
  getProjectsRoot,
  fileExists,
  directoryExists,
  listDirectoryNames,
  findFilesNamed,
  listSessionMetadataFiles,
  readSessionMetadataFiles,
  backdateNewestMemorySessionLastFinishedAt,
  findNewestAppLogFile,
  findNewestAppStdoutLogFile,
  readTextFile,
  grepLines,
  listFiles,
  listTree,
};
