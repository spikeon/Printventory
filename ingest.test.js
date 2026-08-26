#!/usr/bin/env node
'use strict';

/**
 * Plain-Node tests for the active file management ingestion engine.
 * Run with: npm run test:ingest
 */

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const {
  sanitizeSegment,
  cleanProjectName,
  parseNameForMetadata,
  metadataFromSidecarJson,
  firstUrlInText,
  renderPattern,
  resolveDestination,
  planIngestJobs,
  isInside,
  runIngest,
} = require('./ingest');

const pending = [];
function test(name, fn) {
  pending.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of pending) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}:`, err.message);
      process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('sanitizeSegment strips illegal characters but keeps hyphens', () => {
  assert.strictEqual(sanitizeSegment('T-Rex Skull'), 'T-Rex Skull');
  assert.strictEqual(sanitizeSegment('a/b\\c:d*e?f'), 'a b c d e f');
  assert.strictEqual(sanitizeSegment('trailing dots...'), 'trailing dots');
  assert.strictEqual(sanitizeSegment(''), 'Unknown');
  assert.strictEqual(sanitizeSegment('   '), 'Unknown');
});

test('sanitizeSegment escapes Windows device names', () => {
  assert.strictEqual(sanitizeSegment('CON'), 'CON_');
  assert.strictEqual(sanitizeSegment('lpt1'), 'lpt1_');
});

test('cleanProjectName removes extensions and download noise', () => {
  assert.strictEqual(cleanProjectName('articulated_dragon.zip'), 'articulated dragon');
  assert.strictEqual(cleanProjectName('Cool Bracket (2)'), 'Cool Bracket');
  assert.strictEqual(cleanProjectName('Widget - files'), 'Widget');
});

test('parseNameForMetadata reads "model by designer" and nothing riskier', () => {
  const parsed = parseNameForMetadata('Articulated Dragon by CinderWing3D');
  assert.strictEqual(parsed.designer, 'CinderWing3D');
  assert.strictEqual(parsed.model, 'Articulated Dragon');

  // "Designer - Model" is ambiguous, so no designer is guessed.
  const dashed = parseNameForMetadata('CinderWing3D - Dragon');
  assert.strictEqual(dashed.designer, null);
});

test('metadataFromSidecarJson maps common downloader shapes', () => {
  const flat = metadataFromSidecarJson({ name: 'Dragon', creator: 'Someone', license: 'CC-BY', url: 'https://example.com/x' });
  assert.strictEqual(flat.model, 'Dragon');
  assert.strictEqual(flat.designer, 'Someone');
  assert.strictEqual(flat.license, 'CC-BY');
  assert.strictEqual(flat.source, 'https://example.com/x');

  const nested = metadataFromSidecarJson({ title: 'Bracket', creator: { name: 'Studio' } });
  assert.strictEqual(nested.designer, 'Studio');
  assert.strictEqual(nested.model, 'Bracket');

  assert.deepStrictEqual(metadataFromSidecarJson(null), {});
});

test('firstUrlInText finds the source link in a readme', () => {
  assert.strictEqual(
    firstUrlInText('Downloaded from https://example.com/thing:123 - enjoy'),
    'https://example.com/thing:123'
  );
  assert.strictEqual(firstUrlInText('no links here'), null);
});

test('renderPattern drops empty levels instead of creating blank folders', () => {
  assert.deepStrictEqual(renderPattern('/%author%/%name%/', { designer: 'Bob', model: 'Dragon' }), ['Bob', 'Dragon']);
  assert.deepStrictEqual(renderPattern('/%author%/%name%/', { designer: '', model: 'Dragon' }), ['Dragon']);
  assert.deepStrictEqual(renderPattern('/%license%/%author%/%name%/', { model: 'Dragon' }), ['Dragon']);
});

test('renderPattern alternation picks the first non-empty option', () => {
  const pattern = '/(%category%|Uncategorized)/(%author%|Unknown)/%name%/';
  assert.deepStrictEqual(
    renderPattern(pattern, { category: 'Toys', designer: 'Bob', model: 'Dragon' }),
    ['Toys', 'Bob', 'Dragon']
  );
  assert.deepStrictEqual(
    renderPattern(pattern, { category: '', designer: '', model: 'Dragon' }),
    ['Uncategorized', 'Unknown', 'Dragon']
  );
});

test('renderPattern mixes literals and tokens inside one level', () => {
  assert.deepStrictEqual(renderPattern('%author% - %name%', { designer: 'Bob', model: 'Dragon' }), ['Bob - Dragon']);
  assert.deepStrictEqual(renderPattern('Models/%name%', { model: 'Dragon' }), ['Models', 'Dragon']);
});

test('renderPattern cannot escape the destination root', () => {
  const segments = renderPattern('/%author%/%name%/', { designer: '../../etc', model: 'x' });
  assert.ok(!segments.some((s) => s === '..' || s === '.'), `unexpected traversal: ${segments.join('/')}`);
  assert.ok(isInside('/lib', '/lib/' + segments.join('/')), 'rendered path must stay under the root');
  // A bare ".." never survives sanitising either.
  assert.deepStrictEqual(renderPattern('/%author%/%name%/', { designer: '..', model: 'x' }), ['Unknown', 'x']);
});

test('isInside detects containment both ways', () => {
  assert.ok(isInside('/a', '/a/b'));
  assert.ok(isInside('/a', '/a'));
  assert.ok(!isInside('/a/b', '/a'));
});

test('resolveDestination honours each conflict policy', () => {
  const taken = new Set(['/lib/Bob/Dragon']);
  const exists = (p) => taken.has(p.replace(/\\/g, '/'));
  const base = { destinationRoot: '/lib', pattern: '/%author%/%name%/', vars: { designer: 'Bob', model: 'Dragon' }, exists };

  assert.strictEqual(
    resolveDestination({ ...base, onConflict: 'suffix' }).replace(/\\/g, '/'),
    '/lib/Bob/Dragon (2)'
  );
  assert.strictEqual(
    resolveDestination({ ...base, onConflict: 'merge' }).replace(/\\/g, '/'),
    '/lib/Bob/Dragon'
  );
  assert.strictEqual(resolveDestination({ ...base, onConflict: 'skip' }), null);
});

test('planIngestJobs classifies folders, zips and loose model files', () => {
  const entries = [
    { name: 'Dragon Project', path: '/in/Dragon Project', isDirectory: true },
    { name: 'bracket.zip', path: '/in/bracket.zip', isDirectory: false },
    { name: 'loose.stl', path: '/in/loose.stl', isDirectory: false },
    { name: 'notes.txt', path: '/in/notes.txt', isDirectory: false },
    { name: '.printventory-ingest', path: '/in/.printventory-ingest', isDirectory: true },
  ];
  const jobs = planIngestJobs(entries, { modelExtensions: ['.stl', '.3mf'], extractZips: true });
  assert.deepStrictEqual(jobs.map((j) => j.kind), ['folder', 'zip', 'file']);

  const noZips = planIngestJobs(entries, { modelExtensions: ['.stl', '.3mf'], extractZips: false });
  assert.deepStrictEqual(noZips.map((j) => j.kind), ['folder', 'file']);
});

// ---------------------------------------------------------------------------
// End-to-end moves against a real temporary filesystem
// ---------------------------------------------------------------------------

async function makeTempWorkspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'printventory-ingest-test-'));
  const inbox = path.join(root, 'inbox');
  const library = path.join(root, 'library');
  await fsp.mkdir(inbox, { recursive: true });
  await fsp.mkdir(library, { recursive: true });
  return { root, inbox, library };
}

async function writeFile(filePath, contents) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents);
}

function listRecursive(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRecursive(full, base));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

test('a project folder moves as a whole, keeping its BOM and instructions', async () => {
  const { inbox, library } = await makeTempWorkspace();
  const project = path.join(inbox, 'Articulated Dragon by CinderWing3D');
  await writeFile(path.join(project, 'parts', 'body.stl'), 'solid body');
  await writeFile(path.join(project, 'parts', 'tail.stl'), 'solid tail');
  await writeFile(path.join(project, 'BOM.csv'), 'part,qty');
  await writeFile(path.join(project, 'assembly-instructions.pdf'), '%PDF-1.4');

  const summary = await runIngest({
    ingestDirectory: inbox,
    destinationRoot: library,
    pattern: '/(%author%|Unknown Designer)/%name%/',
  });

  assert.strictEqual(summary.moved, 1, JSON.stringify(summary.results));
  const dest = path.join(library, 'CinderWing3D', 'Articulated Dragon');
  const moved = listRecursive(dest).sort();
  assert.deepStrictEqual(moved, [
    'BOM.csv',
    'assembly-instructions.pdf',
    'parts/body.stl',
    'parts/tail.stl',
  ]);
  assert.ok(!fs.existsSync(project), 'source project should be gone from the inbox');
});

test('a zip is extracted and its contents land together', async () => {
  const { root, inbox, library } = await makeTempWorkspace();

  // The zip payload is prepared on disk; extraction itself is injected so this
  // test needs no archive dependency.
  const payload = path.join(root, 'payload', 'Bracket Set');
  await writeFile(path.join(payload, 'bracket.stl'), 'solid bracket');
  await writeFile(path.join(payload, 'README.txt'), 'From https://example.com/models/42');
  await writeFile(path.join(inbox, 'bracket-set.zip'), 'PK');

  const summary = await runIngest({
    ingestDirectory: inbox,
    destinationRoot: library,
    pattern: '/(%author%|Unknown Designer)/%name%/',
    extractZip: async (_zipPath, destDir) => {
      // Mimic a zip that wraps everything in one top-level folder.
      await fsp.cp(path.dirname(payload), destDir, { recursive: true });
    },
  });

  assert.strictEqual(summary.moved, 1, JSON.stringify(summary.results));
  const dest = path.join(library, 'Unknown Designer', 'Bracket Set');
  assert.deepStrictEqual(listRecursive(dest).sort(), ['README.txt', 'bracket.stl']);
  assert.strictEqual(summary.results[0].metadata.source, 'https://example.com/models/42');
  assert.ok(!fs.existsSync(path.join(inbox, 'bracket-set.zip')), 'archive should be removed after a successful ingest');
  assert.ok(!fs.existsSync(path.join(inbox, '.printventory-ingest')), 'staging folder should be cleaned up');
});

test('sidecar metadata decides the destination', async () => {
  const { inbox, library } = await makeTempWorkspace();
  const project = path.join(inbox, 'download-1234');
  await writeFile(path.join(project, 'thing.stl'), 'solid');
  await writeFile(path.join(project, 'metadata.json'), JSON.stringify({
    name: 'Hex Planter',
    creator: { name: 'PlantyMcPlant' },
    license: 'CC BY-NC 4.0',
    url: 'https://example.com/planter',
  }));

  const summary = await runIngest({
    ingestDirectory: inbox,
    destinationRoot: library,
    pattern: '/(%author%|Unknown Designer)/%name%/',
  });

  assert.strictEqual(summary.moved, 1, JSON.stringify(summary.results));
  assert.ok(fs.existsSync(path.join(library, 'PlantyMcPlant', 'Hex Planter', 'thing.stl')));
  assert.strictEqual(summary.results[0].metadata.license, 'CC BY-NC 4.0');
});

test('a loose model file is filed on its own without pulling in its neighbours', async () => {
  const { inbox, library } = await makeTempWorkspace();
  await writeFile(path.join(inbox, 'Cool Vase by Potter.stl'), 'solid vase');
  await writeFile(path.join(inbox, 'unrelated-notes.txt'), 'https://example.com/not-this');

  const summary = await runIngest({
    ingestDirectory: inbox,
    destinationRoot: library,
    pattern: '/(%author%|Unknown Designer)/%name%/',
  });

  assert.strictEqual(summary.moved, 1, JSON.stringify(summary.results));
  assert.ok(fs.existsSync(path.join(library, 'Potter', 'Cool Vase', 'Cool Vase by Potter.stl')));
  assert.strictEqual(summary.results[0].metadata.source, null);
  assert.ok(fs.existsSync(path.join(inbox, 'unrelated-notes.txt')), 'unrelated files stay put');
});

test('folders with no model files are left alone', async () => {
  const { inbox, library } = await makeTempWorkspace();
  await writeFile(path.join(inbox, 'just-pictures', 'render.png'), 'PNG');

  const summary = await runIngest({ ingestDirectory: inbox, destinationRoot: library });

  assert.strictEqual(summary.moved, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(summary.results[0].reason, 'No model files found');
  assert.ok(fs.existsSync(path.join(inbox, 'just-pictures', 'render.png')));
});

test('a name collision is suffixed rather than overwriting an existing project', async () => {
  const { inbox, library } = await makeTempWorkspace();
  await writeFile(path.join(library, 'Unknown Designer', 'Widget', 'old.stl'), 'solid old');
  await writeFile(path.join(inbox, 'Widget', 'new.stl'), 'solid new');

  const summary = await runIngest({
    ingestDirectory: inbox,
    destinationRoot: library,
    onConflict: 'suffix',
  });

  assert.strictEqual(summary.moved, 1, JSON.stringify(summary.results));
  assert.ok(fs.existsSync(path.join(library, 'Unknown Designer', 'Widget', 'old.stl')));
  assert.ok(fs.existsSync(path.join(library, 'Unknown Designer', 'Widget (2)', 'new.stl')));
});

test('merge policy folds a new download into the existing project folder', async () => {
  const { inbox, library } = await makeTempWorkspace();
  await writeFile(path.join(library, 'Unknown Designer', 'Widget', 'old.stl'), 'solid old');
  await writeFile(path.join(inbox, 'Widget', 'new.stl'), 'solid new');

  const summary = await runIngest({
    ingestDirectory: inbox,
    destinationRoot: library,
    onConflict: 'merge',
  });

  assert.strictEqual(summary.moved, 1, JSON.stringify(summary.results));
  assert.deepStrictEqual(listRecursive(path.join(library, 'Unknown Designer', 'Widget')).sort(), ['new.stl', 'old.stl']);
  assert.ok(!fs.existsSync(path.join(inbox, 'Widget')));
});

test('dry run reports destinations without touching anything', async () => {
  const { inbox, library } = await makeTempWorkspace();
  await writeFile(path.join(inbox, 'Widget', 'part.stl'), 'solid');

  const summary = await runIngest({ ingestDirectory: inbox, destinationRoot: library, dryRun: true });

  assert.strictEqual(summary.moved, 0);
  assert.strictEqual(summary.results[0].status, 'planned');
  assert.ok(fs.existsSync(path.join(inbox, 'Widget', 'part.stl')), 'dry run must not move files');
  assert.strictEqual(listRecursive(library).length, 0);
});

test('overlapping ingestion and library folders are refused', async () => {
  const { inbox } = await makeTempWorkspace();
  const nested = path.join(inbox, 'library');
  await fsp.mkdir(nested, { recursive: true });

  await assert.rejects(
    () => runIngest({ ingestDirectory: inbox, destinationRoot: nested }),
    /must not contain one another/
  );
});

test('one failing project does not stop the rest of the run', async () => {
  const { inbox, library } = await makeTempWorkspace();
  await writeFile(path.join(inbox, 'good', 'part.stl'), 'solid');
  await writeFile(path.join(inbox, 'broken.zip'), 'PK');

  const summary = await runIngest({
    ingestDirectory: inbox,
    destinationRoot: library,
    extractZip: async () => { throw new Error('corrupt archive'); },
  });

  assert.strictEqual(summary.moved, 1);
  assert.strictEqual(summary.failed, 1);
  const failure = summary.results.find((r) => r.status === 'failed');
  assert.strictEqual(failure.reason, 'corrupt archive');
  assert.ok(fs.existsSync(path.join(inbox, 'broken.zip')), 'a failed archive stays in the inbox');
});

runAll();
