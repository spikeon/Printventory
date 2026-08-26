/**
 * Active file management, driven through the real UI.
 *
 * Builds an ingestion folder containing the three shapes the feature has to handle —
 * a project folder with companion files, a ZIP, and a loose model file — then opens
 * the Active File Management dialog, configures it, previews, ingests, and checks
 * what actually landed on disk.
 *
 * Run: npx playwright test active-file-management.spec.js
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getElectronLaunchOptions, cleanTestArtifacts, dismissOnboarding, acceptTerms } = require('./test-utils');

let app;
let window;
let workspace;
let inbox;
let library;

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

/** Minimal but real ZIP (stored entries) so no archive dependency is needed here. */
function writeStoredZip(zipPath, entries) {
  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    return table;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // relative offset of the local header
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, Buffer.concat([...locals, centralBuf, end]));
}

function listRecursive(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRecursive(full, base));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

function buildIngestFixtures() {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'printventory-afm-'));
  inbox = path.join(workspace, 'inbox');
  library = path.join(workspace, 'library');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(library, { recursive: true });

  // A project folder whose companion files must travel with the models.
  const project = path.join(inbox, 'Articulated Dragon by CinderWing3D');
  writeFile(path.join(project, 'parts', 'body.stl'), 'solid body\nendsolid body\n');
  writeFile(path.join(project, 'parts', 'tail.stl'), 'solid tail\nendsolid tail\n');
  writeFile(path.join(project, 'BOM.csv'), 'part,qty\nbody,1\ntail,1\n');
  writeFile(path.join(project, 'assembly-instructions.txt'), 'Step 1: print the body.\n');

  // A ZIP that wraps everything in a single folder and carries a metadata sidecar.
  writeStoredZip(path.join(inbox, 'hex-planter.zip'), {
    'Hex Planter Set/planter.stl': 'solid planter\nendsolid planter\n',
    'Hex Planter Set/instructions.txt': 'Glue the base.\n',
    'Hex Planter Set/metadata.json': JSON.stringify({
      name: 'Hex Planter',
      creator: { name: 'PlantyMcPlant' },
      license: 'CC BY-NC 4.0',
      url: 'https://example.com/planter'
    })
  });

  // A loose model file, and a file the feature must not touch.
  writeFile(path.join(inbox, 'Cool Vase by Potter.stl'), 'solid vase\nendsolid vase\n');
  writeFile(path.join(inbox, 'unrelated-notes.txt'), 'nothing to do with models\n');
}

async function openActiveFileManagementDialog() {
  // Same event the Settings > Active File Management menu item sends.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.send('open-active-file-management');
  });
  await expect(window.locator('#active-file-management-dialog')).toBeVisible();
}

test.describe('Active file management', () => {
  test.beforeAll(async () => {
    buildIngestFixtures();
    cleanTestArtifacts();
    app = await electron.launch(getElectronLaunchOptions({
      PRINTVENTORY_TEST_INGEST_PATH: inbox,
      PRINTVENTORY_TEST_LIBRARY_PATH: library
    }));
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await acceptTerms(window);
    await dismissOnboarding(window);
  });

  test.afterAll(async () => {
    if (app) await app.close();
    cleanTestArtifacts();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('configures, previews and files an inbox from the settings dialog', async () => {
    await openActiveFileManagementDialog();

    // Off by default: the options are greyed until the master switch is on.
    const enabled = window.locator('#afm-enabled');
    await expect(enabled).not.toBeChecked();
    await expect(window.locator('#afm-options')).toHaveClass(/grayed/);

    await enabled.check();
    await expect(window.locator('#afm-options')).not.toHaveClass(/grayed/);

    await window.locator('#afm-choose-ingest').click();
    await expect(window.locator('#afm-ingest-directory')).toHaveValue(inbox);
    await window.locator('#afm-choose-destination').click();
    await expect(window.locator('#afm-destination-root')).toHaveValue(library);

    // The pattern is a plain editable string; the dialog previews what it produces.
    const pattern = window.locator('#afm-pattern');
    await pattern.fill('/(%category%|Uncategorized)/(%author%|Unknown)/%name%/');
    // The sample model carries a tag, so %category% resolves; the bare sample shows the fallbacks.
    await expect(window.locator('#afm-pattern-preview')).toContainText('With metadata: Toys/CinderWing3D/Articulated Dragon');
    await expect(window.locator('#afm-pattern-preview')).toContainText('Without: Uncategorized/Unknown/Untitled Model');

    // Preview is a dry run: it reports destinations and moves nothing.
    await window.locator('#afm-preview').click();
    await expect(window.locator('#afm-status')).toContainText('Nothing has been moved', { timeout: 60000 });
    const previewRows = window.locator('.afm-results-table tbody tr');
    await expect(previewRows).toHaveCount(3);
    await expect(window.locator('.afm-results-table')).toContainText('Uncategorized/CinderWing3D/Articulated Dragon');
    await expect(window.locator('.afm-results-table')).toContainText('Uncategorized/PlantyMcPlant/Hex Planter');
    expect(fs.existsSync(path.join(inbox, 'Articulated Dragon by CinderWing3D'))).toBe(true);
    expect(listRecursive(library)).toHaveLength(0);

    // The real run.
    await window.locator('#afm-run').click();
    await expect(window.locator('#afm-status')).toContainText('Filed 3 project(s)', { timeout: 120000 });

    // The project folder moved whole: BOM and instructions came along.
    expect(listRecursive(path.join(library, 'Uncategorized', 'CinderWing3D', 'Articulated Dragon')).sort()).toEqual([
      'BOM.csv',
      'assembly-instructions.txt',
      'parts/body.stl',
      'parts/tail.stl'
    ]);

    // The ZIP was extracted, unwrapped and filed by its sidecar metadata.
    expect(listRecursive(path.join(library, 'Uncategorized', 'PlantyMcPlant', 'Hex Planter')).sort()).toEqual([
      'instructions.txt',
      'metadata.json',
      'planter.stl'
    ]);
    expect(fs.existsSync(path.join(inbox, 'hex-planter.zip'))).toBe(false);
    expect(fs.existsSync(path.join(inbox, '.printventory-ingest'))).toBe(false);

    // The loose file got its own project, named from "Model by Designer".
    expect(fs.existsSync(path.join(library, 'Uncategorized', 'Potter', 'Cool Vase', 'Cool Vase by Potter.stl'))).toBe(true);

    // Anything unrecognised was left alone.
    expect(fs.existsSync(path.join(inbox, 'unrelated-notes.txt'))).toBe(true);
  });

  test('an ingested project shows in the grid as one group', async () => {
    // Ingestion knows the folder it created is a project, so it bundles it. A folder
    // that merely happens to hold files is still listed file by file.
    // Indexing carries on in the background after the ingest run reports done.
    await expect
      .poll(async () => window.evaluate(async () => {
        const models = await window.electron.getAllModels();
        const dragon = models.filter((m) => String(m.filePath).includes('Articulated Dragon'));
        if (dragon.length < 2) return 'not indexed yet';
        const keys = new Set(dragon.map((m) => m.bundleKey || ''));
        if (keys.size !== 1 || keys.has('')) return 'not grouped yet';
        const rightFields = dragon.every((m) => m.bundleKind === 'folder' && m.bundleLabel === 'Articulated Dragon');
        return rightFields ? 'grouped' : 'wrong bundle fields';
      }), { timeout: 90000, message: 'the ingested project should share one folder bundle' })
      .toBe('grouped');

    await window.evaluate(async () => {
      const models = await window.electron.getAllModels();
      await window.displayModels(models);
    });

    const group = window.locator('.parent-model-group[data-group-kind="bundle"]', { hasText: 'Articulated Dragon' });
    await expect(group.first()).toBeVisible({ timeout: 30000 });
    await expect(group.first().locator('.parent-model-group-meta')).toContainText('folder');
  });

  test('a library filed before grouping existed is brought up to date on launch', async () => {
    // Simulate the older shape: files recorded as belonging to a project, but with no
    // project record and no bundle fields, which is what an existing library looks like.
    await window.evaluate(async () => {
      const models = await window.electron.getAllModels();
      const dragon = models.filter((m) => String(m.filePath).includes('Articulated Dragon'));
      for (const model of dragon) {
        await window.electron.saveModel({ ...model, bundleKey: null, bundleLabel: null, bundleKind: null });
      }
    });

    const backfilled = await window.evaluate(async () => window.electron.backfillProjects());
    expect(backfilled.grouped).toBeGreaterThan(0);

    const grouped = await window.evaluate(async () => {
      const models = await window.electron.getAllModels();
      const dragon = models.filter((m) => String(m.filePath).includes('Articulated Dragon'));
      return dragon.map((m) => m.bundleKind);
    });
    expect(grouped.length).toBeGreaterThan(1);
    for (const kind of grouped) expect(kind).toBe('folder');
  });

  test('rescanning the library does not dissolve a project group', async () => {
    // Bundles are derived only for ZIP members, so a rescan derives "nothing" for an
    // ordinary file. That must not be mistaken for "this file has no bundle".
    await window.evaluate(async (root) => window.electron.scanDirectory(root, {}), library);
    await window.waitForTimeout(1500);

    const kinds = await window.evaluate(async () => {
      const models = await window.electron.getAllModels();
      return models
        .filter((m) => String(m.filePath).includes('Articulated Dragon'))
        .map((m) => m.bundleKind);
    });
    expect(kinds.length).toBeGreaterThan(1);
    for (const kind of kinds) expect(kind).toBe('folder');
  });

  test('re-files a project when metadata that feeds the pattern changes', async () => {
    const before = path.join(library, 'Uncategorized', 'CinderWing3D', 'Articulated Dragon');
    expect(fs.existsSync(before)).toBe(true);

    // Edit the designer the way the details panel does, then let the debounce run.
    const changed = await window.evaluate(async () => {
      const models = await window.electron.getAllModels();
      const model = models.find((m) => String(m.filePath).includes('Articulated Dragon'));
      if (!model) return false;
      await window.electron.saveModel({ ...model, designer: 'Renamed Studio', tags: ['Dragons'] });
      return true;
    });
    expect(changed).toBe(true);

    const after = path.join(library, 'Dragons', 'Renamed Studio', 'Articulated Dragon');
    await expect
      .poll(() => (fs.existsSync(after) ? 'moved' : listRecursive(library).join(' | ')), {
        timeout: 60000,
        message: 'the project should be re-filed under the new designer and tag'
      })
      .toBe('moved');

    // The whole project moved again, and the folders it left behind were cleaned up.
    expect(listRecursive(after).sort()).toEqual([
      'BOM.csv',
      'assembly-instructions.txt',
      'parts/body.stl',
      'parts/tail.stl'
    ]);
    expect(fs.existsSync(before)).toBe(false);
    expect(fs.existsSync(path.join(library, 'Uncategorized', 'CinderWing3D'))).toBe(false);

    // Stored paths followed the move.
    const storedPath = await window.evaluate(async () => {
      const models = await window.electron.getAllModels();
      const model = models.find((m) => String(m.filePath).includes('Articulated Dragon'));
      return model ? model.filePath : null;
    });
    expect(String(storedPath).replace(/\\/g, '/')).toContain('Dragons/Renamed Studio/Articulated Dragon');
  });
});
