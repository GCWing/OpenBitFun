/**
 * L1 MiniApp activity: an open Runner is user-visible activity even when the
 * MiniApp does not own a Node/Bun worker.
 */

import { expect } from '@wdio/globals';
import { saveStepScreenshot } from '../helpers/screenshot-utils';
import { MiniAppsPage } from '../page-objects';

const NODELESS_BUILTIN_APP_ID = 'builtin-gomoku';
const SECOND_NODELESS_BUILTIN_APP_ID = 'builtin-daily-divination';

describe('L1 MiniApp activity projection', () => {
  const miniApps = new MiniAppsPage();

  beforeEach(async () => {
    await miniApps.ensureAppStopped(NODELESS_BUILTIN_APP_ID);
    await miniApps.ensureAppStopped(SECOND_NODELESS_BUILTIN_APP_ID);
    await miniApps.openGallery();
  });

  afterEach(async () => {
    await miniApps.ensureAppStopped(NODELESS_BUILTIN_APP_ID);
    await miniApps.ensureAppStopped(SECOND_NODELESS_BUILTIN_APP_ID);
  });

  it('shows an open node-less MiniApp in the overview and Running zone', async () => {
    await miniApps.startApp(NODELESS_BUILTIN_APP_ID);

    const overviewActivity = await miniApps.waitForOverviewActivity(NODELESS_BUILTIN_APP_ID);
    expect(await overviewActivity.isDisplayed()).toBe(true);

    await miniApps.returnToGallery();
    const runningCard = await miniApps.waitForRunningCard(NODELESS_BUILTIN_APP_ID);
    expect(await runningCard.isDisplayed()).toBe(true);
    await saveStepScreenshot('l1-miniapp-node-less-activity');

    await miniApps.stopApp(NODELESS_BUILTIN_APP_ID);
    await miniApps.waitForStopped(NODELESS_BUILTIN_APP_ID);
  });

  it('keeps two open node-less MiniApps legible and projects them into the gallery', async () => {
    await miniApps.startApp(NODELESS_BUILTIN_APP_ID);
    await miniApps.returnToGallery();
    await miniApps.startApp(SECOND_NODELESS_BUILTIN_APP_ID);

    await miniApps.waitForOverviewActivity(NODELESS_BUILTIN_APP_ID);
    await miniApps.waitForOverviewActivity(SECOND_NODELESS_BUILTIN_APP_ID);
    expect((await miniApps.getOverviewActivityIds()).sort()).toEqual([
      NODELESS_BUILTIN_APP_ID,
      SECOND_NODELESS_BUILTIN_APP_ID,
    ].sort());

    const bounds = (await miniApps.getOverviewActivityHorizontalBounds()).sort((a, b) => a.x - b.x);
    expect(bounds).toHaveLength(2);
    expect(bounds[0].x + bounds[0].width).toBeLessThan(bounds[1].x);
    await saveStepScreenshot('l1-miniapp-two-overview-activities');

    await miniApps.returnToGallery();
    expect((await miniApps.getOverviewActivityIds()).sort()).toEqual([
      NODELESS_BUILTIN_APP_ID,
      SECOND_NODELESS_BUILTIN_APP_ID,
    ].sort());
    await miniApps.returnToGallery();
    expect((await miniApps.getRunningCardIds()).sort()).toEqual([
      NODELESS_BUILTIN_APP_ID,
      SECOND_NODELESS_BUILTIN_APP_ID,
    ].sort());
    await saveStepScreenshot('l1-miniapp-two-gallery-activities');
  });
});
