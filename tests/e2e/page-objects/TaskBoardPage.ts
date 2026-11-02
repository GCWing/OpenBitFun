import { $, $$, browser } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';
import { BasePage } from './BasePage';

export interface TaskBoardLayoutMetrics {
  rootWidth: number;
  rootScrollOverflow: number;
  contentWidth: number;
  contentCenterDelta: number;
  headerHeight: number;
  newButtonHeight: number;
  todayButtonHeight: number;
  navigationButtonHeight: number;
  listWidthRatio: number;
  panesTopDelta: number;
  calendarAfterListGap: number;
  moduleWidthDelta: number;
  nestedScrollAreas: number;
  calendarCellAspectRatio: number;
  overviewBeforeList: boolean;
  calendarInsideContent: boolean;
  weekdayColumns: number;
  calendarCells: number;
}

export interface TaskBoardDayDetailMetrics {
  detailTopDelta: number;
  detailBottomDelta: number;
  detailScrollOverflow: number;
  emptyStateFullyVisible: boolean;
}

export class TaskBoardPage extends BasePage {
  async open(): Promise<void> {
    const workspaceReady = await openWorkspace(undefined, { requireWorkspaceLabel: false });
    if (!workspaceReady) throw new Error('Task Board E2E could not open its isolated workspace');

    const entry = await this.waitForTestId('nav-todos-btn', 15_000);
    await entry.waitForClickable({ timeout: 10_000 });
    await entry.click();
    await this.waitForTestId('todos-scene', 15_000);
    await this.waitForTestId('todos-overview', 10_000);
    await this.waitForTestId('todos-calendar', 10_000);
  }

  async ensureLightAppearance(): Promise<void> {
    const isLight = await browser.execute(() => (
      document.documentElement.getAttribute('data-openbitfun-appearance') === 'openbitfun-light'
    ));
    if (isLight) return;

    await this.clickByTestId('nav-footer-settings-item', 10_000);
    await this.clickByTestId('nav-settings-theme-item', 10_000);
    await this.clickByTestId('appearance-palette-select', 10_000);
    const lightOption = await $('[data-testid="appearance-palette-option"][data-appearance-id="openbitfun-light"]');
    await lightOption.waitForClickable({ timeout: 10_000 });
    await lightOption.click();

    await browser.waitUntil(async () => browser.execute(() => (
      document.documentElement.getAttribute('data-openbitfun-appearance') === 'openbitfun-light'
    )), {
      timeout: 10_000,
      timeoutMsg: 'Task Board E2E could not switch the native app to the light Appearance',
    });

    await this.open();
  }

  async createHourlyTask(name: string, prompt: string): Promise<WebdriverIO.Element> {
    await this.clickByTestId('todos-new', 10_000);
    await this.waitForTestId('todos-editor', 10_000);
    await this.typeByTestId('todos-editor-name', name, 10_000);
    await this.typeByTestId('todos-editor-prompt', prompt, 10_000);

    const schedule = await this.waitForTestId('todos-editor-schedule-kind', 10_000);
    const trigger = await schedule.$('[role="combobox"]');
    await trigger.click();
    const options = await $$('[role="listbox"] [role="option"]');
    if (await options.length < 2) {
      throw new Error('Task Board schedule selector did not expose Interval');
    }
    await options[1].click();

    await this.clickByTestId('todos-editor-save', 10_000);
    return this.waitForTask(name, 15_000);
  }

  async waitForTask(name: string, timeout = 10_000): Promise<WebdriverIO.Element> {
    let matchingRow: WebdriverIO.Element | null = null;
    await browser.waitUntil(async () => {
      const rows = await $$('[data-testid="todos-row"]');
      for (const row of rows) {
        if ((await row.getText()).includes(name)) {
          matchingRow = row;
          return true;
        }
      }
      return false;
    }, {
      timeout,
      interval: 200,
      timeoutMsg: `Task Board did not render scheduled task: ${name}`,
    });
    if (!matchingRow) throw new Error(`Task Board row disappeared: ${name}`);
    return matchingRow;
  }

  async deleteTask(name: string): Promise<void> {
    const row = await this.waitForTask(name, 5_000);
    await this.deleteTaskRow(row);

    await browser.waitUntil(async () => {
      const rows = await $$('[data-testid="todos-row"]');
      for (const candidate of rows) {
        if ((await candidate.getText()).includes(name)) return false;
      }
      return true;
    }, {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: `Task Board did not delete scheduled task: ${name}`,
    });
  }

  async deleteTasksByPrefix(prefix: string): Promise<void> {
    for (let deleted = 0; deleted < 20; deleted += 1) {
      const rows = await $$('[data-testid="todos-row"]');
      let matchingRow: WebdriverIO.Element | null = null;
      for (const row of rows) {
        if ((await row.getText()).includes(prefix)) {
          matchingRow = row;
          break;
        }
      }
      if (!matchingRow) return;

      const previousCount = rows.length;
      await this.deleteTaskRow(matchingRow);
      await browser.waitUntil(async () => (
        await $$('[data-testid="todos-row"]')
      ).length < previousCount, {
        timeout: 10_000,
        interval: 200,
        timeoutMsg: `Task Board did not remove stale E2E task matching: ${prefix}`,
      });
    }

    throw new Error(`Task Board retained more than 20 stale E2E tasks matching: ${prefix}`);
  }

  async selectEmptyDay(): Promise<TaskBoardDayDetailMetrics> {
    const cells = await $$('[data-testid="todos-calendar-cell"]');
    let emptyCell: WebdriverIO.Element | null = null;
    for (const cell of cells) {
      const className = await cell.getAttribute('class');
      if (!className.includes('openbitfun-todos__calendar-cell--has-items')) {
        emptyCell = cell;
        break;
      }
    }
    if (!emptyCell) throw new Error('Task Board calendar did not expose an empty day');

    await emptyCell.click();
    const emptyState = await this.waitForTestId('todos-day-empty', 10_000);
    await emptyState.waitForDisplayed({ timeout: 10_000 });
    await emptyState.scrollIntoView({ block: 'end' });

    let metrics: TaskBoardDayDetailMetrics | null = null;
    await browser.waitUntil(async () => {
      metrics = await this.getDayDetailMetrics();
      return metrics?.emptyStateFullyVisible === true;
    }, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'Task Board did not reveal the complete empty-day detail',
    });

    if (!metrics) throw new Error('Task Board did not return empty-day detail metrics');
    return metrics;
  }

  async clearSelectedDay(): Promise<void> {
    await this.clickByTestId('todos-day-clear', 10_000);
    await browser.waitUntil(async () => !await $('[data-testid="todos-day-detail"]').isExisting(), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'Task Board did not close the selected-day detail',
    });
  }

  private async deleteTaskRow(row: WebdriverIO.Element): Promise<void> {
    const deleteButton = await row.$('.openbitfun-todos__row-action-buttons button:last-child');
    await deleteButton.click();

    const confirm = await $('[data-openbitfun-component="confirm-dialog"][data-openbitfun-part="actions"] button:last-child');
    await confirm.waitForClickable({ timeout: 10_000 });
    await confirm.click();
  }

  async getLayoutMetrics(): Promise<TaskBoardLayoutMetrics | null> {
    return browser.execute(() => {
      const root = document.querySelector<HTMLElement>('[data-testid="todos-scene"]');
      const content = document.querySelector<HTMLElement>('[data-testid="todos-content"]');
      const header = document.querySelector<HTMLElement>('.openbitfun-todos__head');
      const panes = document.querySelector<HTMLElement>('[data-openbitfun-part="panes"]');
      const list = document.querySelector<HTMLElement>('[data-testid="todos-list-pane"]');
      const overview = document.querySelector<HTMLElement>('[data-testid="todos-overview"]');
      const calendar = document.querySelector<HTMLElement>('[data-testid="todos-calendar"]');
      const newButton = document.querySelector<HTMLElement>('[data-testid="todos-new"]');
      const todayButton = document.querySelector<HTMLElement>('.openbitfun-todos__today-button');
      const navigationButton = document.querySelector<HTMLElement>('[data-testid="todos-calendar-prev"]');
      const weekdays = Array.from(document.querySelectorAll<HTMLElement>('.openbitfun-todos__calendar-weekday'));
      const cells = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="todos-calendar-cell"]'));
      if (
        !root || !content || !header || !panes || !list || !overview || !calendar
        || !newButton || !todayButton || !navigationButton
      ) return null;

      const rootRect = root.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const panesRect = panes.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const overviewRect = overview.getBoundingClientRect();
      const calendarRect = calendar.getBoundingClientRect();
      const weekdayColumns = new Set(weekdays.map(day => Math.round(day.getBoundingClientRect().left))).size;
      const firstCellRect = cells[0]?.getBoundingClientRect();

      return {
        rootWidth: rootRect.width,
        rootScrollOverflow: root.scrollWidth - root.clientWidth,
        contentWidth: contentRect.width,
        contentCenterDelta: Math.abs((contentRect.left + contentRect.right - rootRect.left - rootRect.right) / 2),
        headerHeight: headerRect.height,
        newButtonHeight: newButton.getBoundingClientRect().height,
        todayButtonHeight: todayButton.getBoundingClientRect().height,
        navigationButtonHeight: navigationButton.getBoundingClientRect().height,
        listWidthRatio: listRect.width / panesRect.width,
        panesTopDelta: Math.abs(panesRect.top - headerRect.bottom),
        calendarAfterListGap: calendarRect.top - listRect.bottom,
        moduleWidthDelta: Math.abs(calendarRect.width - listRect.width),
        nestedScrollAreas: content.querySelectorAll('[data-openbitfun-component="scroll-area"]').length,
        calendarCellAspectRatio: firstCellRect
          ? firstCellRect.width / firstCellRect.height
          : 0,
        overviewBeforeList: overviewRect.bottom <= listRect.top
          && !list.contains(overview),
        calendarInsideContent: calendarRect.left >= contentRect.left
          && calendarRect.right <= contentRect.right
          && calendarRect.bottom <= contentRect.bottom + 1,
        weekdayColumns,
        calendarCells: cells.length,
      };
    });
  }

  async getDayDetailMetrics(): Promise<TaskBoardDayDetailMetrics | null> {
    return browser.execute(() => {
      const root = document.querySelector<HTMLElement>('[data-testid="todos-scene"]');
      const pane = document.querySelector<HTMLElement>('[data-testid="todos-calendar-pane"]');
      const detail = document.querySelector<HTMLElement>('[data-testid="todos-day-detail"]');
      const emptyState = document.querySelector<HTMLElement>('[data-testid="todos-day-empty"]');
      if (!root || !pane || !detail || !emptyState) return null;

      const rootRect = root.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      const detailRect = detail.getBoundingClientRect();
      const emptyRect = emptyState.getBoundingClientRect();
      return {
        detailTopDelta: detailRect.top - paneRect.top,
        detailBottomDelta: paneRect.bottom - detailRect.bottom,
        detailScrollOverflow: detail.scrollHeight - detail.clientHeight,
        emptyStateFullyVisible: emptyRect.top >= paneRect.top - 1
          && emptyRect.bottom <= paneRect.bottom + 1
          && emptyRect.top >= rootRect.top - 1
          && emptyRect.bottom <= rootRect.bottom + 1,
      };
    });
  }
}

export default TaskBoardPage;
