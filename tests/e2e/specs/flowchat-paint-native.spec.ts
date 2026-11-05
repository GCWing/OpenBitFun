import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { browser, expect } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';
import { FlowChatScrollPage } from '../page-objects/FlowChatScrollPage';

const evidence = process.env.OPENBITFUN_FLOWCHAT_SCROLL_EVIDENCE!;
const page = new FlowChatScrollPage();
const samples: unknown[] = [];

async function textGeometry() {
  return browser.execute(() => {
    const scroller = document.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    const bounds = scroller.getBoundingClientRect();
    const lines: Array<{ x: number; y: number; width: number; height: number; text: string }> = [];
    for (const paragraph of scroller.querySelectorAll('.flow-text-block p')) {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width < 28 || rect.height < 8 || rect.top < bounds.top + 20 || rect.bottom > bounds.bottom - 100) continue;
          lines.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, text: node.textContent });
          if (lines.length >= 32) break;
        }
        if (lines.length >= 32) break;
      }
      if (lines.length >= 32) break;
    }
    return { width: innerWidth, top: scroller.scrollTop, lines };
  });
}

// Native WKWebView snapshots, separate from frame benchmarks: image encoding
// and pixel analysis must not inflate the product's scroll timing measurements.
describe('FlowChat native text paint at rapid viewport boundary crossings', () => {
  before(async () => {
    expect(await openWorkspace(process.env.E2E_TEST_WORKSPACE!, { requireWorkspaceLabel: false })).toBe(true);
    await page.openSession('scroll-history-000');
    await page.settle();
  });
  after(() => writeFileSync(join(evidence, 'paint-result.json'), JSON.stringify(samples, null, 2)));
  it('paints readable glyphs immediately and retains the same pixels after settling', async () => {
    let checkedLines = 0, stablePairs = 0;
    for (let index = 0; index < 128; index++) {
      const delta = index < 64 ? -1800 : 1800;
      await page.wheel(delta, 1);
      const before = await textGeometry();
      const immediate = Buffer.from(await browser.takeScreenshot(), 'base64');
      const captured = await textGeometry();
      await page.settle();
      const settled = Buffer.from(await browser.takeScreenshot(), 'base64');
      const after = await textGeometry();
      writeFileSync(join(evidence, `paint-${index.toString().padStart(2, '0')}.png`), immediate);
      const stable = JSON.stringify(before) === JSON.stringify(captured) && JSON.stringify(captured) === JSON.stringify(after);
      if (!stable || !before.lines.length) { samples.push({ index, stable, lines: before.lines.length }); continue; }
      stablePairs++;
      const image = await sharp(immediate).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const reference = await sharp(settled).removeAlpha().raw().toBuffer();
      const scale = image.info.width / before.width;
      const counts = before.lines.map(line => {
        const colors = new Map<number, number>();
        const pixels: number[] = [];
        for (let y = Math.ceil(line.y * scale); y < Math.floor((line.y + line.height) * scale); y++) {
          for (let x = Math.ceil(line.x * scale); x < Math.floor((line.x + line.width) * scale); x++) {
            const offset = (y * image.info.width + x) * 3;
            pixels.push(offset);
            const color = (image.data[offset] >> 3) * 1024 + (image.data[offset + 1] >> 3) * 32 + (image.data[offset + 2] >> 3);
            colors.set(color, (colors.get(color) ?? 0) + 1);
          }
        }
        const background = [...colors].sort((a, b) => b[1] - a[1])[0][0];
        const rgb = [background >> 10, (background >> 5) & 31, background & 31].map(value => value * 8 + 4);
        const ink = pixels.filter(offset => rgb.some((value, channel) => Math.abs(image.data[offset + channel] - value) > 40)).length;
        const changed = pixels.filter(offset => [0, 1, 2].some(channel => Math.abs(image.data[offset + channel] - reference[offset + channel]) > 32)).length;
        return { inkRatio: ink / pixels.length, changedRatio: changed / pixels.length };
      });
      samples.push({ index, stable, lines: counts, top: before.top });
      checkedLines += counts.length;
      expect(counts.every(line => line.inkRatio > 0.005)).toBe(true);
      expect(counts.every(line => line.changedRatio < 0.05)).toBe(true);
    }
    expect(stablePairs).toBeGreaterThanOrEqual(20);
    expect(checkedLines).toBeGreaterThan(400);
  });
});
