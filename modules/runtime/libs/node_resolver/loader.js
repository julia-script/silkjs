'use strict';

const { analyzeExports } = require('./cjs_exports');
const { createHooks } = require('./hooks');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const builtinPrefix = Function.prototype.call.bind(String.prototype.startsWith);
const builtinSlice = Function.prototype.call.bind(String.prototype.slice);
// Node's kFirstModuleParent: internal/errors reads it for require stacks.
const kModuleParent = require('internal/host').kFirstModuleParent;

// Embedding contract: compileFunction evaluates the complete wrapper expression;
// evaluateModule(source, filename, isEntry) runs a real native ESM graph; the
// entry marker and inspectorEntry(wrapper) identify only the main user code.
// requireModule, when supplied, synchronously returns its namespace or throws
// ERR_REQUIRE_ASYNC_MODULE for asynchronous graphs. detectModuleSyntax provides
// the engine's syntax detection for ambiguous source. The native module loader
// calls resolve(request, parent, 'import') and loadESM(filename, attributes), and
// installs the returned bridge as globalThis.__silkModuleBridge.

function createLoader(host, builtins) {
  const path = host.path;
  // Node's internalModuleStat probes metadata without public fs permissions.
  // Keep this capability private; source and package JSON reads remain checked.
  // It answers a path's file type bits (mode & S_IFMT), 0 for a path that is not there.
  const typeOf = host.moduleType;
  // Package files already read, by directory. As in Node, one is read once.
  const packages = new Map();
  // The package scope of a directory, and the node_modules lookup paths of one (callers
  // get a copy). Permissions are fixed once a program runs, so the walks give the same
  // answer every time.
  const scopes = new Map(), lookupPaths = new Map();
  // Real paths already found. As with Node's realpathCache, a symlink changed while the
  // program runs is not seen again.
  const realPaths = new Map();
  // The last file tryFile found to be a regular file and not a symlink, for the realPath
  // of the same resolution, which then needs no lstat of its own.
  let regularFile = null;
  // Parent filenames as given to resolve, resolved.
  const parentNames = new Map();
  // What a require of a relative or bare specifier found, by the specifier and its
  // directory or lookup paths, as with Node's Module._pathCache: a module found once is
  // not looked for again. Callers get a copy.
  const foundPaths = new Map();
  // The source format() read to tell a module from a script, for the load that follows.
  let probed = null;
  const cache = Object.create(null);
  const extensions = Object.create(null);
  let main;
  let globalPaths = [];
  const resolutions = new Map();
  const pendingLoads = new Map();
  const moduleAsyncModes = new WeakMap();
  let sourceLoadActive = false;
  const moduleMocks = new Map();
  const mockInstances = new Map();
  let mockVersion = 0;
  let strippedSource;
  let activeConditions;
  const hooks = createHooks(defaultResolve, defaultLoad, () => builtins.get('worker_threads'),
    host.awaitModuleHook, host.loaderWorkerStatus,
    () => builtins.get('internal/options').loaderWorkerArguments(host.workerRuntimeArgs || []));

  // Node's own errors come from internal/errors, built with the arguments Node's loader
  // passes. A missing CommonJS module is a plain Error with a code, as in Node.
  const { codes } = require('internal/errors');
  const { validateString } = require('internal/validators');
  const invalidArgType = (name, expected, value) => new codes.ERR_INVALID_ARG_TYPE(name, expected, value);
  const invalidArgValue = (name, value, reason) => new codes.ERR_INVALID_ARG_VALUE(name, value, reason);
  const error = (code, ...args) => new codes[code](...args);
  const notFound = (message, properties) => Object.assign(new Error(message), { code: 'MODULE_NOT_FOUND' }, properties);
  const filenameOf = url => { try { return filesystemName(url); } catch (_) { return url; } };
  // A package's directory as Node's package errors name it.
  const packagePath = pkg => pkg.directory.endsWith(path.sep) ? pkg.directory : pkg.directory + path.sep;

  const text = host.readText;

  function probedText(filename) {
    if (probed === null || probed.filename !== filename) return text(filename);
    const source = probed.source;
    probed = null;
    return source;
  }

  function cleanSource(source) {
    if (source.charCodeAt(0) === 0xFEFF) source = source.slice(1);
    if (source.startsWith('#!')) {
      const newline = source.indexOf('\n');
      source = newline < 0 ? '' : '\n' + source.slice(newline + 1);
    }
    return source;
  }

  function isFile(filename) {
    return typeOf(filename, true) === 0o100000;
  }

  function isDirectory(filename) {
    return typeOf(filename, true) === 0o040000;
  }

  function fileURL(filename) {
    let normalized = path.sep === '\\' ? filename.replace(/\\/g, '/') : filename;
    if (!normalized.startsWith('/')) normalized = '/' + normalized;
    return 'file://' + normalized.split('/').map(encodeURIComponent).join('/');
  }

  function fromFileURL(value) {
    const match = /^file:(?:\/\/([^/?#]*))?([^?#]*)([?#].*)?$/i.exec(value);
    if (!match) throw error('ERR_INVALID_URL', value);
    if (match[1] && match[1].toLowerCase() !== 'localhost') {
      throw error('ERR_INVALID_FILE_URL_HOST', process.platform);
    }
    if (/%2f|%5c/i.test(match[2])) throw error('ERR_INVALID_MODULE_SPECIFIER', match[2], 'must not include encoded "/" or "\\" characters');
    let filename;
    try { filename = decodeURIComponent(match[2]); }
    catch (_) { throw error('ERR_INVALID_URL', value); }
    if (filename.includes('\0')) throw invalidArgValue('path', value, 'must be a string or Uint8Array without null bytes');
    if (path.sep !== '\\' && !filename.startsWith('/')) filename = '/' + filename;
    if (path.sep === '\\' && /^\/[A-Za-z]:/.test(filename)) filename = filename.slice(1);
    return { filename: path.resolve(filename), suffix: match[3] || '' };
  }

  function filesystemName(filename) {
    return filename.startsWith('file:') ? fromFileURL(filename).filename : filename;
  }

  function parentName(parent) {
    if (parent && typeof parent === 'object') parent = parent.filename;
    if (!parent) return path.join(host.cwd(), '__silk_entry__.js');
    parent = String(parent);
    let name = parentNames.get(parent);
    if (name !== undefined) return name;
    const filename = filesystemName(parent);
    // A file URL ending in a slash names a directory (module.register(specifier, cwd URL)).
    name = parent.startsWith('file:') && /\/(?:[?#].*)?$/.test(parent) ? path.join(path.resolve(filename), '[directory]') : path.resolve(filename);
    // A relative one depends on the working directory.
    if (path.isAbsolute(filename)) parentNames.set(parent, name);
    return name;
  }

  function readPackage(directory) {
    const filename = path.join(directory, 'package.json');
    if (typeof host.checkModuleRead === 'function') host.checkModuleRead(filename);
    const known = packages.get(directory);
    if (known !== undefined) return known;
    if (!isFile(filename)) { packages.set(directory, null); return null; }
    let data;
    try { data = JSON.parse(text(filename).replace(/^\uFEFF/, '')); }
    catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      throw Object.assign(error('ERR_INVALID_PACKAGE_CONFIG', filename, undefined, cause.message), { cause });
    }
    // Like Node, keep only the fields resolution reads, on a null-prototype object, so
    // a getter on Object.prototype never stands in for a missing field.
    const fields = Object.create(null);
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      for (let i = 0, names = ['name', 'main', 'type', 'exports', 'imports']; i < names.length; i++) {
        if (Object.prototype.hasOwnProperty.call(data, names[i])) fields[names[i]] = data[names[i]];
      }
    }
    const pkg = { directory, filename, data: fields };
    packages.set(directory, pkg);
    return pkg;
  }

  // The real path of an absolute filename: its directory's, found once, joined to its own
  // name unless it is itself a symlink. One lstat for a file whose directory is known.
  function realPath(filename) {
    let real = realPaths.get(filename);
    if (real !== undefined) return real;
    const directory = path.dirname(filename);
    if (directory === filename || !path.isAbsolute(filename)) real = host.realpath(filename);
    else if (filename !== regularFile && typeOf(filename, false) === 0o120000) real = host.realpath(filename);
    else {
      // A real directory is normalized and the base name has no separator.
      const base = realPath(directory);
      real = (base.endsWith(path.sep) ? base : base + path.sep) + path.basename(filename);
    }
    regularFile = null;
    realPaths.set(filename, real);
    return real;
  }

  function packageScope(filename) {
    const start = path.dirname(filesystemName(filename));
    let scope = scopes.get(start);
    if (scope === undefined) scopes.set(start, scope = findScope(start));
    return scope;
  }

  function findScope(directory) {
    for (;;) {
      if (path.basename(directory) === 'node_modules') return null;
      if (typeof host.canReadModulePath === 'function' && !host.canReadModulePath(directory)) return null;
      const pkg = readPackage(directory);
      if (pkg) return pkg;
      const next = path.dirname(directory);
      if (next === directory) return null;
      directory = next;
    }
  }

  function modulePaths(directory) {
    let result = lookupPaths.get(directory);
    if (result === undefined) directory = path.resolve(directory), result = lookupPaths.get(directory);
    if (result === undefined) {
      result = [];
      for (let current = directory; ;) {
        if (path.basename(current) !== 'node_modules') result.push(path.join(current, 'node_modules'));
        const next = path.dirname(current);
        if (next === current) break;
        current = next;
      }
      lookupPaths.set(directory, result);
    }
    return result.slice();
  }

  function builtinName(specifier) {
    // The runtime's own modules, such as silk:serve, have only their silk: names.
    if (builtinPrefix(specifier, 'silk:')) {
      if (!builtins.runtime(specifier)) throw error('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${specifier}`);
      return specifier;
    }
    if (builtinPrefix(specifier, 'node:')) {
      const name = builtinSlice(specifier, 5);
      if (builtins.runtime(name) || (!builtins.listed(name) && !builtins.listed(specifier))) {
        throw error('ERR_UNKNOWN_BUILTIN_MODULE', specifier);
      }
      return name;
    }
    return builtins.listed(specifier) && builtins.has(specifier) ? specifier : null;
  }

  // Where a builtin lives: node:fs for Node's modules, the specifier itself for silk: ones.
  function builtinFile(name) {
    return builtinPrefix(name, 'silk:') ? name : 'node:' + name;
  }

  function isBuiltinFile(filename) {
    return filename.startsWith('node:') || filename.startsWith('silk:');
  }

  function loadBuiltin(filename) {
    const name = isBuiltinFile(filename) ? builtinName(filename) : null;
    if (name === null) throw error('ERR_UNKNOWN_BUILTIN_MODULE', filename);
    return builtins.get(name);
  }

  // A .js file outside any typed package, required by another module with no hooks
  // on: as in Node, it is compiled as CommonJS and its syntax is checked for ESM only
  // when that fails, so the file is not parsed twice.
  const ambiguous = 'commonjs (ambiguous)';
  // Modules of such files that turned out to be ES modules.
  const detectedModules = new WeakSet();

  function format(filename, mode, deferDetection = false) {
    if (isBuiltinFile(filename)) return 'builtin';
    const disk = filesystemName(filename);
    const ext = path.extname(disk);
    if (ext === '.json') return 'json';
    if (ext === '.node') return 'addon';
    if (ext === '.mjs') return 'module';
    if (ext === '.cjs') return 'commonjs';
    if (host.typeScriptMode && (ext === '.ts' || ext === '.mts' || ext === '.cts')) {
      if (ext === '.mts') return 'module-typescript';
      if (ext === '.cts') return 'commonjs-typescript';
      const pkg = packageScope(disk);
      return pkg && (pkg.data.type === 'module' || pkg.data.type === 'commonjs') ? pkg.data.type + '-typescript' : undefined;
    }
    if (mode === 'import' && ext !== '.js' && ext !== '') {
      throw error('ERR_UNKNOWN_FILE_EXTENSION', ext, disk);
    }
    const pkg = ext === '.js' || mode === 'import' ? packageScope(disk) : null;
    if (pkg && pkg.data.type === 'module') return 'module';
    // Embedders may provide Node's syntax detection for ambiguous .js files.
    if ((!pkg || pkg.data.type !== 'commonjs') && typeof host.detectModuleSyntax === 'function') {
      if (deferDetection) return ambiguous;
      const source = text(disk);
      if (host.detectModuleSyntax(cleanSource(source), disk)) return 'module';
      probed = { filename: disk, source };
    }
    return 'commonjs';
  }

  function descriptor(filename, mode, suffix, isMain) {
    const preserve = isMain ? host.preserveSymlinksMain : host.preserveSymlinks;
    const canonical = preserve ? path.resolve(filename) : realPath(filename);
    const identity = suffix && mode === 'import' ? fileURL(canonical) + suffix : canonical;
    let kind;
    try { kind = format(identity, mode, mode === 'require' && !isMain && !hooks.active()); }
    catch (cause) {
      // As in Node, an unknown extension is a load error: resolution (and
      // import.meta.resolve) still succeeds and leaves the format to the load step.
      if (cause.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw cause;
    }
    if (kind === ambiguous) return { filename: identity, format: 'commonjs', ambiguous: true };
    return { filename: identity, format: kind };
  }

  // In import mode Node names what it looked for: the resolved file (with its URL,
  // which import.meta.resolve returns) or the package.
  function missing(specifier, parent, mode, filename, packageName) {
    if (mode === 'import') {
      if (filename !== undefined) return error('ERR_MODULE_NOT_FOUND', filename, parent, fileURL(filename));
      return error('ERR_MODULE_NOT_FOUND', packageName ?? specifier, parent, null);
    }
    const stack = [];
    let current = cache[parent];
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      stack.push(current.filename);
      current = current[kModuleParent];
    }
    if (!stack.length && parent) stack.push(parent);
    return notFound(`Cannot find module '${specifier}'` + (stack.length ? '\nRequire stack:\n- ' + stack.join('\n- ') : ''), { requireStack: stack });
  }

  function tryFile(filename) {
    // An lstat answers for a regular file, and its realPath needs no other.
    const type = typeOf(filename, false);
    if (type === 0o100000) { regularFile = filename; return filename; }
    return type === 0o120000 && isFile(filename) ? filename : null;
  }

  function tryExtensions(filename) {
    for (let i0 = 0, a0 = Object.keys(extensions); i0 < a0.length; i0++) { const ext = a0[i0];
      if (ext === '.ts' || ext === '.mts' || ext === '.cts') continue;
      const result = tryFile(filename + ext);
      if (result) return result;
    }
    return null;
  }

  function legacyFile(filename, directoryAllowed, directoryOnly) {
    const exact = directoryOnly ? null : tryFile(filename) || tryExtensions(filename);
    if (exact || !directoryAllowed || !isDirectory(filename)) return exact;
    const pkg = readPackage(filename);
    if (pkg && typeof pkg.data.main === 'string' && pkg.data.main) {
      const target = path.resolve(filename, pkg.data.main);
      const found = tryFile(target) || tryExtensions(target) || tryExtensions(path.join(target, 'index'));
      if (found) return found;
    }
    const index = tryExtensions(path.join(filename, 'index'));
    if (index) return index;
    if (pkg && typeof pkg.data.main === 'string' && pkg.data.main) {
      throw notFound(`Cannot find module '${path.resolve(filename, pkg.data.main)}'. Please verify that the package.json has a valid "main" entry`, { path: pkg.filename, requestPath: filename });
    }
    return null;
  }

  // pkg: the package whose "exports" or "imports" mapped the request. A require of a
  // missing target then fails like Node's createEsmNotFoundErr: the file, no stack.
  function strictFile(filename, specifier, parent, mode, suffix, isMain, pkg) {
    if (isDirectory(filename)) {
      if (mode === 'import') {
        // Node names the directory as resolved, keeping the specifier's trailing slash.
        const named = typeof specifier === 'string' && /\/$/.test(specifier.replace(/[?#].*$/, '')) && !filename.endsWith(path.sep) ? filename + path.sep : filename;
        throw error('ERR_UNSUPPORTED_DIR_IMPORT', named, parent, fileURL(named));
      }
      throw missing(specifier, parent, mode);
    }
    if (!isFile(filename)) {
      if (pkg && mode !== 'import') throw notFound(`Cannot find module '${filename}'`, { path: pkg.filename });
      throw missing(specifier, parent, mode, filename);
    }
    return descriptor(filename, mode, suffix, isMain);
  }

  function invalidTarget(pkg, key, target, internal, parent) {
    return error('ERR_INVALID_PACKAGE_TARGET', packagePath(pkg), key, target, internal, parent || undefined);
  }

  // Node's segment rules: ".", "..", "node_modules" (and their percent forms) are
  // invalid; an empty segment ("//", a leading or trailing "/") is only deprecated.
  // Both expressions are Node.js v24's (lib/internal/modules/esm/resolve.js, MIT license,
  // Copyright Node.js contributors).
  const invalidSegmentRegEx = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))?(\\|\/|$)/i;
  const deprecatedInvalidSegmentRegEx = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;
  function segmentDeprecation(target, request, key, pkg, internal, parent, isTarget) {
    if (process.noDeprecation) return;
    const double = /[/\\][/\\]/.test(isTarget ? target : request);
    process.emitWarning(`Use of deprecated ${double ? 'double slash' : 'leading or trailing slash matching'} resolving "${target}" for module ` +
      `request "${request}" ${request !== key ? `matched to "${key}" ` : ''}in the "${internal ? 'imports' : 'exports'}" field module resolution of the package at ` +
      `${packagePath(pkg)}package.json${parent ? ` imported from ${parent}` : ''}.`, 'DeprecationWarning', 'DEP0166');
  }

  function packageTarget(pkg, target, replacement, key, pattern, internal, parent, mode, seen) {
    if (typeof target === 'string') {
      if (!target.startsWith('./')) {
        if (internal && !target.startsWith('../') && !target.startsWith('/') && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(target) && !target.startsWith('#')) {
          const request = pattern ? target.split('*').join(replacement) : target;
          return { external: request, parent: pkg.filename };
        }
        throw invalidTarget(pkg, key, target, internal, parent);
      }
      const subpath = replacement || '';
      const request = pattern ? key.replace('*', () => subpath) : key + subpath;
      const expandedTarget = pattern ? target.split('*').join(subpath) : target;
      if (invalidSegmentRegEx.test(target.slice(2))) {
        if (deprecatedInvalidSegmentRegEx.test(target.slice(2))) throw invalidTarget(pkg, key, target, internal, parent);
        segmentDeprecation(expandedTarget, request, key, pkg, internal, parent, true);
      }
      if (subpath !== '' && invalidSegmentRegEx.test(subpath)) {
        if (deprecatedInvalidSegmentRegEx.test(subpath)) {
          throw error('ERR_INVALID_MODULE_SPECIFIER', request, `request is not a valid match in pattern "${key}" for the ` +
            `"${internal ? 'imports' : 'exports'}" resolution of ${packagePath(pkg)}package.json`, parent || undefined);
        }
        segmentDeprecation(expandedTarget, request, key, pkg, internal, parent, false);
      }
      const expanded = pattern ? target.split('*').join(replacement) : target;
      const url = fromFileURL(fileURL(pkg.directory) + '/' + expanded.slice(2));
      const relative = path.relative(pkg.directory, url.filename);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw invalidTarget(pkg, key, target, internal, parent);
      return { filename: url.filename, suffix: url.suffix };
    }
    if (Array.isArray(target)) {
      if (target.length === 0) return null;
      let last;
      for (let i1 = 0, a1 = target; i1 < a1.length; i1++) { const item = a1[i1];
        let result;
        try { result = packageTarget(pkg, item, replacement, key, pattern, internal, parent, mode, seen); }
        catch (cause) {
          if (cause.code !== 'ERR_INVALID_PACKAGE_TARGET') throw cause;
          last = cause;
          continue;
        }
        if (result === undefined) continue;
        if (result === null) { last = null; continue; }
        return result;
      }
      if (last) throw last;
      return last;
    }
    if (target && typeof target === 'object') {
      const keys = Object.keys(target);
      for (let i2 = 0, a2 = keys; i2 < a2.length; i2++) { const condition = a2[i2];
        if (/^(0|[1-9]\d*)$/.test(condition) && Number(condition) < 4294967295) {
          throw error('ERR_INVALID_PACKAGE_CONFIG', pkg.filename, parent || undefined, '"exports" cannot contain numeric property keys.');
        }
      }
      for (let i3 = 0, a3 = keys; i3 < a3.length; i3++) { const condition = a3[i3];
        if (condition === 'default' || (activeConditions ? activeConditions.includes(condition) : condition === 'node' || condition === 'node-addons' || condition === mode || (condition === 'module-sync' && requireModuleEnabled()) || (host.moduleConditions && host.moduleConditions.includes(condition)))) {
          const result = packageTarget(pkg, target[condition], replacement, key, pattern, internal, parent, mode, seen);
          if (result !== undefined) return result;
        }
      }
      return undefined;
    }
    if (target === null) return null;
    throw invalidTarget(pkg, key, target, internal, parent);
  }

  function packageMap(pkg, mapping, request, internal, parent, mode, seen, isMain) {
    if (!internal) {
      if (typeof mapping === 'string' || Array.isArray(mapping) || mapping === null) mapping = { '.': mapping };
      else if (mapping && typeof mapping === 'object') {
        const keys = Object.keys(mapping);
        const subpaths = keys.filter((key) => key.startsWith('.')).length;
        if (subpaths && subpaths !== keys.length) throw error('ERR_INVALID_PACKAGE_CONFIG', pkg.filename, parent || undefined, '"exports" cannot contain some keys starting with \'.\' and some not.' +
          ' The exports object must either be an object of package subpath keys or an object of main entry condition name keys only.');
        if (!subpaths) mapping = { '.': mapping };
      } else throw invalidTarget(pkg, request, mapping, internal, parent);
    }
    let target;
    let match;
    let replacement = '';
    let pattern = false;
    if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
      if (own(mapping, request) && !request.includes('*') && !request.endsWith('/')) {
        match = request;
        target = mapping[request];
      } else {
        for (let i4 = 0, a4 = Object.keys(mapping); i4 < a4.length; i4++) { const key = a4[i4];
          const star = key.indexOf('*');
          if (star === -1 || key.indexOf('*', star + 1) !== -1) continue;
          const prefix = key.slice(0, star);
          const suffix = key.slice(star + 1);
          if (!request.startsWith(prefix) || !request.endsWith(suffix) || request.length < key.length) continue;
          if (match === undefined || star > match.indexOf('*') || (star === match.indexOf('*') && key.length > match.length)) {
            match = key;
            target = mapping[key];
            replacement = request.slice(prefix.length, request.length - suffix.length);
            pattern = true;
          }
        }
      }
    }
    if (match !== undefined) {
      const targetResult = packageTarget(pkg, target, replacement, match, pattern, internal, parent, mode, seen);
      if (targetResult !== null && targetResult !== undefined) {
        if (targetResult.external) return resolveInternal(targetResult.external, targetResult.parent, mode, undefined, seen, isMain);
        return strictFile(targetResult.filename, request, parent, mode, targetResult.suffix, isMain, pkg);
      }
    }
    if (internal) throw error('ERR_PACKAGE_IMPORT_NOT_DEFINED', request, packagePath(pkg), parent);
    throw error('ERR_PACKAGE_PATH_NOT_EXPORTED', packagePath(pkg), request, mode === 'import' && parent ? parent : undefined);
  }

  // Node's parsePackageName: only the name part (before the first '/', or the second
  // for a scope) must not start with '.' or hold '%' or '\\'.
  function packageName(specifier, parent) {
    let separator = specifier.indexOf('/');
    let valid = true;
    if (specifier[0] === '@') {
      if (separator === -1) valid = false;
      else separator = specifier.indexOf('/', separator + 1);
    }
    const name = separator === -1 ? specifier : specifier.slice(0, separator);
    if (/^\.|%|\\/.test(name)) valid = false;
    if (!valid) throw error('ERR_INVALID_MODULE_SPECIFIER', specifier, 'is not a valid package name', parent || undefined);
    return { name, subpath: separator === -1 ? '.' : '.' + specifier.slice(separator) };
  }

  function resolveInternal(specifier, parent, mode, options, seen, isMain) {
    if (typeof specifier !== 'string') throw invalidArgType('id', 'string', specifier);
    if (specifier.length === 0) throw invalidArgValue('id', specifier, 'must be a non-empty string');
    if (mode === 'import' && specifier.includes('\0')) throw invalidArgValue('specifier', specifier, 'must not contain null bytes');
    const builtin = builtinName(specifier);
    if (builtin !== null) return { filename: builtinFile(builtin), format: 'builtin' };
    if (options && own(options, 'paths') && options.paths !== undefined && !Array.isArray(options.paths)) {
      throw invalidArgValue('options.paths', options.paths);
    }
    const parentObject = parent && typeof parent === 'object' ? parent : null;
    parent = parentName(parent);
    const parentModule = parentObject || cache[parent];
    const recursion = mode + '\0' + parent + '\0' + specifier;
    if (seen.has(recursion)) throw error('ERR_INVALID_MODULE_SPECIFIER', specifier, 'maps back to itself through package "exports" or "imports"', parent || undefined);
    seen.add(recursion);
    try {
      // As in Node, a require of '#name' whose package has no "imports" looks in node_modules.
      if (specifier.startsWith('#') && (mode === 'import' || (packageScope(parent)?.data.imports ?? null) !== null)) {
        if (specifier === '#' || specifier.endsWith('/')) throw error('ERR_INVALID_MODULE_SPECIFIER', specifier, 'is not a valid internal imports specifier name', parent || undefined);
        const pkg = packageScope(parent);
        if (!pkg) throw error('ERR_PACKAGE_IMPORT_NOT_DEFINED', specifier, undefined, parent);
        return packageMap(pkg, pkg.data.imports, specifier, true, parent, mode, seen, isMain);
      }
      if (mode === 'import' && specifier.startsWith('file:')) {
        const url = fromFileURL(specifier);
        return strictFile(url.filename, specifier, parent, mode, url.suffix, isMain);
      }
      const relative = specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
      if (path.isAbsolute(specifier) || relative) {
        let requested = specifier;
        let suffix = '';
        if (mode === 'import') {
          const position = requested.search(/[?#]/);
          if (position !== -1) { suffix = requested.slice(position); requested = requested.slice(0, position); }
          if (/%2f|%5c/i.test(requested)) throw error('ERR_INVALID_MODULE_SPECIFIER', requested, 'must not include encoded "/" or "\\" characters', parent || undefined);
          try { requested = decodeURIComponent(requested); }
          catch (_) { throw error('ERR_INVALID_URL', specifier); }
        }
        const bases = options && Array.isArray(options.paths) ? options.paths : [path.dirname(parent)];
        const key = cacheable(mode, options, isMain) ? specifier + '\0' + bases[0] : null;
        if (key !== null) {
          const known = foundPaths.get(key);
          if (known !== undefined) return { ...known };
        }
        for (let i5 = 0, a5 = bases; i5 < a5.length; i5++) { const base = a5[i5];
          const candidate = path.resolve(base, requested);
          if (mode === 'import') return strictFile(candidate, specifier, parent, mode, suffix, isMain);
          const found = legacyFile(candidate, true, /[\\/]$/.test(specifier) || specifier === '.' || specifier === '..');
          if (found) return remember(key, descriptor(found, mode, undefined, isMain));
        }
        throw missing(specifier, parent, mode);
      }
      if (mode === 'import' && /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier)) throw error('ERR_UNSUPPORTED_ESM_URL_SCHEME', { protocol: /^[^:]*:/.exec(specifier)[0] }, ['file', 'data', 'node']);
      const parsed = packageName(specifier, parent);
      const scope = packageScope(parent);
      if (scope && scope.data.name === parsed.name && scope.data.exports !== undefined && scope.data.exports !== null) {
        return packageMap(scope, scope.data.exports, parsed.subpath, false, parent, mode, seen, isMain);
      }
      let search;
      if (options && options.paths !== undefined) {
        search = [];
        for (let i6 = 0, a6 = options.paths; i6 < a6.length; i6++) { const base = a6[i6];
          const paths = modulePaths(base);
          if (mode === 'require') for (let index = 0; index < globalPaths.length; index++) paths.push(globalPaths[index]);
          for (let i7 = 0, a7 = paths; i7 < a7.length; i7++) { const entry = a7[i7]; if (!search.includes(entry)) search.push(entry); }
        }
      } else {
        search = mode === 'require' && parentModule && Array.isArray(parentModule.paths) ? parentModule.paths : modulePaths(path.dirname(parent));
        if (mode === 'require') search = search.concat(globalPaths);
      }
      const key = cacheable(mode, options, isMain) ? specifier + '\0' + search.join('\0') : null;
      if (key !== null) {
        const known = foundPaths.get(key);
        if (known !== undefined) return { ...known };
      }
      return remember(key, findPackage(search, parsed, specifier, parent, mode, seen, isMain));
    } finally { seen.delete(recursion); }
  }

  // Whether resolveInternal may keep what it finds in foundPaths: a plain require, as
  // hooks can answer differently each time and a main module's symlinks may be kept.
  function cacheable(mode, options, isMain) {
    return mode === 'require' && !isMain && !(options && options.paths !== undefined) && !hooks.active();
  }

  function remember(key, result) {
    if (key === null) return result;
    foundPaths.set(key, result);
    return { ...result };
  }

  function findPackage(search, parsed, specifier, parent, mode, seen, isMain) {
    for (let i8 = 0, a8 = search; i8 < a8.length; i8++) { const directory = a8[i8];
      if (!isDirectory(directory)) continue;
      const root = path.join(directory, parsed.name);
      const pkg = readPackage(root);
      if (pkg && pkg.data.exports !== undefined && pkg.data.exports !== null) return packageMap(pkg, pkg.data.exports, parsed.subpath, false, parent, mode, seen, isMain);
      const candidate = parsed.subpath === '.' ? root : path.join(root, parsed.subpath.slice(2));
      if (mode === 'import' && parsed.subpath !== '.') {
        if (isDirectory(root)) return strictFile(candidate, specifier, parent, mode, undefined, isMain);
        continue;
      }
      if (mode === 'import' && pkg && typeof pkg.data.main === 'string') {
        const exact = path.resolve(root, pkg.data.main);
        if (isFile(exact)) return descriptor(exact, mode, undefined, isMain);
      }
      const found = legacyFile(candidate, true, /[\\/]$/.test(specifier));
      if (found) return descriptor(found, mode, undefined, isMain);
      if (mode === 'import' && isDirectory(root)) throw missing(specifier, parent, mode, undefined, root + path.sep);
    }
    throw missing(specifier, parent, mode, undefined, parsed.name);
  }

  function conditions(mode) {
    const values = mode === 'require' ? ['require', 'node', 'node-addons'] : ['node', 'import', 'node-addons'];
    if (requireModuleEnabled()) values.push('module-sync');
    if (host.moduleConditions) for (let index = 0; index < host.moduleConditions.length; index++) values.push(host.moduleConditions[index]);
    return values;
  }

  function asURL(filename) {
    return /^[A-Za-z][A-Za-z\d+.-]*:/.test(filename) ? filename : fileURL(filename);
  }

  function identity(url, mode) {
    if (!url.startsWith('file:')) return url;
    const parsed = fromFileURL(url);
    return mode === 'import' && parsed.suffix ? url : parsed.filename;
  }

  function defaultResolve(specifier, context) {
    if (context.conditions !== undefined && !Array.isArray(context.conditions)) throw invalidArgValue('context.conditions', context.conditions, 'expected an array');
    const mode = context.conditions && context.conditions.includes('require') ? 'require' : 'import';
    const textImport = host.importText && context.importAttributes && context.importAttributes.type === 'text';
    if (specifier.startsWith('data:')) return { url: specifier, format: textImport ? 'text' : dataFormat(specifier) };
    const builtin = builtinName(specifier);
    if (builtin !== null) return { url: builtinFile(builtin), format: 'builtin' };
    if (context.parentURL && !context.parentURL.startsWith('file:') && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier) && !path.isAbsolute(specifier)) {
      throw error('ERR_UNSUPPORTED_RESOLVE_REQUEST', specifier, context.parentURL);
    }
    if (specifier.startsWith('file:') && mode === 'require') specifier = fromFileURL(specifier).filename;
    const previous = activeConditions;
    activeConditions = context.conditions;
    try {
      const result = resolveInternal(specifier, context.parentURL, mode, context.resolveOptions, new Set(), context.isMain);
      return { url: asURL(result.filename), format: textImport ? 'text' : result.format };
    } finally { activeConditions = previous; }
  }

  function rememberResolution(result, mode, attributes) {
    const resolved = { filename: identity(result.url, mode), url: result.url, format: result.format,
      importAttributes: result.importAttributes === undefined ? attributes : result.importAttributes };
    resolutions.set(resolved.filename, resolved);
    resolutions.set(result.url, resolved);
    return resolved;
  }

  function resolve(specifier, parent, mode, attributes, options, isMain, allowAsync) {
    regularFile = null;
    mode = mode === 'import' || mode === 'esm' ? 'import' : 'require';
    if (allowAsync === undefined) allowAsync = mode === 'import';
    if (!hooks.active(allowAsync) && !String(specifier).startsWith('data:')) {
      return mockResolution(resolveInternal(specifier, parent, mode, options, new Set(), isMain), mode);
    }
    const parentFilename = parent && typeof parent === 'object' ? parent.filename : parent;
    const parentURL = parentFilename ? asURL(parentFilename) : undefined;
    return mockResolution(rememberResolution(hooks.run('resolve', specifier, {
      parentURL, conditions: conditions(mode), importAttributes: attributes || {},
      resolveOptions: options, isMain: !!isMain,
    }, allowAsync), mode, attributes), mode);
  }

  function mockResolution(resolved, mode) {
    if (mode !== 'import' || moduleMocks.size === 0) return resolved;
    const mock = moduleMocks.get(asURL(resolved.filename));
    if (!mock) return resolved;
    let filename = mock.identity;
    if (!mock.cache || !filename) {
      const url = new (builtins.get('url').URL)(asURL(resolved.filename));
      url.searchParams.set('node-test-mock', String(mockVersion++));
      filename = url.href;
      if (mock.cache) mock.identity = filename;
      mockInstances.set(filename, mock);
      mock.instances.add(filename);
    }
    return { filename, url: filename, format: 'module' };
  }

  function mockCommonJS(mock, filename, parent) {
    if (mock.cache && own(cache, filename)) return cache[filename].exports;
    const value = own(mock.exports, 'default') ? mock.exports.default : {};
    const names = Object.keys(mock.exports).filter(name => name !== 'default');
    if ((value === null || typeof value !== 'object') && names.length)
      throw new Error('Cannot create mock because named exports cannot be applied to the provided default export.');
    for (const name of names) Object.defineProperty(value, name, Object.getOwnPropertyDescriptor(mock.exports, name));
    if (mock.cache) {
      const entry = makeModule(filename, parent);
      entry.exports = value;
      entry.loaded = true;
      cache[filename] = entry;
    }
    return value;
  }

  function mockModule(specifier, caller, exports, cached) {
    const resolved = resolve(specifier, caller, 'import');
    if (mockInstances.has(resolved.filename) || moduleMocks.has(asURL(resolved.filename)))
      throw error('ERR_INVALID_STATE', `Cannot mock '${specifier}'. The module is already mocked.`);
    if (resolved.format && !['builtin', 'commonjs', 'module', 'json', 'commonjs-typescript', 'module-typescript'].includes(resolved.format))
      throw invalidArgValue('specifier', specifier, `has an unsupported module format '${resolved.format}'`);
    const keys = new Set([asURL(resolved.filename)]);
    try { keys.add(asURL(resolve(specifier, caller, 'require').filename)); } catch (_) {}
    for (const key of keys) if (moduleMocks.has(key))
      throw error('ERR_INVALID_STATE', `Cannot mock '${specifier}'. The module is already mocked.`);
    const mock = { exports, cache: cached, format: resolved.format, filename: filesystemName(resolved.filename), identity: undefined, instances: new Set() };
    const saved = [];
    for (const key of keys) {
      const filename = filesystemName(key);
      saved.push({ key, filename, present: own(cache, filename), value: cache[filename] });
      delete cache[filename];
      moduleMocks.set(key, mock);
    }
    let restored = false;
    return {
      restore() {
        if (restored) return;
        restored = true;
        for (const entry of saved) {
          moduleMocks.delete(entry.key);
          delete cache[entry.filename];
          if (entry.present) cache[entry.filename] = entry.value;
        }
        for (const filename of mock.instances) mockInstances.delete(filename);
      },
    };
  }

  function mockESM(filename, mock) {
    const commonjs = mock.format === 'builtin' || mock.format === 'commonjs' || mock.format === 'commonjs-typescript';
    let source = 'const value = globalThis.__silkModuleBridge.mockExports(' + JSON.stringify(filename) + ');\n';
    if (commonjs) source += 'export default value;\nexport { value as "module.exports" };\n';
    else if (own(mock.exports, 'default')) source += 'export default value.default;\n';
    let index = 0;
    for (const name of Object.keys(mock.exports)) {
      if (name === 'default' || (commonjs && name === 'module.exports')) continue;
      const local = 'mock_export_' + index++;
      source += 'const ' + local + ' = value[' + JSON.stringify(name) + '];\nexport { ' + local + ' as ' + JSON.stringify(name) + ' };\n';
    }
    return { source, format: 'module', filename };
  }

  function resolveMain(filename) {
    return resolve(path.resolve(host.cwd(), filename), undefined, 'require', undefined, undefined, true, hooks.hasAsync());
  }

  // A data: URL's format by its MIME type, as Node reads it: an unknown type has no format,
  // which the load step reports once the import attributes have been checked.
  function dataFormat(url) {
    const match = /^data:([^/]+\/[^;,]+)(?:[^,]*?)(;base64)?,/.exec(url);
    if (!match) return null;
    const mime = match[1];
    return mime === 'text/javascript' || mime === 'application/javascript' ? 'module'
      : mime === 'application/json' ? 'json' : mime === 'text/plain' && host.importText ? 'text' : null;
  }
  function dataSource(url) {
    const match = /^data:([^/]+\/[^;,]+)(?:[^,]*?)(;base64)?,([\s\S]*)$/.exec(url);
    if (!match) throw error('ERR_INVALID_URL', url);
    // Percent escapes are bytes, decoded as UTF-8 with replacement characters, as Node does.
    const bytes = match[2] ? host.Buffer.from(match[3], 'base64') : host.Buffer.concat(match[3].split(/(%[0-9A-Fa-f]{2})/)
      .map(part => /^%[0-9A-Fa-f]{2}$/.test(part) ? host.Buffer.from([parseInt(part.slice(1), 16)]) : host.Buffer.from(part, 'utf8')));
    return { format: dataFormat(url), source: bytes.toString('utf8') };
  }
  function unknownFormat(format, url) {
    return error('ERR_UNKNOWN_MODULE_FORMAT', format, url);
  }

  function defaultLoad(url, context) {
    const data = url.startsWith('data:') ? dataSource(url) : undefined;
    const textImport = host.importText && context.importAttributes && context.importAttributes.type === 'text';
    let kind = context.format || (textImport ? 'text' : data ? data.format : format(url, context.conditions && context.conditions.includes('require') ? 'require' : 'import'));
    if (!context.conditions || !context.conditions.includes('require')) validateAttributes(kind, url, context.importAttributes || {});
    if (data) {
      if (!kind) throw unknownFormat(dataMime(url), url);
      return { ...data, format: kind };
    }
    if (kind === 'builtin' || kind === 'addon') return { format: kind, source: null };
    // Node's async default loader leaves CJS execution to the legacy loader.
    // A hook that supplies source opts hook-thread CJS into hook-aware requires.
    if (kind === 'commonjs' && hooks.inWorker()) return { format: kind, source: null };
    if (!url.startsWith('file:')) throw error('ERR_UNSUPPORTED_ESM_URL_SCHEME', { protocol: /^[^:]*:/.exec(url)?.[0] ?? '' }, ['file', 'data', 'node']);
    const source = text(filesystemName(url));
    if (kind === undefined && host.typeScriptMode && path.extname(filesystemName(url)) === '.ts') {
      const prepared = prepareSource(source, url, 'typescript');
      if (sourceLoadActive) strippedSource = { filename: url, source, transformed: prepared.source };
      kind = prepared.format + '-typescript';
    }
    return { format: kind, source };
  }

  function sourceText(source) {
    if (typeof source === 'string') return source;
    if (ArrayBuffer.isView(source)) return host.Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8');
    return host.Buffer.from(source).toString('utf8');
  }

  function prepareSource(source, filename, kind) {
    if (kind !== 'typescript' && kind !== 'module-typescript' && kind !== 'commonjs-typescript')
      return { source, format: kind };
    const cached = strippedSource;
    strippedSource = undefined;
    source = cached && cached.filename === filename && cached.source === source ? cached.transformed
      : host.stripTypeScriptModuleTypes(source, filesystemName(filename), asURL(filename));
    const base = kind === 'typescript' ? host.detectModuleSyntax(cleanSource(source), filename) ? 'module' : 'commonjs'
      : kind.slice(0, -11);
    return { source, format: base };
  }

  function loadSource(resolved, attributes, allowAsync = true, mode = 'import') {
    const previousActive = sourceLoadActive, previousSource = strippedSource;
    sourceLoadActive = true;
    strippedSource = undefined;
    try {
      const url = resolved.url || asURL(resolved.filename);
      const loaded = hooks.run('load', url, { format: resolved.format,
        importAttributes: attributes || resolved.importAttributes || {}, conditions: conditions(mode) }, allowAsync);
      let source = loaded.source == null ? loaded.source : sourceText(loaded.source);
      const legacyCommonJS = source == null && loaded.format === 'commonjs';
      if (source == null && loaded.format !== 'builtin' && loaded.format !== 'addon') {
        if (loaded.format === 'commonjs' && url.startsWith('file:')) source = text(filesystemName(url));
        else throw error('ERR_INVALID_RETURN_PROPERTY_VALUE', 'a string, an ArrayBuffer, or a TypedArray', 'load', 'source', source);
      }
      const prepared = prepareSource(source, url, loaded.format);
      return { ...loaded, ...prepared, filename: resolved.filename, url, legacyCommonJS };
    } finally {
      sourceLoadActive = previousActive;
      strippedSource = previousSource;
    }
  }

  function findPackageJSON(specifier, base = 'data:') {
    if (arguments.length === 0) throw error('ERR_MISSING_ARGS', 'specifier');
    try { specifier = `${specifier}`; }
    catch (_) { validateString(specifier, 'specifier'); }
    const { URL, fileURLToPath, pathToFileURL } = builtins.get('url');
    let parentURL = base;
    if (!(base instanceof URL)) {
      validateString(base, 'base');
      parentURL = path.isAbsolute(base) ? pathToFileURL(base) : new URL(base);
    }
    let absolute;
    try { absolute = new URL(specifier); } catch (_) {}
    if (specifier && specifier[0] !== '.' && specifier[0] !== '/' && !absolute) {
      // Bare specifiers identify the package root, not its exports target (or
      // even an existing package.json). Do not resolve or parse that target.
      const parsed = packageName(specifier, parentURL.href);
      const scopeBase = parentURL.protocol === 'file:' ? fileURLToPath(parentURL) : null;
      const scope = scopeBase === null ? null : packageScope(parentURL.pathname.endsWith('/') ? path.join(scopeBase, '__package_scope__') : scopeBase);
      if (scope && scope.data.name === parsed.name && scope.data.exports != null) return scope.filename;
      let candidate = new URL(`./node_modules/${parsed.name}/package.json`, parentURL);
      for (;;) {
        const filename = fileURLToPath(candidate);
        if (isDirectory(filename.slice(0, -13))) return filename;
        const next = new URL(`${parsed.name.startsWith('@') ? '../' : ''}../../../node_modules/${parsed.name}/package.json`, candidate);
        if (fileURLToPath(next).length === filename.length) throw missing(parsed.name, fileURLToPath(parentURL), 'import');
        candidate = next;
      }
    }
    let target = absolute;
    if (!target) {
      if (!specifier) throw missing(specifier, parentURL.href, 'import');
      try { target = new URL(specifier, parentURL); }
      catch (_) {
        throw error('ERR_UNSUPPORTED_RESOLVE_REQUEST', specifier, parentURL.href);
      }
    }
    if (/%2f|%5c/i.test(target.pathname) && target.protocol === 'file:') {
      throw error('ERR_INVALID_MODULE_SPECIFIER', target.pathname, 'must not include encoded "/" or "\\" characters', filenameOf(parentURL.href));
    }
    let filename = fileURLToPath(target);
    if (!isDirectory(filename)) {
      if (!isFile(filename)) throw missing(specifier, parentURL.href, 'import', filename);
      if (!host.preserveSymlinks) filename = realPath(filename);
    }
    // An unsupported directory import retains its original URL and trailing
    // slash. A slash makes the directory itself the first package scope.
    const pkg = packageScope(target.pathname.endsWith('/') ? path.join(filename, '__package_scope__') : filename);
    return pkg ? pkg.filename : filename;
  }

  function addChild(parent, child) {
    if (parent && !parent.children.includes(child)) parent.children.push(child);
  }

  let isPreloading = false;
  class Module {
    constructor(id = '', parent = null) {
      this.id = id;
      this.filename = null;
      this.path = path.dirname(id);
      this.exports = {};
      this[kModuleParent] = parent;
      this.children = [];
      this.paths = modulePaths(this.path);
      this.loaded = false;
    }
    require(specifier) { return makeRequire(this.filename || path.join(host.cwd(), '__entry__.js'), this, moduleAsyncModes.get(this) === true)(specifier); }
    _compile(source, filename) {
      const compiledSource = cleanSource(source);
      const wrapper = wrapperPatched
        ? host.compileFunction(Module.wrap(compiledSource), filename, undefined, undefined, true)
        : host.compileFunction(wrapperPrefix + compiledSource + wrapperSuffix, filename, compiledSource, wrapperPrefix.length);
      const metadata = host.getScriptMetadata(wrapper);
      host.registerSource(filename, compiledSource, {
        owner: this, scriptId: metadata?.scriptId, sourceURL: metadata?.sourceURL ?? null, sourceMapURL: metadata?.sourceMapURL ?? null,
      });
      if (this === main && host.inspectorEntry) host.inspectorEntry(wrapper);
      return wrapper.call(this.exports, this.exports, makeRequire(filename, this, moduleAsyncModes.get(this) === true), this, filename, path.dirname(filename));
    }
    load(filename) {
      if (this.loaded) throw error('ERR_INTERNAL_ASSERTION', 'Module is already loaded');
      this.filename = filename;
      this.path = path.dirname(filename);
      this.paths = modulePaths(this.path);
      const ext = path.extname(filename);
      (extensions[ext] || extensions['.js'])(this, filename);
      this.loaded = true;
    }
  }
  Object.defineProperty(Module.prototype, 'isPreloading', { get: () => isPreloading });
  Module._preloadModules = requests => {
    if (!Array.isArray(requests)) return;
    isPreloading = true;
    const parent = new Module('internal/preload', null);
    try { parent.paths = Module._nodeModulePaths(host.cwd()); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    for (const request of requests) parent.require(request);
    isPreloading = false;
  };
  let wrapperPatched = false;
  const wrapperPrefix = '(function (exports, require, module, __filename, __dirname) { ';
  const wrapperSuffix = '\n});';
  let wrapper = new Proxy([wrapperPrefix, wrapperSuffix], {
    set(target, key, value, receiver) { wrapperPatched = true; return Reflect.set(target, key, value, receiver); },
    defineProperty(target, key, descriptor) { wrapperPatched = true; return Reflect.defineProperty(target, key, descriptor); },
  });
  let wrap = source => Module.wrapper[0] + source + Module.wrapper[1];
  Object.defineProperties(Module, {
    wrap: { get() { return wrap; }, set(value) { wrapperPatched = true; wrap = value; } },
    wrapper: { get() { return wrapper; }, set(value) { wrapperPatched = true; wrapper = value; } },
  });
  Module.Module = Module;
  Module._cache = cache;
  Module._extensions = extensions;
  Module._nodeModulePaths = directory => modulePaths(path.resolve(directory));
  // Node's internalModuleStat: 0 for a file, 1 for a directory, negative otherwise.
  Module._stat = filename => {
    const type = typeOf(path.toNamespacedPath(String(filename)), true);
    return type === 0o100000 ? 0 : type === 0o040000 ? 1 : -2;
  };
  Module._resolveLookupPaths = (request, parent) => {
    if (builtinName(request) !== null) return null;
    if (request[0] !== '.' || (request.length > 1 && request[1] !== '.' && request[1] !== '/' && (path.sep !== '\\' || request[1] !== '\\'))) {
      const paths = parent && Array.isArray(parent.paths) && parent.paths.length ? parent.paths.concat(globalPaths) : globalPaths.slice();
      return paths.length > 0 ? paths : null;
    }
    if (!parent || !parent.id || !parent.filename) return ['.'];
    return [path.dirname(parent.filename)];
  };
  Module._findPath = (request, paths, isMain) => {
    const absolute = path.isAbsolute(request);
    if (absolute) paths = [''];
    else if (!Array.isArray(paths) || paths.length === 0) return false;
    const trailingSlash = /[\\/]$/.test(request) || /(?:^|[\\/])\.?\.$/.test(request);
    for (let index = 0; index < paths.length; index++) {
      const base = paths[index];
      if (!absolute && typeOf(base, true) !== 0o040000) continue;
      const found = legacyFile(path.resolve(base, request), true, trailingSlash);
      if (found) return isMain ? (host.preserveSymlinksMain ? path.resolve(found) : realPath(found)) : (host.preserveSymlinks ? path.resolve(found) : realPath(found));
    }
    return false;
  };
  Module._resolveFilename = (request, parent, isMain, options) => {
    const result = resolve(request, parent, 'require', undefined, options, !!isMain, !!parent && moduleAsyncModes.get(parent) === true);
    return result.format === 'builtin' && !request.startsWith('node:') && result.filename.startsWith('node:') ? result.filename.slice(5) : result.filename;
  };
  Module._load = (request, parent, isMain) => {
    probed = null;
    const allowAsync = !!parent && moduleAsyncModes.get(parent) === true;
    return loadResolved(resolve(request, parent, 'require', undefined, undefined, !!isMain, allowAsync), parent, !!isMain, allowAsync);
  };
  Module._initPaths = () => {
    const windows = process.platform === 'win32';
    const home = process.env[windows ? 'USERPROFILE' : 'HOME'];
    const prefix = windows ? path.resolve(process.execPath, '..') : path.resolve(process.execPath, '..', '..');
    const paths = [path.resolve(prefix, 'lib', 'node')];
    if (home) paths.unshift(path.resolve(home, '.node_modules'), path.resolve(home, '.node_libraries'));
    if (process.env.NODE_PATH) paths.unshift(...process.env.NODE_PATH.split(path.delimiter).filter(Boolean));
    globalPaths = paths;
    Module.globalPaths = paths.slice();
  };
  Module._initPaths();
  Module.findPackageJSON = findPackageJSON;
  Module.stripTypeScriptTypes = function stripTypeScriptTypes(code, options) {
    return arguments.length < 2 ? builtins.get('internal/typescript').stripTypeScriptTypes(code)
      : builtins.get('internal/typescript').stripTypeScriptTypes(code, options);
  };
  Module.registerHooks = hooks.registerHooks;
  Module.register = hooks.register;
  Module.createRequire = filename => {
    if (filename && typeof filename === 'object' && filename.href) filename = filename.href;
    if (typeof filename !== 'string' || (!filename.startsWith('file:') && !path.isAbsolute(filename))) throw invalidArgValue('filename', filename, 'must be a file URL object, file URL string, or absolute path string');
    return requireFor(filename, undefined, false);
  };
  Module.isBuiltin = name => typeof name === 'string' && (builtins.listed(name) ||
    (builtinPrefix(name, 'node:') && builtins.listed(builtinSlice(name, 5))));
  Object.defineProperty(Module, 'builtinModules', { enumerable: true, get: () => builtins.names() });
  Module.runMain = (main = process.argv[1]) => runMain(main);
  const defaultRunMain = Module.runMain;
  // module.parent reads the module that first required this one; Node deprecates it
  // (DEP0144, a warning only with --pending-deprecation).
  {
    const message = 'module.parent is deprecated due to accuracy issues. Please use require.main to find program entry point instead.';
    let warned = false;
    const warn = () => {
      if (warned || !host.pendingDeprecation) return;
      warned = true;
      process.emitWarning(message, 'DeprecationWarning', 'DEP0144');
    };
    Object.defineProperty(Module.prototype, 'parent', {
      configurable: true, enumerable: false,
      get() { warn(); return this[kModuleParent]; },
      set(value) { warn(); this[kModuleParent] = value; },
    });
  }
  function makeModule(filename, parent) {
    const module = new Module(filename, parent || null);
    module.filename = filename;
    return module;
  }

  extensions['.js'] = (module, filename) => module._compile(probedText(filename), filename);
  for (const extension of ['.ts', '.mts', '.cts']) {
    extensions[extension] = (module, filename) => {
      const source = text(filename);
      module._compile(host.typeScriptMode
        ? prepareSource(source, filename, format(filename, 'require') || 'typescript').source : source, filename);
    };
  }
  extensions['.json'] = (module, filename) => {
    try { module.exports = JSON.parse(text(filename).replace(/^\uFEFF/, '')); }
    catch (cause) {
      if (cause instanceof SyntaxError) cause.message = filename + ': ' + cause.message;
      throw cause;
    }
  };
  extensions['.node'] = (module, filename) => {
    if (typeof host.loadAddon !== 'function') throw Object.assign(new Error(`Native addon loading is not available for '${filename}'`), { code: 'ERR_DLOPEN_FAILED' });
    host.loadAddon(filename, module);
  };

  // As in Bun, the entry points of an installed `ws` package give the runtime's own
  // implementation (internal/ws), whose frames are read and written natively.
  const substituteEntry = /[\\/]node_modules[\\/]ws[\\/](?:index\.js|wrapper\.mjs)$/;
  function substituteExports(filename) {
    return substituteEntry.test(filesystemName(filename)) ? builtins.get('internal/ws') : undefined;
  }

  function loadResolved(resolved, parent, isMain, allowAsync = false) {
    const mock = moduleMocks.size === 0 ? undefined : moduleMocks.get(asURL(resolved.filename));
    if (mock) return mockCommonJS(mock, filesystemName(resolved.filename), parent);
    const substitute = substituteExports(resolved.filename);
    if (substitute !== undefined) {
      const filename = filesystemName(resolved.filename);
      if (!own(cache, filename)) {
        const module = makeModule(filename, parent);
        module.exports = substitute;
        module.loaded = true;
        cache[filename] = module;
      }
      addChild(parent, cache[filename]);
      return cache[filename].exports;
    }
    if (resolved.format === 'builtin' && !hooks.active(allowAsync)) return loadBuiltin(resolved.filename);
    const filename = filesystemName(resolved.filename);
    if (host.reportDependency && path.isAbsolute(filename)) host.reportDependency(filename);
    if (own(cache, filename)) {
      if ((resolved.format === 'module' || detectedModules.has(cache[filename])) && !cache[filename].loaded) {
        throw cycleError(filename, parent);
      }
      addChild(parent, cache[filename]);
      return cache[filename].exports;
    }
    let loaded = pendingLoads.get(resolved.filename);
    if (loaded) pendingLoads.delete(resolved.filename);
    else if (hooks.active(allowAsync) || !path.isAbsolute(filename) ||
        (host.typeScriptMode && /\.(?:ts|mts|cts)$/.test(filename)))
      loaded = loadSource(resolved, undefined, allowAsync, 'require');
    if (loaded) resolved = { ...resolved, format: loaded.format };
    if (resolved.format === 'builtin') return loadBuiltin(resolved.filename);
    const module = makeModule(filename, parent);
    moduleAsyncModes.set(module, allowAsync && !!loaded && !loaded.legacyCommonJS);
    const previousMain = main;
    if (isMain) { main = module; module.id = '.'; }
    cache[filename] = module;
    addChild(parent, module);
    try {
      if (resolved.format === 'module') {
        if (loaded) pendingLoads.set(resolved.filename, loaded);
        requireNamespace(module, filename);
      } else if (loaded && resolved.format !== 'addon') {
        if (resolved.format === 'json') module.exports = JSON.parse(loaded.source.replace(/^\uFEFF/, ''));
        else if (resolved.format === 'commonjs') module._compile(loaded.source, filename);
        else throw error('ERR_UNKNOWN_MODULE_FORMAT', resolved.format, asURL(resolved.filename));
      } else {
        const basename = path.basename(filename);
        let ext = '.js';
        for (let index = basename.indexOf('.', 1); index !== -1; index = basename.indexOf('.', index + 1)) {
          const candidate = basename.slice(index);
          if (own(extensions, candidate)) { ext = candidate; break; }
        }
        if (resolved.ambiguous && ext === '.js') {
          try { extensions[ext](module, filename); }
          catch (cause) {
            // Only a file that does not compile as CommonJS can be a module.
            if (!(cause instanceof SyntaxError) || !host.detectModuleSyntax(cleanSource(text(filename)), filename)) throw cause;
            detectedModules.add(module);
            requireNamespace(module, filename);
          }
        } else extensions[ext](module, filename);
      }
      module.loaded = true;
      return module.exports;
    } catch (cause) {
      pendingLoads.delete(resolved.filename);
      delete cache[filename];
      if (isMain) main = previousMain;
      if (parent) {
        const index = parent.children.indexOf(module);
        if (index !== -1) parent.children.splice(index, 1);
      }
      throw cause;
    }
  }

  // The files that required one another down to parent, nearest first (Node's requireStack).
  function requireStack(parent) {
    const stack = [];
    const visited = new Set();
    for (let current = parent; current && !visited.has(current); current = current[kModuleParent]) {
      visited.add(current);
      if (current.filename) stack.push(current.filename);
    }
    return stack;
  }

  function cycleError(filename, parent) {
    const from = parent && parent.filename ? ` (from ${parent.filename})` : '';
    return error('ERR_REQUIRE_CYCLE_MODULE', `Cannot require() ES Module ${filesystemName(filename)} in a cycle.${from}`);
  }

  function asyncModuleError(filename, parent) {
    return error('ERR_REQUIRE_ASYNC_MODULE', filesystemName(filename), parent, undefined);
  }

  // Node's hint for a CommonJS global used in an ES module.
  function decorateModuleError(cause, filename) {
    if (cause === null || typeof cause !== 'object' || cause.name !== 'ReferenceError') return cause;
    const match = /^'?(require|module|exports|__filename|__dirname)'? is not defined$/.exec(cause.message);
    if (!match) return cause;
    let message = `${match[1]} is not defined in ES module scope`;
    if (match[1] === 'require') message += ', you can use import instead';
    const url = asURL(filename);
    if (url.startsWith('file:') && /\.js(\?[^#]*)?(#.*)?$/.test(url)) {
      const pkg = packageScope(filesystemName(url));
      if (pkg && pkg.data.type === 'module') message += `\nThis file is being treated as an ES module because it has a '.js' file extension and '${pkg.filename}' contains "type": "module". To treat it as a CommonJS script, rename it to use the '.cjs' file extension.`;
    }
    cause.message = message;
    return cause;
  }

  function requireModuleEnabled() {
    return typeof host.requireModule === 'function' && !host.requireModuleDisabled;
  }

  // Node's ERR_REQUIRE_ESM, for require() of an ES module under --no-experimental-require-module.
  function requireESMError(filename, parent) {
    const pkg = filename.endsWith('.mjs') ? null : packageScope(filename);
    return error('ERR_REQUIRE_ESM', filename, false, (parent && parent.filename) || null, pkg ? pkg.filename : null);
  }

  function requireNamespace(module, filename) {
    if (!requireModuleEnabled()) throw requireESMError(filename, module[kModuleParent]);
    let namespace;
    try { namespace = host.requireModule(filename); }
    catch (cause) {
      if (cause !== null && typeof cause === 'object' && cause.code === 'ERR_REQUIRE_ASYNC_MODULE') throw asyncModuleError(filename, module[kModuleParent]);
      if (cause !== null && typeof cause === 'object' && cause.code === 'ERR_REQUIRE_CYCLE_MODULE') throw cycleError(filename, module[kModuleParent]);
      throw decorateModuleError(cause, filename);
    }
    if (own(namespace, 'module.exports')) module.exports = namespace['module.exports'];
    else if (own(namespace, 'default') && !own(namespace, '__esModule')) {
      // As in Node, a facade module re-exports the namespace with __esModule added, so
      // that what require gives is still a module namespace with live bindings.
      const target = JSON.stringify(asURL(filename));
      module.exports = host.requireModule('data:text/javascript,' + encodeURIComponent(
        `export * from ${target}; export { default } from ${target}; export const __esModule = true;`));
    } else module.exports = namespace;
  }

  // The module.require tracing channel, once diagnostics_channel is loaded: no channel
  // has a subscriber before that.
  let requireTracing;
  function makeRequire(filename, parent, allowAsync = false) {
    function require(specifier) {
      const dc = host.diagnosticsChannel;
      if (dc !== undefined && (requireTracing ??= dc.tracingChannel('module.require')).hasSubscribers) {
        return requireTracing.traceSync(load, { __proto__: null, parentFilename: (parent || cache[filename])?.filename, id: specifier }, undefined, specifier);
      }
      return load(specifier);
    }
    function load(specifier) {
      probed = null;
      // Unlike the node: form, ordinary builtin names can be overridden through
      // require.cache, matching Node's documented builtin cache behavior.
      const resolved = resolve(specifier, parent || filename, 'require', undefined, undefined, false, allowAsync);
      if (!specifier.startsWith('node:') && own(cache, specifier) && resolved.filename === 'node:' + specifier && resolved.format === 'builtin' && !moduleMocks.has(resolved.filename)) return cache[specifier].exports;
      return loadResolved(resolved, parent || cache[filename], false, allowAsync);
    }
    require.resolve = (specifier, options) => {
      if (typeof specifier !== 'string') throw invalidArgType('request', 'string', specifier);
      const result = resolve(specifier, parent || filename, 'require', undefined, options, false, allowAsync);
      return result.format === 'builtin' && !specifier.startsWith('node:') && result.filename.startsWith('node:') ? result.filename.slice(5) : result.filename;
    };
    require.resolve.paths = (specifier) => {
      if (typeof specifier !== 'string') throw invalidArgType('request', 'string', specifier);
      if (builtinName(specifier) !== null) return null;
      if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) return [path.dirname(filename)];
      const current = parent || cache[filename];
      return (current && Array.isArray(current.paths) ? current.paths : modulePaths(path.dirname(filename))).concat(globalPaths);
    };
    require.cache = cache;
    require.extensions = extensions;
    Object.defineProperty(require, 'main', { enumerable: true, get: () => main });
    return require;
  }

  function requireFor(filename, parent, allowAsync = false) {
    filename = parentName(filename);
    return makeRequire(filename, parent === undefined ? cache[filename] : parent, allowAsync);
  }

  // resolved, when given, is resolveMain(filename) as the caller just got it.
  function runMain(filename, inputTypeSet = false, resolved = resolveMain(filename)) {
    if (hooks.active() || resolved.format === undefined || resolved.format.endsWith('-typescript')) {
      const loaded = loadSource(resolved, undefined, hooks.hasAsync(), 'require');
      resolved.format = loaded.format;
      pendingLoads.set(resolved.filename, loaded);
    }
    if (resolved.format === 'module') {
      if (inputTypeSet) {
        pendingLoads.delete(resolved.filename);
        throw error('ERR_INPUT_TYPE_NOT_ALLOWED');
      }
      if (typeof host.evaluateModule !== 'function') throw error('ERR_METHOD_NOT_IMPLEMENTED', 'evaluateModule');
      const loaded = loadESM(resolved.filename);
      return host.evaluateModule(loaded.source, loaded.filename, true);
    }
    return loadResolved(resolved, null, true, hooks.hasAsync());
  }

  // A heap image build runs a main script that requires a second file, then forgets
  // both, so that a start finds the code that loads a main script warm: its inline
  // caches filled and its shapes made. Nothing of either file stays in the loader.
  function warmMain(filename) {
    const modules = new Set(Object.keys(cache)), directories = new Set(packages.keys());
    const resolved = new Set(resolutions.keys()), previous = main;
    const scoped = new Set(scopes.keys()), looked = new Set(lookupPaths.keys()), reals = new Set(realPaths.keys());
    const parents = new Set(parentNames.keys()), founds = new Set(foundPaths.keys());
    try { runMain(filename); }
    finally {
      for (const key of Object.keys(cache)) if (!modules.has(key)) delete cache[key];
      for (const key of [...packages.keys()]) if (!directories.has(key)) packages.delete(key);
      for (const key of [...scopes.keys()]) if (!scoped.has(key)) scopes.delete(key);
      for (const key of [...lookupPaths.keys()]) if (!looked.has(key)) lookupPaths.delete(key);
      for (const key of [...realPaths.keys()]) if (!reals.has(key)) realPaths.delete(key);
      for (const key of [...parentNames.keys()]) if (!parents.has(key)) parentNames.delete(key);
      for (const key of [...foundPaths.keys()]) if (!founds.has(key)) foundPaths.delete(key);
      for (const key of [...resolutions.keys()]) if (!resolved.has(key)) resolutions.delete(key);
      main = previous;
      probed = null;
      regularFile = null;
    }
  }

  const builtinUpdates = new Map();
  Module.syncBuiltinESMExports = () => { for (const update of builtinUpdates.values()) update(); };

  const bridge = Object.freeze({
    mockExports(filename) {
      const mock = mockInstances.get(filename);
      if (!mock) throw error('ERR_INVALID_STATE', 'Module mock no longer exists');
      return mock.format === 'builtin' || mock.format === 'commonjs' || mock.format === 'commonjs-typescript'
        ? mockCommonJS(mock, mock.filename, null) : mock.exports;
    },
    startHookWorker() { return require('./hooks_worker').start(bridge, builtins.get('worker_threads')); },
    enterHookWorker: hooks.enterWorker,
    addAsyncHooks: hooks.addAsync,
    importConditions: () => conditions('import'),
    resolveHookAsync: (specifier, context) => hooks.asyncRun('resolve', specifier, context),
    loadHookAsync: (url, context) => hooks.asyncRun('load', url, context),
    register(filename, update) { builtinUpdates.set(filename, update); },
    get(filename) {
      const resolved = resolutions.get(filename) || (isBuiltinFile(filename)
        ? { filename, format: 'builtin' } : { filename, format: format(filename, 'require') });
      // As in Node, an imported JSON file shares require.cache only when its URL has no
      // query or hash: each of those is a module of its own.
      if (resolved.format === 'json' && /^file:[^?#]*[?#]/.test(resolved.filename)) {
        const loaded = pendingLoads.get(filename) || loadSource(resolved, undefined, hooks.hasAsync(), 'import');
        pendingLoads.delete(filename);
        return JSON.parse(String(loaded.source).replace(/^\uFEFF/, ''));
      }
      return loadResolved(resolved, null, false, hooks.hasAsync());
    },
  });

  function bridgeSource(filename, names, cjs) {
    let source = 'const value = globalThis.__silkModuleBridge.get(' + JSON.stringify(filename) + ');\nexport default value;\n';
    if (cjs) source += 'export { value as "module.exports" };\n';
    let index = 0;
    const updates = [];
    for (let i9 = 0, a9 = names; i9 < a9.length; i9++) { const name = a9[i9];
      if (name === 'default' || (cjs && name === 'module.exports')) continue;
      const local = 'export_' + index++;
      source += (cjs ? 'const ' : 'let ') + local + ' = value[' + JSON.stringify(name) + '];\nexport { ' + local + ' as ' + JSON.stringify(name) + ' };\n';
      if (!cjs) updates.push(local + ' = value[' + JSON.stringify(name) + '];');
    }
    if (!cjs && names.length) source += 'globalThis.__silkModuleBridge.register(' + JSON.stringify(filename) + ', () => {' + updates.join('') + '});\n';
    return source;
  }

  function commonJSNames(filename, visited, source) {
    const disk = filesystemName(filename);
    if (visited.has(disk)) return [];
    visited.add(disk);
    const scanned = analyzeExports(cleanSource(source === undefined ? text(disk) : source));
    const names = new Set(scanned.names);
    for (let i10 = 0, a10 = scanned.reexports; i10 < a10.length; i10++) { const specifier = a10[i10];
      let resolved;
      try { resolved = resolve(specifier, disk, 'require'); }
      catch (_) { continue; } // Resolution errors still surface during evaluation.
      let inherited = [];
      if (resolved.format === 'builtin') inherited = Object.keys(loadBuiltin(resolved.filename));
      else if (resolved.format === 'commonjs') inherited = commonJSNames(resolved.filename, visited);
      for (let i11 = 0, a11 = inherited; i11 < a11.length; i11++) { const name = a11[i11]; if (name !== 'default' && name !== 'module.exports') names.add(name); }
    }
    return Array.from(names);
  }

  function loadESM(filename, attributes) {
    if (host.reportDependency && (filename.startsWith('file:') || path.isAbsolute(filename))) host.reportDependency(filename);
    const mock = mockInstances.get(filename);
    if (mock) return mockESM(filename, mock);
    let resolved = resolutions.get(filename);
    if (!resolved) {
      let detected;
      if (filename.startsWith('data:')) detected = dataFormat(filename);
      else {
        // An unknown extension is reported by the default load step, after the hooks ran.
        try { detected = format(filename, 'import'); }
        catch (cause) { if (cause.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw cause; }
      }
      resolved = { filename, format: detected };
    }
    attributes = resolved.importAttributes || attributes || {};
    if (host.importText && attributes.type === 'text') resolved = { ...resolved, format: 'text' };
    const loaded = pendingLoads.get(filename) || loadSource(resolved, attributes);
    pendingLoads.delete(filename);
    resolved.format = loaded.format;
    return finishESM(resolved, loaded, attributes);
  }

  // Node's validateAttributes: the "type" each format needs, none for code formats, and
  // nothing checked for a format Node does not know.
  const implicitType = { builtin: true, commonjs: true, module: true, wasm: true, 'commonjs-typescript': true, 'module-typescript': true };
  // (Node's esm/assert.js) Formats Node does not map, such as text without
  // --experimental-import-text, take any attributes.
  function validateAttributes(kind, url, attributes) {
    for (let i12 = 0, a12 = Object.keys(attributes); i12 < a12.length; i12++) { const key = a12[i12];
      if (key !== 'type') throw error('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', key, attributes[key], url);
    }
    const expected = kind === 'json' ? 'json' : kind === 'text' && host.importText ? 'text' : own(implicitType, kind) ? null : undefined;
    if (expected === undefined) return;
    if (expected === null ? !own(attributes, 'type') : attributes.type === expected) return;
    if (expected !== null && !own(attributes, 'type')) throw error('ERR_IMPORT_ATTRIBUTE_MISSING', url, 'type', expected);
    const type = attributes.type;
    validateString(type, 'type');
    if (type === 'json' || (type === 'text' && host.importText)) throw error('ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', url, type);
    throw error('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', 'type', type, url);
  }
  function dataMime(url) {
    const match = /^data:([^/]+\/[^;,]+)/.exec(url);
    return match ? match[1] : url.slice(5, url.indexOf(','));
  }
  // An import request's attributes against what its module turned out to be: each request
  // is checked, also for a module an earlier request loaded.
  // Node's hint when import fails where require would have found a file.
  function commonJSHint(error, specifier, parent) {
    let found;
    try {
      if (specifier.startsWith('file://')) specifier = builtins.get('url').fileURLToPath(specifier);
      const from = parent.startsWith('file:') ? builtins.get('url').fileURLToPath(parent) : parent;
      if (!path.isAbsolute(from)) return;
      found = resolve(specifier, from, 'require').filename;
      if (!path.isAbsolute(found)) return;
      if (/^\.\.?(?:\/|$)/.test(specifier)) {
        // Relative between URL paths, so the hint is itself a valid specifier.
        const { pathToFileURL } = builtins.get('url');
        const parentURL = parent.startsWith('file:') ? parent : pathToFileURL(parent).href;
        found = path.posix.relative(parentURL.slice('file://'.length, parentURL.lastIndexOf('/')), pathToFileURL(found).pathname);
        if (!found.startsWith('../')) found = `./${found}`;
      } else if (!path.isAbsolute(specifier)) {
        const slash = specifier.indexOf('/');
        const pkg = slash === -1 ? specifier : specifier.slice(0, slash);
        const needle = `${path.sep}node_modules${path.sep}${pkg}${path.sep}`;
        const index = found.lastIndexOf(needle);
        found = index === -1 ? fileURL(found) : pkg + '/' + found.slice(index + needle.length).split(path.sep).map(encodeURIComponent).join('/');
      }
    } catch { return; }
    if (found && found !== specifier) error.message += `\nDid you mean to import ${JSON.stringify(found)}?`;
  }

  function resolveImport(specifier, parent, attributes) {
    let resolved;
    try { resolved = resolve(specifier, parent, 'import', attributes); }
    catch (error) {
      if ((error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') && typeof specifier === 'string' && typeof parent === 'string') {
        commonJSHint(error, specifier, parent);
      }
      throw error;
    }
    // --experimental-import-text: `with { type: 'text' }` asks for the text format
    // whatever the file is (Node's isExperimentalTextImport).
    if (host.importText && attributes && attributes.type === 'text') resolved = { ...resolved, format: 'text' };
    if (resolved.format && !hooks.active()) validateAttributes(resolved.format, asURL(resolved.filename), attributes || {});
    return resolved;
  }

  function finishESM(resolved, loaded, attributes) {
    let source;
    const substitute = substituteExports(resolved.filename);
    if (substitute !== undefined) {
      resolutions.set(resolved.filename, { filename: resolved.filename, format: 'commonjs' });
      source = bridgeSource(resolved.filename, Object.keys(substitute), true);
    }
    else if (resolved.format === 'module') source = cleanSource(loaded.source);
    else if (resolved.format === 'builtin') {
      pendingLoads.set(resolved.filename, loaded);
      source = bridgeSource(resolved.filename, Object.keys(loadBuiltin(resolved.filename)), false);
    }
    else if (resolved.format === 'json' || resolved.format === 'commonjs') {
      pendingLoads.set(resolved.filename, loaded);
      resolutions.set(resolved.filename, resolved);
      source = bridgeSource(resolved.filename, resolved.format === 'commonjs' ? commonJSNames(resolved.filename, new Set(), loaded.source) : [], resolved.format === 'commonjs');
    }
    else if (resolved.format === 'addon') throw error('ERR_UNKNOWN_FILE_EXTENSION', path.extname(resolved.filename), resolved.filename);
    // Node's text translator: the source, without a byte order mark, as the default export.
    else if (resolved.format === 'text') source = `export default ${JSON.stringify(sourceText(loaded.source).replace(/^\uFEFF/, ''))};`;
    else throw unknownFormat(resolved.format, path.isAbsolute(resolved.filename) ? fileURL(resolved.filename) : resolved.filename);
    return { source, format: resolved.format, filename: resolved.filename };
  }

  return { decorateModuleError, resolveImport, requireFor, runMain, defaultRunMain, warmMain, resolve, resolveMain, loadESM, cleanSource, prepareSource, bridge, Module, mockModule };
}

module.exports = { createLoader };
