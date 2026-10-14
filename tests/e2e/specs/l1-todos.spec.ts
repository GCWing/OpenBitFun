/**
 * Native Desktop validation for the Task Board redesign.
 *
 * The task is created and deleted through the real UI and scheduler service;
 * no mocked task data or browser-only preview is used for visual evidence.
 */

import { $, browser, expect } from '@wdio/globals';
import { saveStepScreenshot } from '../helpers/screenshot-utils';
import { TaskBoardPage } from '../page-objects/TaskBoardPage';

describe('L1 Task Board', () => {
  const taskBoard = new TaskBoardPage();
  const taskName = `Task Board E2E ${Date.now()}`;
  let taskCreated = false;

  before(async () => {
    await taskBoard.open();
    await taskBoard.ensureLightAppearance();
    await taskBoard.deleteTasksByPrefix('Task Board E2E ');
  });

  after(async () => {
    if (!taskCreated) return;
    const scene = await $('[data-testid="todos-scene"]');
    if (!await scene.isExisting()) await taskBoard.open();
    await taskBoard.deleteTask(taskName);
  });

  it('keeps a centered single-column layout while running a real scheduled-task flow', async () => {
    expect(await $('[data-testid="todos-overview"]').isDisplayed()).toBe(true);
    expect(await $('[data-testid="todos-calendar-month"]').isDisplayed()).toBe(true);
    expect(await $('[data-testid="todos-new"]').isDisplayed()).toBe(true);
    expect(await $('[data-testid="todos-refresh"]').isExisting()).toBe(false);
    expect(await $('.openbitfun-todos__guide').isExisting()).toBe(false);

    const layout = await taskBoard.getLayoutMetrics();
    expect(layout).not.toBeNull();
    expect(layout?.rootWidth).toBeGreaterThan(1_000);
    expect(layout?.rootScrollOverflow).toBeLessThanOrEqual(1);
    expect(layout?.contentWidth).toBeCloseTo(680, 0);
    expect(layout?.contentCenterDelta).toBeLessThanOrEqual(1);
    expect(layout?.headerHeight).toBeGreaterThanOrEqual(96);
    expect(layout?.newButtonHeight).toBe(32);
    expect(layout?.todayButtonHeight).toBe(32);
    expect(layout?.navigationButtonHeight).toBe(24);
    expect(layout?.listWidthRatio).toBeCloseTo(1, 2);
    expect(layout?.panesTopDelta).toBeLessThanOrEqual(1);
    expect(layout?.calendarAfterListGap).toBeCloseTo(48, 0);
    expect(layout?.moduleWidthDelta).toBeLessThanOrEqual(1);
    expect(layout?.nestedScrollAreas).toBe(0);
    expect(layout?.calendarCellAspectRatio).toBeGreaterThanOrEqual(1);
    expect(layout?.calendarCellAspectRatio).toBeLessThanOrEqual(1.12);
    expect(layout?.overviewBeforeList).toBe(true);
    expect(layout?.calendarInsideContent).toBe(true);
    expect(layout?.weekdayColumns).toBe(7);
    expect(layout?.calendarCells).toBe(42);

    const emptyDayDetail = await taskBoard.selectEmptyDay();
    expect(emptyDayDetail.detailTopDelta).toBeGreaterThanOrEqual(-1);
    expect(emptyDayDetail.detailBottomDelta).toBeGreaterThanOrEqual(-1);
    expect(emptyDayDetail.detailScrollOverflow).toBeLessThanOrEqual(1);
    expect(emptyDayDetail.emptyStateFullyVisible).toBe(true);
    await saveStepScreenshot('l1-task-board-empty-day-detail');
    await taskBoard.clearSelectedDay();

    const row = await taskBoard.createHourlyTask(
      taskName,
      'Review the active workspace and summarize the next priorities.',
    );
    taskCreated = true;
    expect(await row.isDisplayed()).toBe(true);
    expect(await row.getSize('height')).toBeLessThanOrEqual(84);
    expect(await row.$('.openbitfun-todos__row-icon').isDisplayed()).toBe(true);
    expect((await row.getText()).toLowerCase()).toMatch(/hour|小时|小時/);

    const currentMonth = await $('[data-testid="todos-calendar-month"]').getText();
    await $('[data-testid="todos-calendar-next"]').click();
    await browser.waitUntil(async () => (
      await $('[data-testid="todos-calendar-month"]').getText()
    ) !== currentMonth, {
      timeout: 5_000,
      timeoutMsg: 'Task Board did not move to the next month',
    });
    await $('.openbitfun-todos__today-button').click();
    await browser.waitUntil(async () => (
      await $('[data-testid="todos-calendar-month"]').getText()
    ) === currentMonth, {
      timeout: 5_000,
      timeoutMsg: 'Task Board did not return to the current month',
    });

    await saveStepScreenshot('l1-task-board-reference-layout');

    const browserLogs = await browser.getLogs('browser') as Array<{ level: string; message: string }>;
    const severeLogs = browserLogs
      .filter(entry => entry.level === 'SEVERE')
      // The native test reuses Vite's already-running HTTP server; its optional
      // HMR websocket is not part of the packaged Desktop runtime.
      .filter(entry => !entry.message.includes('[vite] failed to connect to websocket'));
    expect(severeLogs.map(entry => entry.message)).toEqual([]);
  });
});
