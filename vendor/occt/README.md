# occt-import-js (vendored)

These files are copied verbatim from the [`occt-import-js`](https://github.com/kovacsv/occt-import-js)
npm package. They provide the STEP/IGES tessellation used by `parse-worker.js`.

`occt-import-js` is kept as a **devDependency** rather than a runtime dependency: the app loads
the copies in this folder over HTTP (they must be reachable from a Web Worker), so the npm
package exists only as the source to re-vendor from.

To update:

```bash
npm install occt-import-js@latest
cp node_modules/occt-import-js/dist/occt-import-js.js       vendor/occt/occt-import-js.js
cp node_modules/occt-import-js/dist/occt-import-js.wasm     vendor/occt/occt-import-js.wasm
cp node_modules/occt-import-js/dist/license.occt.txt        vendor/occt/LICENSE.occt.txt
cp node_modules/occt-import-js/dist/license.occt-import-js.txt vendor/occt/LICENSE.occt-import-js.txt
```

## Licence

`occt-import-js` and the Open CASCADE Technology it wraps are both **LGPL-2.1**, not MIT like
the rest of Printventory. The full licence texts are in `LICENSE.occt-import-js.txt` and
`LICENSE.occt.txt` and are shipped with every build.
