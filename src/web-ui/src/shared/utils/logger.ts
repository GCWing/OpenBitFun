/**
 * Unified logging utility
 * Provides leveled logging with @tauri-apps/plugin-log backend
 * Falls back to console in non-Tauri environments
 */

import {
  trace as tauriTrace,
  debug as tauriDebug,
  info as tauriInfo,
  warn as tauriWarn,
  error as tauriError,
} from '@tauri-apps/plugin-log';

export enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  NONE = 5,
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  context?: string;
  data?: any;
}

// Check if running in Tauri environment
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
const isDev = import.meta.env?.DEV ?? process.env.NODE_ENV === 'development';

const CONSOLE_FORWARD_INSTALLED = '__openbitfun_console_forward_installed__';
// Off until the saved preference is loaded (#3213): the settings UI and the
// backend config both default sensitive diagnostics to disabled.
let includeSensitiveDiagnostics = false;

declare global {
  // Injected by the desktop WebView initialization script before the frontend bundle runs.
  var __OPENBITFUN_BOOTSTRAP_LOG_LEVEL__: string | undefined;
}

export function setIncludeSensitiveDiagnostics(enabled: boolean): void {
  includeSensitiveDiagnostics = enabled;
}

export function areSensitiveDiagnosticsEnabled(): boolean {
  return includeSensitiveDiagnostics;
}

/**
 * Render an Error without losing its message.
 *
 * `stack` alone is not enough: WebKit — which is what Tauri embeds on macOS —
 * builds a stack out of frames only, so `error.stack` for `new Error('boom')` is
 * just `@app.js:1:2`. Logging that leaves a failure with a location and no
 * reason, which is exactly the case a warning exists to explain.
 */
function formatError(error: Error): string {
  const summary = `${error.name}: ${error.message}`;
  const stack = error.stack;
  if (!stack) return summary;
  return stack.includes(error.message) ? stack : `${summary}\n${stack}`;
}

function formatConsoleArg(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol') return value.toString();
  if (value instanceof Error) return formatError(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      try {
        return Object.prototype.toString.call(value);
      } catch {
        return '[Object]';
      }
    }
  }
  return String(value);
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map(formatConsoleArg).join(' ');
}

const CONSOLE_KIND_LEVEL: Record<string, LogLevel> = {
  trace: LogLevel.TRACE,
  debug: LogLevel.DEBUG,
  log: LogLevel.INFO,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

let consoleForwardMinLevel: LogLevel = isTauri && !isDev ? LogLevel.WARN : LogLevel.TRACE;

/**
 * Patch `console.*` so messages also go through `tauri_plugin_log` (webview target → webview.log).
 */
function installWebviewConsoleForward(): void {
  if (!isTauri || typeof window === 'undefined') return;
  const w = window as unknown as Record<string, boolean | undefined>;
  if (w[CONSOLE_FORWARD_INSTALLED]) return;

  const c = window.console;
  const orig = {
    log: c.log.bind(c),
    debug: c.debug.bind(c),
    info: c.info.bind(c),
    warn: c.warn.bind(c),
    error: c.error.bind(c),
    trace: c.trace.bind(c),
  };

  const forward = (
    kind: 'log' | 'debug' | 'info' | 'warn' | 'error' | 'trace',
    args: unknown[]
  ) => {
    if ((CONSOLE_KIND_LEVEL[kind] ?? LogLevel.INFO) < consoleForwardMinLevel) return;
    const msg = `[console] ${formatConsoleArgs(args)}`;
    switch (kind) {
      case 'log':
      case 'info':
        void tauriInfo(msg).catch(() => {});
        break;
      case 'debug':
        void tauriDebug(msg).catch(() => {});
        break;
      case 'trace':
        void tauriTrace(msg).catch(() => {});
        break;
      case 'warn':
        void tauriWarn(msg).catch(() => {});
        break;
      case 'error':
        void tauriError(msg).catch(() => {});
        break;
    }
  };

  c.log = (...args: unknown[]) => {
    forward('log', args);
    orig.log(...args);
  };
  c.info = (...args: unknown[]) => {
    forward('info', args);
    orig.info(...args);
  };
  c.debug = (...args: unknown[]) => {
    forward('debug', args);
    orig.debug(...args);
  };
  c.trace = (...args: unknown[]) => {
    forward('trace', args);
    orig.trace(...args);
  };
  c.warn = (...args: unknown[]) => {
    forward('warn', args);
    orig.warn(...args);
  };
  c.error = (...args: unknown[]) => {
    forward('error', args);
    orig.error(...args);
  };

  (window as unknown as Record<string, boolean | undefined>)[CONSOLE_FORWARD_INSTALLED] = true;
}

/**
 * Install console forwarding as early as possible so startup logs are persisted too.
 */
export function bootstrapLogger(): void {
  if (!isTauri) return;
  try {
    installWebviewConsoleForward();
  } catch (e) {
    console.warn('[Logger] Failed to install console forwarding:', e);
  }
}

// Logger initialization state
let initialized = false;
let initPromise: Promise<void> | null = null;

function logLevelFromString(value: unknown): LogLevel | null {
  if (typeof value !== 'string') {
    return null;
  }

  switch (value.trim().toLowerCase()) {
    case 'trace':
      return LogLevel.TRACE;
    case 'debug':
      return LogLevel.DEBUG;
    case 'info':
      return LogLevel.INFO;
    case 'warn':
      return LogLevel.WARN;
    case 'error':
      return LogLevel.ERROR;
    case 'off':
      return LogLevel.NONE;
    default:
      return null;
  }
}

function initialLogLevel(): LogLevel {
  const bootstrapLevel = logLevelFromString(globalThis.__OPENBITFUN_BOOTSTRAP_LOG_LEVEL__);
  if (bootstrapLevel !== null) {
    return bootstrapLevel;
  }

  return isDev ? LogLevel.DEBUG : LogLevel.WARN;
}

/**
 * Initialize logger state and ensure console forwarding is installed.
 */
export async function initLogger(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    bootstrapLogger();
    initialized = true;
  })();

  return initPromise;
}

/**
 * Format data for logging
 * Separates Error objects from data: JSON for regular data, stack trace appended separately
 */
function formatData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (data instanceof Error) {
    return formatError(data);
  }
  if (typeof data === 'object') {
    try {
      // Separate Error objects from regular data
      const regularData: Record<string, unknown> = {};
      const errors: string[] = [];

      for (const key of Object.keys(data as Record<string, unknown>)) {
        const value = (data as Record<string, unknown>)[key];
        if (value instanceof Error) {
          errors.push(formatError(value));
        } else {
          regularData[key] = value;
        }
      }

      const parts: string[] = [];
      if (Object.keys(regularData).length > 0) {
        parts.push(JSON.stringify(regularData));
      }
      if (errors.length > 0) {
        parts.push(errors.join('\n'));
      }

      return parts.join(', ');
    } catch {
      return String(data);
    }
  }
  return String(data);
}

export class Logger {
  private static instance: Logger;
  private currentLevel: LogLevel;

  private constructor() {
    this.currentLevel = initialLogLevel();
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public setLevel(level: LogLevel): void {
    this.currentLevel = level;
    if (level > consoleForwardMinLevel) {
      consoleForwardMinLevel = level;
    }
  }

  public getLevel(): LogLevel {
    return this.currentLevel;
  }

  public trace(message: string, context?: string, data?: any): void {
    this.log(LogLevel.TRACE, message, context, data);
  }

  public debug(message: string, context?: string, data?: any): void {
    this.log(LogLevel.DEBUG, message, context, data);
  }

  public info(message: string, context?: string, data?: any): void {
    this.log(LogLevel.INFO, message, context, data);
  }

  public warn(message: string, context?: string, data?: any): void {
    this.log(LogLevel.WARN, message, context, data);
  }

  public error(message: string, context?: string, data?: any): void {
    this.log(LogLevel.ERROR, message, context, data);
  }

  private log(level: LogLevel, message: string, context?: string, data?: any): void {
    if (level < this.currentLevel) {
      return;
    }

    const logEntry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      context,
      data,
    };

    this.output(logEntry);
  }

  private output(entry: LogEntry): void {
    const { level, message, context, data } = entry;
    const contextStr = context ? `[${context}] ` : '';
    const dataStr = formatData(data);
    const fullMessage = dataStr ? `${contextStr}${message} ${dataStr}` : `${contextStr}${message}`;

    if (isTauri) {
      this.outputTauri(level, fullMessage);
    } else {
      this.outputConsole(level, fullMessage, data);
    }
  }

  private outputTauri(level: LogLevel, message: string): void {
    // Fire and forget - don't await to avoid blocking
    switch (level) {
      case LogLevel.TRACE:
        tauriTrace(message).catch(() => {});
        break;
      case LogLevel.DEBUG:
        tauriDebug(message).catch(() => {});
        break;
      case LogLevel.INFO:
        tauriInfo(message).catch(() => {});
        break;
      case LogLevel.WARN:
        tauriWarn(message).catch(() => {});
        break;
      case LogLevel.ERROR:
        tauriError(message).catch(() => {});
        break;
    }
  }

  private outputConsole(level: LogLevel, message: string, data?: any): void {
    const args = data !== undefined ? [message, data] : [message];
    switch (level) {
      case LogLevel.TRACE:
      case LogLevel.DEBUG:
        console.debug(...args);
        break;
      case LogLevel.INFO:
        console.info(...args);
        break;
      case LogLevel.WARN:
        console.warn(...args);
        break;
      case LogLevel.ERROR:
        console.error(...args);
        break;
    }
  }

  public createContextLogger(context: string) {
    return {
      trace: (message: string, data?: any) => this.trace(message, context, data),
      debug: (message: string, data?: any) => this.debug(message, context, data),
      info: (message: string, data?: any) => this.info(message, context, data),
      warn: (message: string, data?: any) => this.warn(message, context, data),
      error: (message: string, data?: any) => this.error(message, context, data),
    };
  }
}

export const logger = Logger.getInstance();

export const createLogger = (context: string) => logger.createContextLogger(context);

export const log = {
  trace: (message: string, context?: string, data?: any) => logger.trace(message, context, data),
  debug: (message: string, context?: string, data?: any) => logger.debug(message, context, data),
  info: (message: string, context?: string, data?: any) => logger.info(message, context, data),
  warn: (message: string, context?: string, data?: any) => logger.warn(message, context, data),
  error: (message: string, context?: string, data?: any) => logger.error(message, context, data),
};
