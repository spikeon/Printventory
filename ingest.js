/**
 * Active file management: ingestion engine.
 *
 * Printventory is normally passive — it indexes files wherever they already live.
 * When active file management is enabled, files dropped into an ingestion folder are
 * moved into the library under a folder structure derived from the metadata
 * Printventory can read from them (designer / model name / license).
 *
 * Project integrity is the point of this module: a downloaded model is usually a
 * folder (or a zip) containing the model files *plus* a BOM, assembly instructions,
 * images and licence text. Those move together as one unit so nothing is orphaned.
 *
 * This file is deliberately free of Electron and database imports so it can be
 * unit-tested with plain Node (see ingest.test.js). The main process injects the
 * pieces that need app context: metadata extraction, zip extraction, progress.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/** Folder created inside the ingestion directory for staging zip extractions. */
const STAGING_DIR_NAME = '.printventory-ingest';

/** CAD formats whose header carries exporter metadata worth reading during ingest. */
const CAD_METADATA_EXTENSIONS = new Set(['.step', '.stp', '.igs', '.iges']);

/** Files that should never block a project from being considered empty/complete. */
const JUNK_ENTRY_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '__macosx']);

const DEFAULT_PATTERN = '/(%author%|Unknown Designer)/%name%/';

const INGEST_DEFAULTS = {
  enabled: false,
  ingestDirectory: '',
  destinationRoot: '',
  pattern: DEFAULT_PATTERN,
  onConflict: 'suffix', // 'suffix' | 'merge' | 'skip'
  extractZips: true,
  deleteZipAfterExtract: true,
  autoRunMinutes: 0, // 0 = manual only
};

/** Windows-reserved device names; a folder named CON/PRN/... is unusable there. */
const RESERVED_WINDOWS_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

/**
 * Make one path segment safe on every platform we ship to.
 * Never returns an empty string — callers rely on the result being usable as a folder name.
 */
function sanitizeSegment(value, fallback = 'Unknown') {
  let s = String(value == null ? '' : value);
  // Strip characters illegal on Windows plus path separators and control codes.
  // Hyphens survive on purpose — they are load-bearing in model names ("T-Rex").
  s = s.replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Trailing dots/spaces are silently dropped by Windows; remove them up front.
  s = s.replace(/[. ]+$/g, '');
  if (RESERVED_WINDOWS_NAMES.has(s.toLowerCase())) s = `${s}_`;
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || fallback;
}

/**
 * Tidy a folder or file name for use as the model name: drop the extension, turn
 * separators into spaces and remove the download noise sites add to file names.
 */
function cleanProjectName(rawName) {
  let name = String(rawName || '').trim();
  name = name.replace(/\.(zip|stl|3mf|obj|step|stp)$/i, '');
  name = name.replace(/[_]+/g, ' ');
  name = name.replace(/\s*[-–]\s*(files|download|downloads)$/i, '');
  name = name.replace(/\s*\(\d+\)$/, ''); // browser duplicate suffix: "model (2)"
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

/**
 * Pull a designer out of a project name when the name states one, e.g.
 * "Articulated Dragon by CinderWing3D". Deliberately conservative: patterns that
 * only *might* mean a designer (like "Designer - Model") are not guessed at,
 * because a wrong guess files the project somewhere the user will not look.
 */
function parseNameForMetadata(rawName) {
  const cleaned = cleanProjectName(rawName);
  const byMatch = cleaned.match(/^(.*\S)\s+by\s+(\S.*)$/i);
  if (byMatch) {
    return { model: byMatch[1].trim(), designer: byMatch[2].trim() };
  }
  return { model: cleaned, designer: null };
}

/** Read a designer-ish value that may be a plain string or an object with a name. */
function readPersonField(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object') {
    const candidate = value.name || value.username || value.displayName || value.title;
    if (typeof candidate === 'string') return candidate.trim() || null;
  }
  return null;
}

/**
 * Map an arbitrary metadata JSON sidecar (downloader tools and some sites ship one)
 * onto the fields Printventory stores.
 */
function metadataFromSidecarJson(json) {
  if (!json || typeof json !== 'object') return {};
  const out = {};
  const designer = readPersonField(json.designer)
    || readPersonField(json.creator)
    || readPersonField(json.author)
    || readPersonField(json.owner)
    || readPersonField(json.username)
    || readPersonField(json.user);
  if (designer) out.designer = designer;

  const model = typeof json.name === 'string' ? json.name
    : typeof json.title === 'string' ? json.title
      : typeof json.model === 'string' ? json.model : null;
  if (model && model.trim()) out.model = model.trim();

  const license = readPersonField(json.license) || readPersonField(json.licence);
  if (license) out.license = license;

  const categorySource = json.category || json.categories || json.tags || json.tag;
  const category = Array.isArray(categorySource)
    ? readPersonField(categorySource[0])
    : readPersonField(categorySource);
  if (category) out.category = category;

  const source = typeof json.url === 'string' ? json.url
    : typeof json.source === 'string' ? json.source
      : typeof json.link === 'string' ? json.link
        : typeof json.permalink === 'string' ? json.permalink
          : typeof json.pageUrl === 'string' ? json.pageUrl : null;
  if (source && source.trim()) out.source = source.trim();

  return out;
}

/** First http(s) URL in a text file — Thingiverse-style README files carry the thing URL. */
function firstUrlInText(text) {
  const match = String(text || '').match(/https?:\/\/[^\s"'<>)\]]+/);
  return match ? match[0] : null;
}

/**
 * Pattern language for the library folder structure.
 *
 *   /(%category%|Uncategorized)/(%author%|Unknown)/%name%/
 *
 * - `%token%` is replaced with a field from the model's metadata.
 * - `(a|b|c)` picks the first alternative that resolves to something non-empty, so a
 *   literal at the end of a group acts as its fallback.
 * - `/` separates folder levels; a level that resolves to nothing is dropped rather
 *   than left as a blank folder.
 */
const PATTERN_TOKENS = {
  author: 'designer',
  designer: 'designer',
  name: 'model',
  model: 'model',
  category: 'category',
  tag: 'category',
  license: 'license',
  parent: 'parentModel',
  parentmodel: 'parentModel',
  source: 'source'
};

/** Split a pattern part into literals, %tokens% and (alternation groups). */
function parsePatternParts(text) {
  const parts = [];
  let buffer = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '%') {
      const close = text.indexOf('%', i + 1);
      if (close > i) {
        if (buffer) { parts.push({ type: 'literal', value: buffer }); buffer = ''; }
        parts.push({ type: 'token', name: text.slice(i + 1, close).trim().toLowerCase() });
        i = close;
        continue;
      }
    }
    if (char === '(') {
      const close = text.indexOf(')', i + 1);
      if (close > i) {
        if (buffer) { parts.push({ type: 'literal', value: buffer }); buffer = ''; }
        const alternatives = text.slice(i + 1, close).split('|').map((alt) => parsePatternParts(alt));
        parts.push({ type: 'group', alternatives });
        i = close;
        continue;
      }
    }
    buffer += char;
  }
  if (buffer) parts.push({ type: 'literal', value: buffer });
  return parts;
}

function resolvePatternParts(parts, vars) {
  let out = '';
  for (const part of parts) {
    if (part.type === 'literal') {
      out += part.value;
    } else if (part.type === 'token') {
      const field = PATTERN_TOKENS[part.name];
      const value = field ? vars[field] : vars[part.name];
      out += value == null ? '' : String(value);
    } else if (part.type === 'group') {
      let chosen = '';
      for (const alternative of part.alternatives) {
        const resolved = resolvePatternParts(alternative, vars).trim();
        if (resolved) { chosen = resolved; break; }
      }
      out += chosen;
    }
  }
  return out;
}

/**
 * Turn a pattern into the list of sanitized folder names it describes.
 * Returns [] when nothing resolves, which callers treat as "fall back to the model name".
 */
function renderPattern(pattern, vars) {
  const raw = String(pattern == null || pattern === '' ? DEFAULT_PATTERN : pattern);
  return normalizePath(raw)
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => resolvePatternParts(parsePatternParts(segment), vars).trim())
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment))
    .filter(Boolean);
}

/** True when `child` is the same path as, or nested inside, `parent`. */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  // Compare whole components: a folder legitimately named ".. notes" is not an escape.
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

function isJunkEntry(name) {
  const lower = String(name || '').toLowerCase();
  if (JUNK_ENTRY_NAMES.has(lower)) return true;
  return lower.startsWith('._');
}

/**
 * Pick a destination directory for a project, applying the conflict policy.
 * Returns null when the policy is 'skip' and something is already there.
 */
function resolveDestination({ destinationRoot, pattern, vars, onConflict, exists = fs.existsSync }) {
  const segments = renderPattern(pattern, vars);
  if (segments.length === 0) segments.push(sanitizeSegment(vars.model, 'Model'));
  const target = path.join(destinationRoot, ...segments);

  if (!isInside(destinationRoot, target)) {
    throw new Error(`Refusing to place a project outside the destination root: ${target}`);
  }
  if (!exists(target)) return target;
  if (onConflict === 'merge') return target;
  if (onConflict === 'skip') return null;

  // 'suffix': find the first free "name (n)".
  for (let n = 2; n < 1000; n++) {
    const candidate = `${target} (${n})`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Could not find a free destination name for ${target}`);
}

/** Recursively list files, skipping symlinks (a symlinked loop would never terminate). */
async function walkFiles(dir, { maxDepth = 12 } = {}) {
  const found = [];
  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (isJunkEntry(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        found.push(full);
      }
    }
  }
  await walk(dir, 0);
  return found;
}

function hasModelExtension(filePath, modelExtensions) {
  const ext = path.extname(filePath).toLowerCase();
  return modelExtensions.includes(ext);
}

/**
 * Decide what each top-level entry of the ingestion folder is.
 * A directory or a zip is one project; a loose model file is a project of its own.
 */
function planIngestJobs(entries, { modelExtensions, extractZips }) {
  const jobs = [];
  for (const entry of entries) {
    if (isJunkEntry(entry.name)) continue;
    if (entry.name === STAGING_DIR_NAME) continue;
    if (entry.name.startsWith('.')) continue;

    if (entry.isDirectory) {
      jobs.push({ kind: 'folder', name: entry.name, sourcePath: entry.path });
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === '.zip') {
      if (extractZips) jobs.push({ kind: 'zip', name: entry.name, sourcePath: entry.path });
      continue;
    }
    if (hasModelExtension(entry.name, modelExtensions)) {
      jobs.push({ kind: 'file', name: entry.name, sourcePath: entry.path });
    }
  }
  return jobs;
}

/**
 * Zips commonly wrap everything in a single folder that repeats the zip name.
 * Unwrap that so the library does not end up with "Dragon/Dragon/parts".
 */
async function unwrapSingleRootDirectory(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return dir;
  }
  const meaningful = entries.filter((e) => !isJunkEntry(e.name));
  if (meaningful.length === 1 && meaningful[0].isDirectory()) {
    return path.join(dir, meaningful[0].name);
  }
  return dir;
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch (error) {
    return false;
  }
}

/** Copy a tree, then remove the source. Used when rename() crosses a filesystem. */
async function copyThenRemove(source, destination) {
  await fsp.cp(source, destination, { recursive: true, force: false, errorOnExist: false });
  await fsp.rm(source, { recursive: true, force: true });
}

async function movePath(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fsp.rename(source, destination);
  } catch (error) {
    if (error && (error.code === 'EXDEV' || error.code === 'EPERM')) {
      await copyThenRemove(source, destination);
      return;
    }
    throw error;
  }
}

/**
 * Move every child of `source` into `destination`, keeping files that are already
 * there. Used for the 'merge' conflict policy.
 */
async function mergeDirectoryInto(source, destination) {
  await fsp.mkdir(destination, { recursive: true });
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (isJunkEntry(entry.name)) continue;
    const from = path.join(source, entry.name);
    let to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mergeDirectoryInto(from, to);
      continue;
    }
    if (await pathExists(to)) {
      const ext = path.extname(entry.name);
      const stem = path.basename(entry.name, ext);
      let n = 2;
      while (await pathExists(to) && n < 1000) {
        to = path.join(destination, `${stem} (${n})${ext}`);
        n++;
      }
    }
    await movePath(from, to);
  }
  await fsp.rm(source, { recursive: true, force: true });
}

/**
 * Gather everything we can learn about a project without opening model geometry:
 * sidecar JSON, a source URL from a README, and the project's own name.
 * Deeper metadata (3MF Designer/Title/License) comes from the injected extractor.
 */
async function collectProjectMetadata({ projectDir, projectName, modelFiles, extract3MFMetadata, extractCadMetadata }) {
  const fromName = parseNameForMetadata(projectName);
  const meta = {
    designer: fromName.designer || null,
    model: fromName.model || cleanProjectName(projectName),
    category: null,
    license: null,
    source: null,
    notes: null,
  };

  let rootEntries = [];
  if (projectDir) {
    try {
      rootEntries = await fsp.readdir(projectDir, { withFileTypes: true });
    } catch (error) {
      rootEntries = [];
    }
  }

  // Sidecar JSON written by download helpers.
  for (const entry of rootEntries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
    try {
      const text = await fsp.readFile(path.join(projectDir, entry.name), 'utf8');
      const parsed = metadataFromSidecarJson(JSON.parse(text));
      if (parsed.designer && !meta.designer) meta.designer = parsed.designer;
      if (parsed.model) meta.model = parsed.model;
      if (parsed.category && !meta.category) meta.category = parsed.category;
      if (parsed.license && !meta.license) meta.license = parsed.license;
      if (parsed.source && !meta.source) meta.source = parsed.source;
    } catch (error) {
      // A malformed sidecar must never abort an ingest run.
    }
  }

  // Source URL from a README-style text file.
  if (!meta.source) {
    for (const entry of rootEntries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== '.txt' && ext !== '.md' && ext !== '.url') continue;
      try {
        const text = await fsp.readFile(path.join(projectDir, entry.name), 'utf8');
        const url = firstUrlInText(text);
        if (url) {
          meta.source = url;
          break;
        }
      } catch (error) {
        // ignore unreadable text files
      }
    }
  }

  // 3MF embedded metadata is the most reliable designer/licence source we have.
  if (typeof extract3MFMetadata === 'function') {
    const threeMf = modelFiles.filter((f) => path.extname(f).toLowerCase() === '.3mf');
    for (const file of threeMf) {
      let embedded = null;
      try {
        embedded = await extract3MFMetadata(file);
      } catch (error) {
        embedded = null;
      }
      if (!embedded) continue;
      if (embedded.designer && !meta.designer) meta.designer = String(embedded.designer).trim();
      if (embedded.license && !meta.license) meta.license = String(embedded.license).trim();
      if (embedded.notes && !meta.notes) meta.notes = String(embedded.notes).trim();
      if (embedded.parentModel && !meta.modelFrom3MF) meta.modelFrom3MF = String(embedded.parentModel).trim();
      if (meta.designer && meta.license) break;
    }
    // Only trust the 3MF title for a single-model project; in a multi-part project
    // the title describes one part, not the project.
    if (meta.modelFrom3MF && modelFiles.length === 1) meta.model = meta.modelFrom3MF;
  }

  // STEP/IGES headers record who exported the model — the one thing about a CAD file
  // that cannot be recovered from its geometry.
  if (!meta.designer && typeof extractCadMetadata === 'function') {
    const cadFiles = modelFiles.filter((f) => CAD_METADATA_EXTENSIONS.has(path.extname(f).toLowerCase()));
    for (const file of cadFiles) {
      let cad = null;
      try {
        cad = await extractCadMetadata(file);
      } catch (error) {
        cad = null;
      }
      if (cad && cad.designer && String(cad.designer).trim()) {
        meta.designer = String(cad.designer).trim();
        break;
      }
    }
  }

  if (!meta.model) meta.model = cleanProjectName(projectName) || 'Model';
  return meta;
}

/**
 * Run one ingestion pass.
 *
 * Every job is independent: a failure is recorded against that project and the run
 * continues, so one bad zip cannot strand the rest of the queue.
 */
async function runIngest(options) {
  const {
    ingestDirectory,
    destinationRoot,
    pattern = DEFAULT_PATTERN,
    onConflict = 'suffix',
    modelExtensions = ['.stl', '.3mf'],
    extractZips = true,
    deleteZipAfterExtract = true,
    dryRun = false,
    extract3MFMetadata = null,
    extractCadMetadata = null,
    extractZip = null,
    onProgress = null,
  } = options || {};

  const results = [];
  const summary = {
    ingestDirectory,
    destinationRoot,
    dryRun,
    total: 0,
    moved: 0,
    skipped: 0,
    failed: 0,
    results,
  };

  if (!ingestDirectory) throw new Error('No ingestion folder is set.');
  if (!destinationRoot) throw new Error('No destination library folder is set.');
  if (!fs.existsSync(ingestDirectory)) throw new Error(`Ingestion folder does not exist: ${ingestDirectory}`);
  if (!fs.existsSync(destinationRoot)) throw new Error(`Library folder does not exist: ${destinationRoot}`);
  if (isInside(ingestDirectory, destinationRoot) || isInside(destinationRoot, ingestDirectory)) {
    throw new Error('The ingestion folder and the library folder must not contain one another.');
  }

  const dirEntries = await fsp.readdir(ingestDirectory, { withFileTypes: true });
  const entries = dirEntries.map((entry) => ({
    name: entry.name,
    path: path.join(ingestDirectory, entry.name),
    isDirectory: entry.isDirectory(),
  }));

  const jobs = planIngestJobs(entries, { modelExtensions, extractZips });
  summary.total = jobs.length;

  const stagingRoot = path.join(ingestDirectory, STAGING_DIR_NAME);

  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index];
    if (typeof onProgress === 'function') {
      onProgress({ current: index + 1, total: jobs.length, name: job.name });
    }

    const result = {
      name: job.name,
      kind: job.kind,
      sourcePath: job.sourcePath,
      destination: null,
      status: 'skipped',
      reason: null,
      modelCount: 0,
      metadata: null,
    };

    let stagingDir = null;
    try {
      let projectDir = null;
      let modelFiles = [];

      if (job.kind === 'zip') {
        if (typeof extractZip !== 'function') throw new Error('No zip extractor was provided.');
        await fsp.mkdir(stagingRoot, { recursive: true });
        stagingDir = path.join(stagingRoot, `${path.basename(job.name, path.extname(job.name))}-${Date.now()}-${index}`);
        await fsp.mkdir(stagingDir, { recursive: true });
        await extractZip(job.sourcePath, stagingDir);
        projectDir = await unwrapSingleRootDirectory(stagingDir);
        modelFiles = (await walkFiles(projectDir)).filter((f) => hasModelExtension(f, modelExtensions));
      } else if (job.kind === 'folder') {
        projectDir = job.sourcePath;
        modelFiles = (await walkFiles(projectDir)).filter((f) => hasModelExtension(f, modelExtensions));
      } else {
        modelFiles = [job.sourcePath];
      }

      if (modelFiles.length === 0) {
        result.status = 'skipped';
        result.reason = 'No model files found';
        results.push(result);
        summary.skipped++;
        if (stagingDir) await fsp.rm(stagingDir, { recursive: true, force: true });
        continue;
      }
      result.modelCount = modelFiles.length;

      const projectName = job.kind === 'file'
        ? path.basename(job.name, path.extname(job.name))
        : (projectDir === stagingDir ? path.basename(job.name, path.extname(job.name)) : path.basename(projectDir));

      const meta = await collectProjectMetadata({
        // A loose file in the ingestion root gets no sidecar scan: the other files
        // sitting beside it belong to unrelated projects.
        projectDir: job.kind === 'file' ? null : projectDir,
        projectName,
        modelFiles,
        extract3MFMetadata,
        extractCadMetadata,
      });
      result.metadata = meta;

      const destination = resolveDestination({
        destinationRoot,
        pattern,
        vars: {
          designer: meta.designer || '',
          model: meta.model,
          category: meta.category || '',
          license: meta.license || '',
          parentModel: meta.model,
          source: meta.source || ''
        },
        onConflict,
      });

      if (!destination) {
        result.status = 'skipped';
        result.reason = 'Destination already exists';
        results.push(result);
        summary.skipped++;
        if (stagingDir) await fsp.rm(stagingDir, { recursive: true, force: true });
        continue;
      }
      result.destination = destination;

      if (dryRun) {
        result.status = 'planned';
        results.push(result);
        if (stagingDir) await fsp.rm(stagingDir, { recursive: true, force: true });
        continue;
      }

      if (job.kind === 'file') {
        await fsp.mkdir(destination, { recursive: true });
        const target = path.join(destination, path.basename(job.sourcePath));
        if (await pathExists(target) && onConflict === 'skip') {
          result.status = 'skipped';
          result.reason = 'File already exists at destination';
          results.push(result);
          summary.skipped++;
          continue;
        }
        await movePath(job.sourcePath, target);
        result.movedFiles = [target];
      } else if (await pathExists(destination)) {
        await mergeDirectoryInto(projectDir, destination);
      } else {
        await movePath(projectDir, destination);
      }

      // The extraction staging folder is disposable; the project has left it by now.
      if (stagingDir && await pathExists(stagingDir)) {
        await fsp.rm(stagingDir, { recursive: true, force: true });
      }
      if (job.kind === 'zip' && deleteZipAfterExtract) {
        await fsp.rm(job.sourcePath, { force: true });
        result.removedArchive = true;
      }

      result.status = 'moved';
      results.push(result);
      summary.moved++;
    } catch (error) {
      result.status = 'failed';
      result.reason = error && error.message ? error.message : String(error);
      results.push(result);
      summary.failed++;
      if (stagingDir) {
        try {
          await fsp.rm(stagingDir, { recursive: true, force: true });
        } catch (cleanupError) {
          // best effort
        }
      }
    }
  }

  // Remove the staging root if this run left it empty.
  try {
    if (fs.existsSync(stagingRoot)) {
      const left = await fsp.readdir(stagingRoot);
      if (left.length === 0) await fsp.rm(stagingRoot, { recursive: true, force: true });
    }
  } catch (error) {
    // best effort
  }

  return summary;
}

module.exports = {
  INGEST_DEFAULTS,
  CAD_METADATA_EXTENSIONS,
  DEFAULT_PATTERN,
  PATTERN_TOKENS,
  STAGING_DIR_NAME,
  sanitizeSegment,
  cleanProjectName,
  parseNameForMetadata,
  metadataFromSidecarJson,
  firstUrlInText,
  renderPattern,
  parsePatternParts,
  resolveDestination,
  planIngestJobs,
  unwrapSingleRootDirectory,
  collectProjectMetadata,
  walkFiles,
  isInside,
  runIngest,
};
