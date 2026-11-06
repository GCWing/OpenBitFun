import type { Terminal } from '@xterm/xterm';

interface TerminalSnapshot {
  terminalId?: string;
  sessionId?: string;
  cols: number;
  rows: number;
  bufferType: string;
  bufferLength: number;
  baseY: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  viewportLines: string[];
  tailLines: string[];
  rendererCanvases: number;
}

// Keep this optional diagnostic compatible with the frontend's ES2020 type
// target. Older hosts without weak references must not acquire strong roots.
interface DiagnosticReference<T> { deref(): T | undefined }
type WeakReferenceConstructor = new <T extends object>(value: T) => DiagnosticReference<T>;
const entries = new Set<{ container: DiagnosticReference<HTMLElement>; terminal: DiagnosticReference<Terminal> }>();

function snapshot(): TerminalSnapshot[] {
  const snapshots: TerminalSnapshot[] = [];
  for (const entry of entries) {
    const container = entry.container.deref();
    const terminal = entry.terminal.deref();
    if (!container?.isConnected || !terminal) { entries.delete(entry); continue; }
    const root = container.closest<HTMLElement>('[data-terminal-id]');
    const buffer = terminal.buffer.active;
    const lines = (start: number) => Array.from({ length: Math.min(terminal.rows, buffer.length - start) },
      (_, offset) => buffer.getLine(start + offset)?.translateToString(true) ?? '');
    snapshots.push({ terminalId: root?.dataset.terminalId, sessionId: root?.dataset.sessionId,
      cols: terminal.cols, rows: terminal.rows, bufferType: buffer.type, bufferLength: buffer.length,
      baseY: buffer.baseY, viewportY: buffer.viewportY, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
      viewportLines: lines(buffer.viewportY), tailLines: lines(Math.max(0, buffer.length - terminal.rows)),
      rendererCanvases: container.querySelectorAll('canvas').length });
  }
  return snapshots;
}

declare global {
  var __OPENBITFUN_TERMINAL_DIAGNOSTICS__: { snapshot: () => TerminalSnapshot[] } | undefined;
}

/** Explicit diagnostic reads only: no timers, parser hooks, writes or engine handles. */
export function attachTerminalDiagnostics(container: HTMLElement, terminal: Terminal): () => void {
  if (globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__ !== true) return () => {};
  const WeakReference = (globalThis as typeof globalThis & { WeakRef?: WeakReferenceConstructor }).WeakRef;
  if (!WeakReference) return () => {};
  globalThis.__OPENBITFUN_TERMINAL_DIAGNOSTICS__ ??= { snapshot };
  const entry = { container: new WeakReference(container), terminal: new WeakReference(terminal) };
  entries.add(entry);
  return () => { entries.delete(entry); };
}
