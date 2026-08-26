/**
 * STEP support: a CAD file should behave like any other model — a real rendered
 * thumbnail rather than a typed placeholder, and a working 3D preview.
 *
 * Run: npx playwright test step-support.spec.js
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const {
  getElectronLaunchOptions,
  cleanTestArtifacts,
  dismissOnboarding,
  acceptTerms,
  getSmallFixtureScanPath
} = require('./test-utils');

let app;
let window;
const scanPath = getSmallFixtureScanPath();

test.describe('STEP support', () => {
  test.beforeAll(async () => {
    cleanTestArtifacts();
    app = await electron.launch(getElectronLaunchOptions({ PRINTVENTORY_TEST_SCAN_PATH: scanPath }));
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await acceptTerms(window);
    await dismissOnboarding(window);

    // STEP is an opt-in scan type, exactly as a user would enable it.
    await window.evaluate(() => window.electron.saveSetting('scanAdditionalFileTypes', JSON.stringify(['step'])));
    await window.evaluate((dir) => window.electron.scanDirectory(dir, {}), scanPath);
    await window.waitForTimeout(2000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
    cleanTestArtifacts();
  });

  test('a STEP file is indexed and renders a real thumbnail', async () => {
    const indexed = await window.evaluate(async () => {
      const models = await window.electron.getAllModels();
      return models.map((m) => m.fileName);
    });
    expect(indexed).toContain('cube.step');

    await window.evaluate(async () => {
      const models = await window.electron.getAllModels();
      const step = models.filter((m) => /\.step$/i.test(m.fileName));
      await window.generateThumbnailsForModels(step, {});
    });

    await expect
      .poll(async () => window.evaluate(async () => {
        const models = await window.electron.getAllModels();
        const step = models.find((m) => /\.step$/i.test(m.fileName));
        if (!step) return { state: 'missing' };
        const full = await window.electron.getModel(step.filePath);
        const thumbnail = full && full.thumbnail;
        if (!thumbnail || !String(thumbnail).startsWith('data:image')) return { state: 'pending' };
        // A typed placeholder is just the word "STEP" drawn on a card; a render is not.
        const placeholder = window.generateTypedPlaceholder
          ? window.generateTypedPlaceholder('step')
          : null;
        return {
          state: thumbnail === placeholder ? 'placeholder' : 'rendered',
          length: thumbnail.length
        };
      }), { timeout: 120000, message: 'STEP thumbnail should be a real render' })
      .toMatchObject({ state: 'rendered' });
  });

  test('a STEP file opens in the 3D preview with its real dimensions', async () => {
    await window.evaluate(async () => {
      const models = await window.electron.getAllModels();
      const step = models.find((m) => /\.step$/i.test(m.fileName));
      await window.openPreview(step.filePath);
    });

    const dialog = window.locator('#preview-dialog');
    await expect(dialog).toBeVisible({ timeout: 60000 });
    await expect(window.locator('#preview-file-type')).toContainText('STEP', { timeout: 60000 });

    // The fixture is a 20 mm cube, so the reported size must reflect tessellated geometry.
    const dimensions = window.locator('#preview-dimensions');
    await expect(dimensions).toContainText('20', { timeout: 60000 });
  });
});
