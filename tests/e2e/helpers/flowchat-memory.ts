import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { browser } from '@wdio/globals';

/** Read-only process samples. RSS includes shared pages; it is not private heap. */
export async function captureFlowChatMemory() {
  const renderer = await browser.execute(() => {
    const memory = (performance as Performance & { memory?: {
      usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number;
    } }).memory;
    return {
      usedJSHeapMiB: memory ? memory.usedJSHeapSize / 1048576 : null,
      allocatedJSHeapMiB: memory ? memory.totalJSHeapSize / 1048576 : null,
      domNodes: document.getElementsByTagName('*').length,
      mountedRows: document.querySelectorAll('[data-flowchat-scroller] .virtual-item-wrapper').length,
    };
  });
  const executable = process.env.OPENBITFUN_SCROLL_APP_PATH;
  if (!executable || !['darwin', 'linux'].includes(process.platform)) return { renderer, native: null };
  const lines = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8', windowsHide: true });
  const processes = lines.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rssKiB: Number(match[3]), path: match[4] }] : [];
  });
  const owned = new Set(processes.filter(item => item.path === executable).map(item => item.pid));
  let previousSize = -1;
  while (previousSize !== owned.size) {
    previousSize = owned.size;
    for (const item of processes) if (owned.has(item.parent)) owned.add(item.pid);
  }
  const samples = processes.filter(item => owned.has(item.pid)).map(item => ({
    role: basename(item.path), rssMiB: item.rssKiB / 1024,
  }));
  return { renderer, native: samples.length ? {
    sumRssMiB: samples.reduce((sum, item) => sum + item.rssMiB, 0), processes: samples,
  } : null };
}
