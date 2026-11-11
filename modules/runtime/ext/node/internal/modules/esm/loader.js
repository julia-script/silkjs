'use strict';

// getOrInitializeCascadedLoader of Node's lib/internal/modules/esm/loader.js: the
// part the REPL uses, import() of a specifier on behalf of a parent URL.
const host = require('internal/host');

let cascadedLoader;
function getOrInitializeCascadedLoader() {
  if (cascadedLoader !== undefined) return cascadedLoader;
  const importers = new Map();
  const importerFor = (parentURL) => {
    const filename = parentURL === undefined ? require('path').join(process.cwd(), 'repl') :
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
  };
  return cascadedLoader;
}

module.exports = { getOrInitializeCascadedLoader };
