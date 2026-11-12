'use strict';
// ShadowRealm host hooks (Node's src/node_shadow_realm.cc and the realm's ESM
// loader). The engine owns ShadowRealm itself (js_shadow_realm.silk); a realm made
// by `new ShadowRealm()` asks `created(handle)` for its importer, which answers
// importValue() and every import() in the realm. As in Node, a realm loads modules
// with the default resolver only (no --loader hooks, no preloads, no builtins),
// resolves its own specifiers against the working directory, and has its own
// module map.
const host = require('internal/host');
const { run } = require('internal/vm');

// The engine's VM module operations (internal/vm/module_wrap).
const COMPILE = 0, REQUEST_COUNT = 3, REQUEST = 4, LINK_REQUEST = 5, INSTANTIATE = 6, NAMESPACE = 7,
  STATUS = 8, IMPORT_META = 11;
const REQUEST_SPECIFIER = 0;
const kInstantiated = 2;

function fileHref(filename) { return require('url').pathToFileURL(filename).href; }
function asURL(name) { return /^[A-Za-z][A-Za-z\d+.-]*:/.test(name) ? name : fileHref(name); }

function moduleSource(filename, format) {
  const source = host.readText(filename);
  if (format === 'module') return host.loader.cleanSource(source);
  // JSON text is a JavaScript expression.
  if (format === 'json') return `export default ${source.replace(/^﻿/, '')};`;
  throw Object.assign(new TypeError(`Unknown module format: ${format} for URL ${asURL(filename)}`),
    { code: 'ERR_UNKNOWN_MODULE_FORMAT' });
}

function realmLoader(handle) {
  const modules = new Map();
  const evaluations = new Map();

  function load(url, filename, format) {
    let module = modules.get(url);
    if (module !== undefined) return module;
    const source = moduleSource(filename, format);
    module = host.vmModule(COMPILE, source, url, handle, 0, 0);
    modules.set(url, module);
    if (url.startsWith('file:')) {
      host.vmModule(IMPORT_META, module, meta => {
        meta.dirname = require('path').dirname(filename);
        meta.filename = filename;
        meta.url = url;
      });
    } else {
      host.vmModule(IMPORT_META, module, meta => { meta.url = url; });
    }
    host.vmSetImportModuleDynamically(module, (specifier, attributes) => importModule(specifier, url));
    return module;
  }

  function resolve(specifier, parentURL) {
    const resolved = host.loader.realmResolve(String(specifier), parentURL);
    return { url: asURL(resolved.filename), filename: resolved.filename, format: resolved.format };
  }

  // V8 InstantiateModule's resolve step: every request of each module of the graph.
  function link(module, url, seen) {
    if (seen.has(module)) return;
    seen.add(module);
    if (host.vmModule(STATUS, module) >= kInstantiated) return;
    const count = host.vmModule(REQUEST_COUNT, module);
    for (let i = 0; i < count; i++) {
      const dependency = resolve(host.vmModule(REQUEST, module, i, REQUEST_SPECIFIER), url);
      const linked = load(dependency.url, dependency.filename, dependency.format);
      host.vmModule(LINK_REQUEST, module, i, linked);
      link(linked, dependency.url, seen);
    }
  }

  async function evaluate(url, filename, format) {
    const module = load(url, filename, format);
    link(module, url, new Set());
    host.vmModule(INSTANTIATE, module);
    await run(module, { timeout: 0, breakOnSigint: false }, false, false);
    return host.vmModule(NAMESPACE, module);
  }

  function importModule(specifier, parentURL) {
    let resolved;
    try { resolved = resolve(specifier, parentURL); } catch (error) { return Promise.reject(error); }
    let evaluation = evaluations.get(resolved.url);
    if (evaluation === undefined) {
      evaluation = evaluate(resolved.url, resolved.filename, resolved.format);
      evaluations.set(resolved.url, evaluation);
    }
    return evaluation;
  }

  // importValue() and import() from realm scripts: relative to the working directory.
  return specifier => importModule(specifier, fileHref(process.cwd()) + '/');
}

// --experimental-shadow-realm: ShadowRealm on this realm's global.
function enable() { host.vmShadowRealm(realmLoader); }

module.exports = { enable };
