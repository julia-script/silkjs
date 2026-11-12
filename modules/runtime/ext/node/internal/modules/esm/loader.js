'use strict';

// getOrInitializeCascadedLoader of Node's lib/internal/modules/esm/loader.js: the
// parts the REPL and module mocking use: import() of a specifier on behalf of a
// parent URL, and its synchronous resolution.
const host = require('internal/host');

let cascadedLoader;
function getOrInitializeCascadedLoader() {
  if (cascadedLoader !== undefined) return cascadedLoader;
  const importers = new Map();
  const importerFor = (parentURL) => {
    const path = require('path');
    // A directory URL (the test runner imports reporters from `${cwd}/`) resolves inside
    // that directory, as URL resolution does, so the importer is a file within it.
    const filename = parentURL === undefined ? path.join(process.cwd(), 'repl') :
      `${parentURL}`.endsWith('/') ? path.join(require('url').fileURLToPath(parentURL), '__silk_entry__.js') :
        require('url').fileURLToPath(parentURL);
    let importer = importers.get(filename);
    if (importer === undefined) importers.set(filename, importer = host.vmCreateDefaultImporter(filename));
    return importer;
  };
  cascadedLoader = {
    __proto__: null,
    kSourcePhase: 1,
    kEvaluationPhase: 2,
    // The runtime's import() has no source phase, so phase is always evaluation.
    import(specifier, parentURL, importAttributes) {
      return importerFor(parentURL)(specifier, importAttributes);
    },
    // ModuleLoader.resolveSync: the import resolution of a request from parentURL,
    // through the registered synchronous resolve hooks, as { url, format }.
    resolveSync(parentURL, request) {
      const { fileURLToPath, pathToFileURL } = require('url');
      const parent = typeof parentURL === 'string' && parentURL.startsWith('file:') ? fileURLToPath(parentURL) : parentURL;
      const resolved = host.loader.resolve(request.specifier, parent, 'import', request.attributes);
      const { filename } = resolved;
      const url = require('path').isAbsolute(filename) ? pathToFileURL(filename).href : filename;
      return { __proto__: null, url, format: resolved.format };
    },
  };
  return cascadedLoader;
}

module.exports = { getOrInitializeCascadedLoader };
