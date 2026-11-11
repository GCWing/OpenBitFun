// @vitest-environment jsdom
import { browserFixtureFlags, cleanupBrowserFixture } from './browser-fixture.test-support';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { compile } from 'sass';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import type { CronJob } from '@/infrastructure/api';
import TodoCalendar from '@/app/scenes/todos/components/TodoCalendar';

const browser = process.env.OPENBITFUN_TEST_BROWSER ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium',
].find(existsSync);
const nowMs = new Date(2026, 10, 8, 12).getTime();
const job: CronJob = {
  id: 'calendar-paint', name: 'Hourly calendar fixture', enabled: true,
  schedule: { kind: 'every', everyMs: 3600000 }, payload: { text: 'Fixture only' },
  target: { kind: 'workspace', workspace: { workspacePath: '/fixture' }, launch: { agentType: 'Standard' } },
  createdAtMs: nowMs, configUpdatedAtMs: nowMs, updatedAtMs: nowMs,
  state: { consecutiveFailures: 0, coalescedRunCount: 0 },
};

it.skipIf(!browser).each([
  { mode: 'light', width: 700 }, { mode: 'dark', width: 700 },
  { mode: 'light', width: 360 }, { mode: 'dark', width: 360 },
])('leaves room around calendar cells and focus rings without changing geometry in $mode at $width px', async ({ mode, width }) => {
  const scratch = mkdtempSync(resolve(tmpdir(), 'skin-calendar-'));
  try {
    const markup = renderToStaticMarkup(<TodoCalendar
      occurrences={Array.from({ length: 8 }, (_, index) => ({ job, atMs: nowMs + index * 3600000 }))}
      monthAnchorMs={nowMs} nowMs={nowMs} selectedDayKey="2026-11-08"
      onSelectDay={() => {}} onShiftMonth={() => {}} onToday={() => {}}
    />);
    const ownerCss = compile(resolve('src/app/scenes/todos/TodosScene.scss'), {
      importers: [{ findFileUrl: url => url.startsWith('@/') ? pathToFileURL(resolve('src', url.slice(2))) : null }],
    }).css;
    const skinCss = compile(resolve('src/app/styles/visual-skin.scss')).css;
    const panel = mode === 'light' ? '#fcfcfc' : '#242424';
    const html = resolve(scratch, 'calendar.html');
    const screenshot = resolve(scratch, 'calendar.png');
    writeFileSync(html, `<!doctype html><html><style>
      :root{--openbitfun-space-1:4px;--openbitfun-space-2:8px;--openbitfun-space-3:12px;--openbitfun-space-4:16px;--openbitfun-space-5:20px;--openbitfun-layout-field-group-radius:16px;--openbitfun-radius-base:8px;--openbitfun-color-surface-panel:${panel};--openbitfun-color-content-primary:${mode === 'light' ? '#222' : '#eee'}}
      body{margin:40px;background:#c82850}.frame{width:${width}px;padding-inline:12px;container:todos-scene/inline-size}button{font:14px sans-serif}svg{width:14px;height:14px}
      ${ownerCss}${skinCss}
      </style><main class="frame">${markup}</main><pre id="result"></pre><script>
      const calendar=document.querySelector('[data-testid="todos-calendar"]');
      const body=calendar.querySelector('.openbitfun-todos__calendar-body');
      const weekdays=calendar.querySelector('.openbitfun-todos__calendar-weekdays');
      const grid=calendar.querySelector('[role="grid"]');
      const targets=[calendar.querySelector('header'),weekdays,grid,...grid.children];
      const measure=()=>targets.map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return[r.x,r.y,r.width,r.height,s.padding,s.borderRadius,s.fontSize,s.lineHeight]});
      const wrapped=measure();
      // Reconstruct the original sibling layout as the geometry oracle.
      body.replaceWith(weekdays,grid);const original=measure();
      calendar.append(body);body.append(weekdays,grid);
      document.documentElement.dataset.openbitfunSkinId='calendar';
      const skinned=measure(),plane=getComputedStyle(body,'::before');
      const parts=[calendar.querySelector('header'),calendar.querySelector('.openbitfun-todos__calendar-actions'),weekdays,grid];
      const plates=parts.map(e=>({fill:getComputedStyle(e).backgroundColor,content:getComputedStyle(e,'::before').content}));
      const b=body.getBoundingClientRect(),w=weekdays.getBoundingClientRect(),g=grid.getBoundingClientRect(),cell=grid.children[0].getBoundingClientRect();
      const frame=document.querySelector('.frame').getBoundingClientRect();
      const result={original,wrapped,skinned,plates,plane:{left:plane.left,right:plane.right,background:plane.backgroundColor},fitsGutter:b.left+parseFloat(plane.left)>=frame.left&&b.right-parseFloat(plane.right)<=frame.right,
        samples:[[b.x+b.width/2,w.bottom+6],[cell.right+4,g.y+20],[b.left-6,g.y+20],[b.right+6,g.y+20]],
        chips:calendar.querySelectorAll('.openbitfun-todos__calendar-chip').length,
        more:calendar.querySelectorAll('.openbitfun-todos__calendar-more').length,
        selected:calendar.querySelector('[data-day-key="2026-11-08"]').getAttribute('aria-pressed')};
      document.getElementById('result').textContent=JSON.stringify(result);
      </script></html>`);
    const output = execFileSync(browser!, [
      ...browserFixtureFlags(), '--headless=new', '--disable-gpu', '--no-first-run', '--force-device-scale-factor=1',
      '--window-size=1000,1100', '--virtual-time-budget=200',
      `--user-data-dir=${resolve(scratch, 'profile')}`, `--screenshot=${screenshot}`,
      '--dump-dom', pathToFileURL(html).href,
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: 'pipe' });
    const result = JSON.parse(output.match(/<pre id="result">(.*?)<\/pre>/s)![1]);
    expect(result.wrapped).toEqual(result.original);
    expect(result.skinned).toEqual(result.original);
    expect(result.plane.left).toBe('-12px');
    expect(result.plane.right).toBe('-12px');
    expect(result.fitsGutter).toBe(true);
    expect(result.plane.background).toBe(mode === 'light' ? 'rgb(252, 252, 252)' : 'rgb(36, 36, 36)');
    for (const plate of result.plates) {
      expect(plate.fill).toBe('rgba(0, 0, 0, 0)');
      expect(['none', 'normal']).toContain(plate.content);
    }
    expect(result.chips).toBe(3);
    expect(result.more).toBe(1);
    expect(result.selected).toBe('true');
    const { data, info } = await sharp(readFileSync(screenshot)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const [x, y] of result.samples) {
      const offset = (Math.floor(y) * info.width + Math.floor(x)) * info.channels;
      expect([...data.subarray(offset, offset + 3)]).toEqual(mode === 'light' ? [252, 252, 252] : [36, 36, 36]);
    }
  } finally {
    await cleanupBrowserFixture(scratch);
  }
}, 30000);
