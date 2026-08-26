/**
 * The quick start guide is a first-run thing. It has to appear once and then stay
 * closed, including across restarts, so this launches the app twice against the same
 * profile and checks both.
 *
 * Run: npx playwright test first-run-guide.spec.js
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const { getElectronLaunchOptions, cleanTestArtifacts, acceptTerms } = require('./test-utils');

async function guideIsOpen(window) {
  return window.evaluate(() => {
    const dialog = document.getElementById('quickstart-guide');
    return Boolean(dialog && dialog.open);
  });
}

test.describe('Quick start guide', () => {
  test.beforeAll(() => {
    cleanTestArtifacts();
  });

  test.afterAll(() => {
    cleanTestArtifacts();
  });

  test('appears on the first run and not on the next one', async () => {
    // First run: accept the terms, and the guide opens straight away.
    let app = await electron.launch(getElectronLaunchOptions());
    let window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await acceptTerms(window);

    await expect.poll(() => guideIsOpen(window), {
      timeout: 20000,
      message: 'the guide should open on a first run'
    }).toBe(true);

    // The welcome dialog it used to follow is gone for good.
    expect(await window.locator('#welcome-message').count()).toBe(0);
    expect(await window.locator('button:has-text("Get Started!")').count()).toBe(0);

    await window.evaluate(() => document.getElementById('quickstart-guide')?.close());
    await expect
      .poll(() => window.evaluate(() => window.electron.getSetting('hasSeenQuickStartGuide')), { timeout: 15000 })
      .toBeTruthy();
    await app.close();

    // Second run against the same profile: no welcome, and no guide.
    app = await electron.launch(getElectronLaunchOptions());
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(6000);

    expect(await guideIsOpen(window), 'the guide must not reopen on a later run').toBe(false);
    await app.close();
  });
});
