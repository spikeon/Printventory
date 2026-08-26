# Changelog

All notable changes contributed via pull request are documented in this file.

## [Unreleased]

### Changed

- The welcome dialog is gone. It said "Welcome to Printventory!" over a single "Get Started!" button and did nothing but stand between a new user and the Quick Start guide, which now opens directly on a first run.

### Fixed

- Opening a project group showed a second, identical group card beside it instead of the project's files. The parts a group revealed were run through grouping again, and since ingestion records the project name as every part's parent model, they immediately reassembled into a parent-model group next to the bundle they had just come out of. A model revealed by expanding a group is now left alone.
- The Quick Start guide reopened every run. Dismissing the welcome dialog triggered two handlers: one in `guide.js` that checks whether the guide has already been seen, and one inline in `index.html` that showed it unconditionally. The inline handler now only closes the welcome dialog, leaving `guide.js` as the single place that decides.

### Added

- Active file management (Settings > Active File Management) — an opt-in mode that turns Printventory from a passive index into a file manager. Downloads dropped into an ingestion folder are moved into the library automatically, filed under a folder pattern built from the metadata Printventory can read from them.
- Whole projects move as one unit, so BOM files, assembly instructions, licence text and images stay with the models they belong to. ZIP archives are fully extracted first (unwrapping a redundant single top-level folder) and their contents filed together.
- Configurable folder pattern with fallbacks, e.g. `/(%category%|Uncategorized)/(%author%|Unknown)/%name%/` — `%token%` inserts metadata, `(a|b)` picks the first option with a value, and empty levels are dropped. Tokens: `%author%`, `%name%`, `%category%`, `%license%`, `%parent%`, `%source%`.
- The library follows metadata edits: changing a model's designer, tags, licence or parent model silently re-files that project in the background, and changing the pattern re-files the whole library. Folders left empty by a move are removed.
- Fixed: a project claimed files from a sibling folder whose name started the same way ("CW2 - Multiscale" swallowed "CW2 - Multiscale - Core"), because membership matched on the folder name rather than the folder boundary. Existing libraries have those mis-recorded paths repaired on the next launch.
- An existing library gains project grouping on the next launch: the folders it was already filed into are registered once and their models grouped, so nothing has to be re-imported.
- Ingested projects group in the library. Printventory already groups the models inside a ZIP archive into one card; ingestion now does the same for the project folders it creates, so a filed download appears as a single expandable card instead of loose parts. Only folders ingestion created group this way — an ordinary scanned folder still lists its files individually.
- Preview (dry run) shows exactly where every item would go before anything is moved.
- In a multi-part project whose models carry different metadata, the model you just edited decides the destination; the other models are left untouched.
- Optional unattended ingestion on a timer, and `INGEST_DIR` support for Docker deployments.
- STEP and IGES files are now first-class: they are tessellated with occt-import-js (a WebAssembly build of Open CASCADE, LGPL-2.1, bundled in `vendor/occt/`) so they render real 3D thumbnails and open in the full 3D preview instead of showing a typed placeholder.
- Existing typed placeholders for any type Printventory can now render are treated as failures, so libraries scanned before this release regenerate real thumbnails on the next pass.
- STEP headers are read during ingestion: the exporting author or organization becomes the designer when the file records one. The CAD document's internal name is deliberately ignored, since the downloaded file name is usually more descriptive.

## [2.2.1] - 2026-08-21

### Fixed

- Fixed error in Slicer parameter — Open in Slicer no longer passes `--single-instance=0` to Bambu Studio / Orca / Snapmaker Orca (that flag is PrusaSlicer-only and caused "Invalid option --single-instance").
- Slicer Settings name field is editable before choosing a path; browsing for an executable also suggests a name when the name is empty.

## [2.2.0] - 2026-08-16

### Added

- Folder and ZIP bundle grouping — models that share a parent folder or ZIP archive appear as a single card with a details panel
- Bundle 3D preview — open every STL/3MF part in a folder or ZIP in one grid layout with per-part colors
- Send to Slicer from preview — send the current model or entire bundle to your configured slicer (new instance on macOS)
- Query Builder, new Preview view, and customizable list columns
- New models tagged "New" until edited, parent-model grouping, LYS/LTY file support, and library disk-usage stats
- Docker/server NVIDIA GPU support, in-container thumbnail generation, and thumbnail progress UI

### Fixed

- Bug fixes and performance optimization

## [2.1.21] - 2026-08-07

### Changed

- Replaced Google Analytics (GA4) with GoatCounter for usage reporting. Still gated by **Enable Usage Reporting** in About.

### Fixed

- First launch after install could leave Electron processes running with no visible window (kill in Task Manager, then relaunch worked). Main window now force-shows after a short timeout, second-instance focuses call `show()`, Chart.js/Fuse.js are vendored locally instead of blocking on a CDN, and UI load has a timeout with `file://` fallback.

## [2.1.20] - 2026-08-07

### Added

- Stats panel shows total library disk usage and per-type byte sizes (3MF / STL / Other) alongside counts.
- Grid multi-thumbnail carousel upgrades from list metadata (`hasMultipleThumbnails`) without loading full thumbnail blobs up front; default-thumbnail changes broadcast live so carousels stay in sync.

### Changed

- Bundle/archive details modal lists models instead of a contents table, with simpler layout and actions.

## [2.1.19] - 2026-08-03

### Fixed

- Directory labels in Detailed/List/details now show the full parent path (including drive letter) instead of only the leaf folder name, so thumbdrive/USB scans are not confused with similarly named folders on other drives. Files in the root of a drive show as `E:\` (not a bare `E:`). Zip entries include the zip's on-disk location.
- Grid thumbnail hydrate no longer logs `Failed to generate thumbnail` / `Render task pruned` when virtual-grid rebuilds or scroll drops off-screen queue jobs (expected). Also prevents a prune from clearing the pending slot while the same file is still mid-render, which could start duplicate concurrent loads.
- On-screen models without thumbnails are re-queued after scroll prune / queue soft-cap. Virtual-grid was keeping recycled DOM cells and never calling `createModelItem` again, so visible placeholders could stay stuck on `3d.png` even though priority favors the viewport.
- ZIP/folder group cards and Generate Missing Thumbnails no longer stay stuck on `3d.png`: detached `renderModelToPNG` callers now pass `retainDetached` so the post-load scroll-prune check does not abort after a successful load (regression from 2.1.17/2.1.18).

## [2.1.18] - 2026-08-03

### Fixed

- Desktop Scan Directory hung at `0 / N models` after 2.1.17: scroll-queue pruning treated scan dummy thumbnail containers as off-screen and discarded them (promises never resolved). Scan/batch jobs now keep detached tasks (`retainDetached`).
- Docker NVIDIA: stop calling `forceContextLoss` during thumbnail recycle/cleanup (it restarted Chromium’s GPU process and flooded logs with Skia OOM / `CreateSharedImage` errors). Soft-dispose instead, disable GPU compositing in the entrypoint, cap NVIDIA WebGL concurrency to 1, and filter residual Chromium GPU-recovery stderr.

## [2.1.17] - 2026-08-02

### Fixed

- Server mode: 3MF preview rendered blank (0×0×0 mm) because WebSocket JSON mangled Float32Array/Uint32Array geometry buffers (#72).
- Docker/server mode: scrolling the grid into models without thumbnails no longer floods `get3MFImages` / WebGL work — prune off-screen queue jobs, cap queue size, fetch only top-scoring compressed 3MF images, and quiet verbose extract logs.
- Docker: suppress Chromium `ERROR:dbus` / “Failed to connect to the bus” log spam (start system bus when possible; filter remaining noise).
- Docker: Generate Missing Thumbnails OOM (V8) — stream path chunks, concurrency 1, pause grid WebGL while bulk job runs, expose GC / cap heap under 4g container limit.
- Docker NVIDIA passthrough was ignored because the entrypoint always forced SwiftShader; hardware path now used when a device is detected (requires `NVIDIA_DRIVER_CAPABILITIES` including `graphics`).
- Server mode reported a hardcoded app version `1.22.5` (log/About); now uses `package.json` via `get-app-version`.
- Docker: V8 heap no longer hard-capped at 3072MB — auto-scales from the container cgroup limit (or 8192 when unlimited); override with `PRINTVENTORY_MAX_OLD_SPACE_MB`.

### Added

- System Report: show Client GPU (browser WebGL) and Server/App GPU (nvidia-smi + Electron renderer / GL backend).
- Docker: auto-select NVIDIA WebGL when a GPU is present (`PRINTVENTORY_GPU=auto|nvidia|swiftshader`); otherwise SwiftShader.

### Changed

- Preparing for 2.2 Public

## [2.1.16] - 2026-07-27

### Changed

- Docker/server mode: Generate Missing and Regenerate Thumbnails now run in the container (hidden Electron + SwiftShader WebGL) so progress continues when the browser tab is unfocused.

## [2.1.15] - 2026-07-25

### Added

- Show a modal progress bar for Regenerate Thumbnails and Generate Missing Thumbnails (including purge/load phases).

### Fixed

- Docker Fixes

### Changed

- Prepare for 2.2 Public Release

## [2.1.14] - 2026-07-25

### Fixed

- Fixed failed thumbnail regeneration

### Changed

- Prepare for 2.2 Public Release

## [2.1.13] - 2026-07-22

### Fixed

- Faster cold start: bundle column migration no longer rewrites every non-ZIP model on each launch (one-shot zip-only backfill), and extract-temp cleanup no longer blocks window creation or readdir’s the full OS TEMP folder at startup.

## [2.1.12] - 2026-07-21

### Fixed

- Fixed thumbnail generation for models inside ZIP archives: `get-file-stats` now reads entry size from the archive instead of `fs.stat` on the virtual `zip::` path (which caused ENOENT and left archive STLs on the default `3d.png` placeholder).

## [2.1.11] - 2026-07-21

### Fixed

- Fixed issue where directories were being grouped. Bundle grouping is limited to ZIP archives (and `parentModel` metadata groups); plain folder siblings stay as individual models. Legacy `folder:` bundle keys are cleared on startup.

## [2.1.10] - 2026-07-21

### Fixed

- Folder/ZIP group cards no longer aggregate every child thumbnail into a runaway `1/539`-style carousel; carousel is capped (12), uses one primary image per part, and hydrates without per-child badge updates or `getAllThumbnails` storms (also speeds up startup on large libraries).
- Bundle group card meta text no longer appends the long “right-click Preview” hint inline; overflow is clipped cleanly in list/detailed/preview layouts.
- Bundle details sidebar spacing no longer inherits the blanket `.model-details div` margin on every nested element.
- Folder/ZIP group **icons** no longer stay stuck on the generic `3d.png` placeholder: grid rows omit thumbnail blobs, so groups now prioritize `hasThumbnail` children, fetch the first wave in parallel, and cache results across virtual-grid recycles (fixes blank zip/folder icons and reduces long startup churn).
- Large flat STLs (e.g. ~400mm plates) no longer save blank/transparent grid thumbnails: thumbnail camera far plane now matches preview, framing centers after orientation, and clipped empty thumbs are detected and regenerated.
- Docker image now includes `bundle-keys.js` (required for folder/ZIP bundle grouping in server mode).

## [2.1.9] - 2026-07-19

### Fixed

- ZIP model extracts now always land under the OS temp folder (`printventory-extracts/`), never beside library files, and are cleaned up after preview/read, slicer launch, open, download, app quit, and on startup.

## [2.1.8] - 2026-07-19

### Added

- **Folder and ZIP bundle grouping** — When scanning, models that share the same parent folder or the same ZIP archive (2+ files) are grouped into a single row in List, Preview, and Detailed views. Single-file folders stay as individual entries.
- **Bundle 3D preview** — Click a folder or ZIP bundle to open one preview dialog showing every STL/3MF part laid out on a grid, with per-part colors for clarity. Up to 32 previewable parts per bundle.
- **Bundle details panel** — Double-click a bundle (or use **Open 3D preview** from the panel) to see path, combined size, print status, and a sortable file list. Chevron still expands/collapses the bundle in the grid.
- **Send to Slicer in preview** — The 3D preview dialog includes a **Send to Slicer** button. Works for single models and full bundles (all STL/3MF paths). If multiple slicers are configured, a picker is shown.
- **New slicer instance on send** — macOS launches slicers with `open -n` so a new window opens even when the slicer is already running. Prusa-family binaries also receive `--single-instance=0` when launched directly.
- **`bundle-keys.js`** — Shared logic to derive `bundleKey`, `bundleLabel`, and `bundleKind` from file paths (including `zipPath::entry` paths).
- **`npm run test:bundle`** — Unit tests for bundle key derivation.

### Changed

- Scan insert/update and `saveModel` persist bundle metadata (`bundleKey`, `bundleLabel`, `bundleKind`) with automatic migration on startup.
- Context menu **Open in Slicer** and preview **Send to Slicer** share the same launch helper (`buildSlicerLaunchCommand` / `open-file-in-slicer` IPC).
- `window.openSlicerSettings` is exposed from `slicer.js` for use from the preview flow.

### Database

- New optional columns on `models`: `bundleKey`, `bundleLabel`, `bundleKind` (backfilled on existing databases).
