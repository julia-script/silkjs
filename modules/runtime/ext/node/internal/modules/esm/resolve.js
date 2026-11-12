'use strict';

// The parts of Node's lib/internal/modules/esm/resolve.js that are reachable with
// --expose-internals and have no hook of their own in the runtime loader:
// defaultResolve (the end of the resolve chain) and legacyMainResolve, whose
// file probing Node does in node_file.cc (LegacyMainResolve).
const host = require('internal/host');
const { codes: { ERR_INVALID_ARG_TYPE, ERR_MODULE_NOT_FOUND } } = require('internal/errors');
const permission = require('internal/permission');
const { fileURLToPath, pathToFileURL, URL, isURL } = require('internal/url');
const { resolve, toNamespacedPath } = require('path');

const legacyMainResolveExtensions = [
  '',
  '.js',
  '.json',
  '.node',
  '/index.js',
  '/index.json',
  '/index.node',
  './index.js',
  './index.json',
  './index.node',
];
// 0-6 resolve through packageConfig.main, 7-9 through the package directory.
const kResolvedByMainIndexNode = 6;

function formatOf(path) {
  try { return host.loader.resolve(path, path, 'import').format; } catch { return undefined; }
}

function emitLegacyIndexDeprecation(path, pkgPath, base, main) {
  if (process.noDeprecation) return;
  if (formatOf(path) !== 'module') return;
  const basePath = fileURLToPath(base);
  if (!main) {
    process.emitWarning(
      `No "main" or "exports" field defined in the package.json for ${pkgPath
      } resolving the main entry point "${
        path.slice(pkgPath.length)}", imported from ${basePath
      }.\nDefault "index" lookups for the main are deprecated for ES modules.`,
      'DeprecationWarning',
      'DEP0151',
    );
  } else if (resolve(pkgPath, main) !== path) {
    process.emitWarning(
      `Package ${pkgPath} has a "main" field set to "${main}", ` +
      `excluding the full filename and extension to the resolved file at "${
        path.slice(pkgPath.length)}", imported from ${
        basePath}.\n Automatic extension resolution of the "main" field is ` +
      'deprecated for ES modules.',
      'DeprecationWarning',
      'DEP0151',
    );
  }
}

// node_file.cc LegacyMainResolve: the index of the first candidate that is a file.
// Each probe needs read permission; the first one denied ends the search.
function probe(pkgPath, main, base) {
  const isFile = (path) => {
    permission.check('fs.read', toNamespacedPath(path));
    try { return require('fs').statSync(path, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; }
  };
  if (typeof main === 'string') {
    const initial = resolve(pkgPath, main);
    for (let i = 0; i <= kResolvedByMainIndexNode; i++) {
      if (isFile(initial + legacyMainResolveExtensions[i])) return i;
    }
  }
  for (let i = kResolvedByMainIndexNode + 1; i < legacyMainResolveExtensions.length; i++) {
    if (isFile(resolve(pkgPath, legacyMainResolveExtensions[i]))) return i;
  }
  if (typeof base !== 'string') {
    throw new ERR_INVALID_ARG_TYPE('base', ['string', 'URL'], base);
  }
  // The base names the importer in the message, so it has to be a URL.
  if (!URL.canParse(base)) {
    const { ERR_INVALID_URL } = require('internal/errors').codes;
    throw new ERR_INVALID_URL(base);
  }
  let importer = base;
  try { importer = fileURLToPath(base); } catch { /* a base that is not a file: URL is named as is */ }
  const missing = typeof main === 'string' ? resolve(pkgPath, main) : resolve(pkgPath, 'index.js');
  throw new ERR_MODULE_NOT_FOUND(missing, importer, undefined);
}

/**
 * Legacy CommonJS main resolution:
 * 1. let M = pkg_url + (json main field)
 * 2. TRY(M, M.js, M.json, M.node)
 * 3. TRY(M/index.js, M/index.json, M/index.node)
 * 4. TRY(pkg_url/index.js, pkg_url/index.json, pkg_url/index.node)
 * 5. NOT_FOUND
 * @param {URL} packageJSONUrl
 * @param {object} packageConfig
 * @param {string | URL | undefined} base
 * @returns {URL}
 */
function legacyMainResolve(packageJSONUrl, packageConfig, base) {
  require('internal/assert')(isURL(packageJSONUrl));
  const pkgPath = fileURLToPath(new URL('.', packageJSONUrl));
  const baseStringified = isURL(base) ? base.href : base;
  const resolvedOption = probe(pkgPath, packageConfig.main, baseStringified);
  const maybeMain = resolvedOption <= kResolvedByMainIndexNode ? packageConfig.main || './' : '';
  const resolvedPath = resolve(pkgPath, maybeMain + legacyMainResolveExtensions[resolvedOption]);
  const resolvedUrl = pathToFileURL(resolvedPath);
  emitLegacyIndexDeprecation(resolvedPath, pkgPath, base, packageConfig.main);
  return resolvedUrl;
}

/**
 * The default resolve hook: the runtime loader's import resolution of specifier
 * from context.parentURL (the cwd for an entry point), as { url, format }.
 * @param {string} specifier
 * @param {{ parentURL?: string, conditions?: string[] }} [context]
 * @returns {{ url: string, format?: string }}
 */
function defaultResolve(specifier, context = {}) {
  const { parentURL } = context;
  if (parentURL !== undefined && (typeof parentURL !== 'string' || !URL.canParse(parentURL))) {
    const { ERR_INVALID_URL } = require('internal/errors').codes;
    throw new ERR_INVALID_URL(`${parentURL}`);
  }
  const { getOrInitializeCascadedLoader } = require('internal/modules/esm/loader');
  const parent = parentURL ?? pathToFileURL(`${process.cwd()}/`).href;
  const { url, format } = getOrInitializeCascadedLoader().resolveSync(parent, { specifier, attributes: { __proto__: null } });
  return { __proto__: null, url, format };
}

module.exports = {
  defaultResolve,
  legacyMainResolve,
};
