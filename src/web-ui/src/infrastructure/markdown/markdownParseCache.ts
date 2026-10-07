import type { Root } from 'mdast';
import type { Processor } from 'unified';
import { BoundedResourceCache } from '@/shared/utils/BoundedResourceCache';

const cache = new BoundedResourceCache<string, Root>(12 * 1024 * 1024, 64);
const jobs = new Map<string, number>();
let worker: Worker | undefined;
let current: string | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;

const cacheTree = (text: string, tree: Root) => cache.set(text, tree, text.length * 14 + 256);

/** Cache parser output, before product plugins mutate it. Sanitization still runs. */
export function remarkCachedParse(this: Processor) {
  const parse = this.parser;
  if (!parse) return;
  this.parser = (text, file) => {
    const tree = cache.get(text);
    if (tree) return structuredClone(tree);
    const parsed = parse(text, file);
    if (text.length >= 2000) cacheTree(text, structuredClone(parsed as Root));
    return parsed;
  };
}

function pump() {
  if (current !== undefined) return;
  clearTimeout(idle);
  const next = jobs.keys().next().value;
  if (!next) {
    idle = setTimeout(() => { worker?.terminate(); worker = undefined; }, 30_000);
    return;
  }
  if (!worker) {
    worker = new Worker(new URL('./markdownParse.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ tree?: Root }>) => {
      if (current !== undefined) {
        if (event.data.tree && jobs.has(current)) cacheTree(current, event.data.tree);
        jobs.delete(current); current = undefined;
      }
      pump();
    };
    worker.onerror = () => { worker?.terminate(); worker = undefined; current = undefined; jobs.clear(); };
  }
  current = next;
  worker.postMessage(next);
}

/** Optional, cancellable warmup of immutable text. No view waits for this queue. */
export function prewarmMarkdownParse(text: string): () => void {
  if (text.length < 2000 || text.length > 400_000 || cache.has(text) || typeof Worker === 'undefined') return () => {};
  if (!jobs.has(text) && jobs.size >= 16) return () => {};
  jobs.set(text, (jobs.get(text) ?? 0) + 1);
  try { pump(); } catch { jobs.clear(); current = undefined; worker?.terminate(); worker = undefined; }
  return () => {
    const count = jobs.get(text) ?? 0;
    if (count <= 1) jobs.delete(text); else jobs.set(text, count - 1);
    if (!jobs.size && current !== undefined) { worker?.terminate(); worker = undefined; current = undefined; }
  };
}
