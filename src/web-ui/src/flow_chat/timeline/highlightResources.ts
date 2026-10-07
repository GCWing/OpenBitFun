import { useEffect, useMemo, useState } from 'react';
import type { LineTokens } from '../components/inlineDiffTokens';
import { FlowChatResourceCache } from './resourceCache';
import { flowChatContentScheduler } from './contentScheduler';

const cache = new FlowChatResourceCache<string, LineTokens[]>(12 * 1024 * 1024, 96);
let worker: Worker | undefined;
let sequence = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, { content: string; language: string; resolve: (lines: LineTokens[]) => void; fallback: () => LineTokens[] }>();
let activeId: number | undefined;

function failWorker() {
  worker?.terminate(); worker = undefined; activeId = undefined;
  const requests = [...pending.values()];
  pending.clear();
  for (const request of requests) request.resolve(request.fallback());
  scheduleDisposal();
}

function pump() {
  if (activeId !== undefined || !worker) return;
  const next = pending.entries().next().value;
  if (!next) { scheduleDisposal(); return; }
  activeId = next[0];
  try {
    worker.postMessage({ id: next[0], content: next[1].content, language: next[1].language });
  } catch { failWorker(); }
}

function scheduleDisposal() {
  clearTimeout(idle);
  if (!pending.size) idle = setTimeout(() => { worker?.terminate(); worker = undefined; }, 30_000);
}
function tokenize(content: string, language: string, resolve: (lines: LineTokens[]) => void): () => void {
  clearTimeout(idle);
  const fallback = () => content.split('\n').map(line => [line]);
  if (typeof Worker === 'undefined') { resolve(fallback()); return () => {}; }
  const id = ++sequence;
  try {
    if (!worker) {
      worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ id: number; lines: LineTokens[] }>) => {
        if (activeId !== event.data.id) return;
        activeId = undefined;
        const request = pending.get(event.data.id);
        pending.delete(event.data.id);
        request?.resolve(event.data.lines);
        pump();
      };
      worker.onerror = failWorker;
    }
    pending.set(id, { content, language, resolve, fallback });
    pump();
  } catch { pending.delete(id); resolve(fallback()); scheduleDisposal(); }
  return () => {
    pending.delete(id);
    // Only one payload is posted at a time. Cancelled queued work never enters
    // the worker; cancel the active computation when no reader needs any work.
    if (!pending.size && activeId !== undefined) {
      worker?.terminate(); worker = undefined; activeId = undefined;
    }
    scheduleDisposal();
  };
}

/** Exact plain text is immediate. Highlighting never blocks a layout or a gesture. */
export function useHighlightedLines(content: string, language: string): LineTokens[] {
  const key = `${language}\u0000${content}`;
  const [result, setResult] = useState<{ key: string; lines: LineTokens[] }>();
  const cached = cache.get(key);
  useEffect(() => {
    if (cache.has(key)) return;
    let active = true;
    let cancelWorker: (() => void) | undefined;
    const cancelSchedule = flowChatContentScheduler.schedule(() => {
      cancelWorker = tokenize(content, language, lines => {
        if (!active) return;
        cache.set(key, lines, key.length * 2 + content.length * 8 + lines.length * 80);
        setResult({ key, lines });
      });
    });
    return () => { active = false; cancelSchedule(); cancelWorker?.(); };
  }, [content, language, key]);
  const plain = useMemo(() => content.split('\n').map(line => [line]), [content]);
  return cached ?? (result?.key === key ? result.lines : plain);
}
