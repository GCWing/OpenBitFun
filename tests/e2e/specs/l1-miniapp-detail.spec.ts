/**
 * L1 MiniApp details: installed-app cards open a native detail surface whose
 * capability facts and primary action stay connected to the real app runtime.
 */

import { expect } from '@wdio/globals';
import { saveStepScreenshot } from '../helpers/screenshot-utils';
import { MiniAppsPage } from '../page-objects';

const PPT_APP_ID = 'builtin-ppt-live';
const INTERACTIVE_APP_ID = 'builtin-gomoku';

describe('L1 MiniApp detail card', () => {
  const miniApps = new MiniAppsPage();

  beforeEach(async () => {
    await miniApps.ensureAppStopped(PPT_APP_ID);
    await miniApps.ensureAppStopped(INTERACTIVE_APP_ID);
    await miniApps.openGallery();
  });

  afterEach(async () => {
    await miniApps.ensureAppStopped(PPT_APP_ID);
    await miniApps.ensureAppStopped(INTERACTIVE_APP_ID);
  });

  it('presents the PPT app as a complete, capability-backed detail card', async () => {
    const detail = await miniApps.openDetails(PPT_APP_ID);
    const title = await detail.$('[data-testid="miniapp-detail-title"]');
    const source = await detail.$('[data-testid="miniapp-detail-source"]');
    const version = await detail.$('[data-testid="miniapp-detail-version"]');
    const primaryAction = await detail.$('[data-testid="miniapp-detail-primary-action"]');
    const deleteAction = await detail.$('[data-testid="miniapp-detail-delete"]');

    expect((await title.getText()).trim().length).toBeGreaterThan(0);
    expect((await source.getText()).trim().length).toBeGreaterThan(0);
    expect(await version.getText()).toMatch(/^v\d+/);
    expect(await miniApps.getDetailCapabilityKinds()).toEqual(['ai', 'storage', 'surface']);
    expect(await primaryAction.isDisplayed()).toBe(true);
    expect(await deleteAction.isDisplayed()).toBe(true);
    expect(await detail.getSize('width')).toBeGreaterThan(700);

    await saveStepScreenshot('l1-miniapp-detail-ppt');
    await miniApps.closeDetails();
  });

  it('starts the selected app from the detail card primary action', async () => {
    await miniApps.openDetails(INTERACTIVE_APP_ID);
    await miniApps.startFromDetails(INTERACTIVE_APP_ID);

    const overviewActivity = await miniApps.waitForOverviewActivity(INTERACTIVE_APP_ID);
    expect(await overviewActivity.isDisplayed()).toBe(true);
  });
});
