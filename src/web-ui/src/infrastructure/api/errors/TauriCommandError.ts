import { isSurfaceChangedError, type SurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';

export interface TauriCommandErrorContext {
  command: string;
  request?: any;
  originalError?: any;
  timestamp?: string;
}

export class TauriCommandError extends Error {
  public readonly context: TauriCommandErrorContext;
  public readonly isTauriCommandError = true;

  constructor(
    message: string,
    context: TauriCommandErrorContext
  ) {
    super(message);
    this.name = 'TauriCommandError';
    this.context = {
      ...context,
      timestamp: new Date().toISOString()
    };

    
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TauriCommandError);
    }
  }

   
  public getFormattedMessage(): string {
    const { command, request, originalError, timestamp } = this.context;
    
    let message = `[${timestamp}] Tauri command failed: ${command}\n`;
    message += `Error message: ${this.message}\n`;
    
    if (request) {
      message += `Request payload: ${JSON.stringify(request, null, 2)}\n`;
    }
    
    if (originalError) {
      message += `Original error: ${originalError.message || originalError}\n`;
    }
    
    return message;
  }

   
  public isNetworkError(): boolean {
    const message = this.message.toLowerCase();
    return message.includes('network') || 
           message.includes('connection') || 
           message.includes('timeout') ||
           message.includes('fetch');
  }

   
  public isPermissionError(): boolean {
    const message = this.message.toLowerCase();
    return message.includes('permission') || 
           message.includes('access') || 
           message.includes('unauthorized') ||
           message.includes('forbidden');
  }

   
  public isParameterError(): boolean {
    const message = this.message.toLowerCase();
    return message.includes('parameter') || 
           message.includes('argument') || 
           message.includes('invalid') ||
           message.includes('missing');
  }
}

 
export function createTauriCommandError(
  command: string,
  originalError: any,
  request?: any
): TauriCommandError | SurfaceChangedError {
  // Device activation cancellation is control flow across every service API.
  // Wrapping it would make callers report/retry stale work on the next host.
  if (isSurfaceChangedError(originalError)) return originalError;

  let message = 'Unknown error';
  
  if (originalError?.message) {
    message = originalError.message;
  } else if (typeof originalError === 'string') {
    message = originalError;
  }

  return new TauriCommandError(message, {
    command,
    request,
    originalError
  });
}

 
export function isTauriCommandError(error: any): error is TauriCommandError {
  return error && error.isTauriCommandError === true;
}

const SESSION_IN_USE_PREFIX = 'session_in_use:';
const OUTCOME_UNKNOWN_PREFIX = 'outcome_unknown:';
const NOT_AVAILABLE_PREFIX = 'not_available:';
const GIT_REPOSITORY_UNTRUSTED_PREFIX = 'git_repository_untrusted:';

/** Returns the payload carried after a stable error prefix, if present. */
function stableErrorPayload(error: unknown, prefix: string): string | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  // The budget bounds a hostile or deeply nested payload. It counts only nodes
  // that could carry the code — absent fields are never queued, so a wrapper
  // that fills two of its five slots does not spend the budget on the other
  // three and truncate the walk before the code is reached.
  for (let inspected = 0; pending.length > 0 && inspected < 24; inspected += 1) {
    const current = pending.shift();
    if (typeof current === 'string') {
      const trimmed = current.trimStart();
      if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
      continue;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    const candidate = current as {
      message?: unknown;
      data?: unknown;
      originalError?: unknown;
      context?: { originalError?: unknown };
      details?: { originalError?: unknown };
    };
    for (const next of [
      candidate.message,
      // Web mode reaches the host over JSON-RPC, where the code rides in the
      // error `data` and `message` is the generic protocol phrase.
      candidate.data,
      candidate.originalError,
      candidate.context?.originalError,
      candidate.details?.originalError,
    ]) {
      if (next !== undefined && next !== null) pending.push(next);
    }
  }

  return undefined;
}

function hasStableErrorPrefix(error: unknown, prefix: string): boolean {
  return stableErrorPayload(error, prefix) !== undefined;
}

/** Recognizes the stable Desktop/Peer error code without parsing localized prose. */
export function isSessionInUseError(error: unknown): boolean {
  return hasStableErrorPrefix(error, SESSION_IN_USE_PREFIX);
}

/** Identifies a mutation that must be read back before the user retries it. */
export function isOutcomeUnknownError(error: unknown): boolean {
  return hasStableErrorPrefix(error, OUTCOME_UNKNOWN_PREFIX);
}

/** Identifies a capability or persisted selection unsupported by this Host. */
export function isNotAvailableError(error: unknown): boolean {
  return hasStableErrorPrefix(error, NOT_AVAILABLE_PREFIX);
}

/**
 * Identifies a repository Git refuses to read because it is owned by another
 * user. The repository still exists: the user can grant ownership trust.
 */
export function isGitRepositoryUntrustedError(error: unknown): boolean {
  return hasStableErrorPrefix(error, GIT_REPOSITORY_UNTRUSTED_PREFIX);
}

/**
 * Existing hosts serialize Git repository discovery failures as English text.
 * Match their specific prefixes through transport wrappers, not generic
 * "not found" messages (which can also mean a missing file or revision).
 */
export function isGitRepositoryNotFoundError(error: unknown): boolean {
  return [
    'Failed to get Git status: Repository not found:',
    'Repository not found:',
    'fatal: not a git repository (or any of the parent directories):',
  ].some((prefix) => stableErrorPayload(error, prefix) !== undefined);
}

/** Repository path Git rejected, as reported by the backend. */
export function gitRepositoryUntrustedPath(error: unknown): string | undefined {
  const payload = stableErrorPayload(error, GIT_REPOSITORY_UNTRUSTED_PREFIX);
  return payload ? payload : undefined;
}

/** Identifies missing Git in the environment executing the workspace. */
export function isGitUnavailableError(error: unknown): boolean {
  return hasStableErrorPrefix(error, 'git_unavailable:');
}

const REMOTE_WORKSPACE_CONNECTION_CONFLICT_PREFIX = 'remote_workspace_connection_conflict:';

/**
 * Identifies a remote workspace record bound to another saved SSH connection.
 * The host keeps the record until the user confirms moving it.
 */
export function isRemoteWorkspaceConnectionConflictError(error: unknown): boolean {
  return hasStableErrorPrefix(error, REMOTE_WORKSPACE_CONNECTION_CONFLICT_PREFIX);
}

/** Connection that currently owns the conflicting remote workspace record. */
export function remoteWorkspaceConnectionConflictOwner(error: unknown): string | undefined {
  const payload = stableErrorPayload(error, REMOTE_WORKSPACE_CONNECTION_CONFLICT_PREFIX);
  return payload?.match(/bound to SSH connection (\S+);/)?.[1];
}

/** Stable Review-platform failure kind, preserved through transport wrappers. */
export function reviewPlatformErrorCode(error: unknown): string | undefined {
  return stableErrorPayload(error, 'review_platform_error:')?.split(':', 1)[0].trim();
}
