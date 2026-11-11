'use strict';

const { analyzeExports } = require('./cjs_exports');
const { createHooks } = require('./hooks');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const includesBuiltin = Function.prototype.call.bind(Array.prototype.includes);
const builtinPrefix = Function.prototype.call.bind(String.prototype.startsWith);
const builtinSlice = Function.prototype.call.bind(String.prototype.slice);

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
  const moduleStat = host.moduleStat || (filename => host.stat(filename, true));
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

  function error(code, message, properties) {
    const result = code === 'ERR_INVALID_ARG_TYPE' || code === 'ERR_INVALID_ARG_VALUE' || code === 'ERR_MISSING_ARGS' ? new TypeError(message) : new Error(message);
    result.code = code;
    if (properties) Object.assign(result, properties);
    return result;
  }

  function text(filename) {
    const bytes = host.readFile(filename);
    return typeof bytes === 'string' ? bytes : host.Buffer.from(bytes).toString('utf8');
  }

  function cleanSource(source) {
    if (source.charCodeAt(0) === 0xFEFF) source = source.slice(1);
    if (source.startsWith('#!')) {
      const newline = source.indexOf('\n');
      source = newline < 0 ? '' : '\n' + source.slice(newline + 1);
    }
    return source;
  }

  function stat(filename) {
    try { return moduleStat(filename); }
    catch (cause) {
      if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null;
      throw cause;
    }
  }

  function isFile(filename) {
    const info = stat(filename);
    return info !== null && info.isFile();
  }

  function isDirectory(filename) {
    const info = stat(filename);
    return info !== null && info.isDirectory();
  }

  function fileURL(filename) {
    let normalized = path.sep === '\\' ? filename.replace(/\\/g, '/') : filename;
    if (!normalized.startsWith('/')) normalized = '/' + normalized;
    return 'file://' + normalized.split('/').map(encodeURIComponent).join('/');
  }

  function fromFileURL(value) {
    const match = /^file:(?:\/\/([^/?#]*))?([^?#]*)([?#].*)?$/i.exec(value);
    if (!match) throw error('ERR_INVALID_URL', `Invalid URL: ${value}`, { input: value });
    if (match[1] && match[1].toLowerCase() !== 'localhost') {
      throw error('ERR_INVALID_FILE_URL_HOST', `File URL host must be "localhost" or empty: ${value}`);
    }
    if (/%2f|%5c/i.test(match[2])) throw error('ERR_INVALID_MODULE_SPECIFIER', `Invalid encoded separator in ${value}`);
    let filename;
    try { filename = decodeURIComponent(match[2]); }
    catch (_) { throw error('ERR_INVALID_URL', `Invalid URL: ${value}`, { input: value }); }
    if (filename.includes('\0')) throw error('ERR_INVALID_ARG_VALUE', 'File URL must not contain null bytes');
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
    return path.resolve(filesystemName(String(parent)));
  }

  function readPackage(directory) {
    const filename = path.join(directory, 'package.json');
    if (typeof host.checkModuleRead === 'function') host.checkModuleRead(filename);
    if (!isFile(filename)) return null;
    let data;
    try { data = JSON.parse(text(filename).replace(/^\uFEFF/, '')); }
    catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      throw error('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${filename}: ${cause.message}`, { path: filename, cause });
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) data = {};
    return { directory, filename, data };
  }

  function packageScope(filename) {
    let directory = path.dirname(filesystemName(filename));
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
    const result = [];
    directory = path.resolve(directory);
    for (;;) {
      if (path.basename(directory) !== 'node_modules') result.push(path.join(directory, 'node_modules'));
      const next = path.dirname(directory);
      if (next === directory) return result;
      directory = next;
    }
  }

  function builtinName(specifier) {
    if (builtinPrefix(specifier, 'node:')) {
      const name = builtinSlice(specifier, 5);
      if (!includesBuiltin(builtins.names(), name) && !includesBuiltin(builtins.names(), specifier)) {
        throw error('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${specifier}`);
      }
      return name;
    }
    return includesBuiltin(builtins.names(), specifier) && builtins.has(specifier) ? specifier : null;
  }

  function loadBuiltin(filename) {
    const name = builtinPrefix(filename, 'node:') ? builtinName(filename) : null;
    if (name === null) throw error('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${filename}`);
    return builtins.get(name);
  }

  function format(filename, mode) {
    if (filename.startsWith('node:')) return 'builtin';
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
      throw error('ERR_UNKNOWN_FILE_EXTENSION', `Unknown file extension "${ext}" for ${disk}`);
    }
    const pkg = ext === '.js' || mode === 'import' ? packageScope(disk) : null;
    if (pkg && pkg.data.type === 'module') return 'module';
    // Embedders may provide Node's syntax detection for ambiguous .js files.
    if ((!pkg || pkg.data.type !== 'commonjs') && typeof host.detectModuleSyntax === 'function' && host.detectModuleSyntax(cleanSource(text(disk)), disk)) return 'module';
    return 'commonjs';
  }

  function descriptor(filename, mode, suffix, isMain) {
    const preserve = isMain ? host.preserveSymlinksMain : host.preserveSymlinks;
    const canonical = preserve ? path.resolve(filename) : host.realpath(filename);
    const identity = suffix && mode === 'import' ? fileURL(canonical) + suffix : canonical;
    let kind;
    try { kind = format(identity, mode); }
    catch (cause) {
      if (!hooks.active() || cause.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw cause;
    }
    return { filename: identity, format: kind };
  }

  function missing(specifier, parent, mode) {
    if (mode === 'import') return error('ERR_MODULE_NOT_FOUND', `Cannot find module '${specifier}' imported from ${parent}`);
    const stack = [];
    let current = cache[parent];
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      stack.push(current.filename);
      current = current.parent;
    }
    if (!stack.length && parent) stack.push(parent);
    return error('MODULE_NOT_FOUND', `Cannot find module '${specifier}'` + (stack.length ? '\nRequire stack:\n- ' + stack.join('\n- ') : ''), { requireStack: stack });
  }

  function tryFile(filename) {
    return isFile(filename) ? filename : null;
  }

  function tryExtensions(filename) {
    for (const ext of Object.keys(extensions)) {
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
      throw error('MODULE_NOT_FOUND', `Cannot find module '${path.resolve(filename, pkg.data.main)}'. Please verify that the package.json has a valid "main" entry`, { path: pkg.filename, requestPath: filename });
    }
    return null;
  }

  function strictFile(filename, specifier, parent, mode, suffix, isMain) {
    if (isDirectory(filename)) {
      throw error(mode === 'import' ? 'ERR_UNSUPPORTED_DIR_IMPORT' : 'MODULE_NOT_FOUND', `Directory import '${filename}' is not supported resolving ${specifier} from ${parent}`, { url: fileURL(filename) });
    }
    if (!isFile(filename)) throw missing(specifier, parent, mode);
    return descriptor(filename, mode, suffix, isMain);
  }

  function invalidTarget(pkg, key, target) {
    return error('ERR_INVALID_PACKAGE_TARGET', `Invalid package target ${JSON.stringify(target)} defined for '${key}' in ${pkg.filename}`);
  }

  function invalidSegment(value) {
    let decoded;
    try { decoded = decodeURIComponent(value); }
    catch (_) { return true; }
    return /%2f|%5c/i.test(value) || decoded.split(/[\\/]/).some((part) => part === '.' || part === '..' || part.toLowerCase() === 'node_modules');
  }

  function packageTarget(pkg, target, replacement, key, pattern, internal, parent, mode, seen) {
    if (typeof target === 'string') {
      if (!target.startsWith('./')) {
        if (internal && !target.startsWith('../') && !target.startsWith('/') && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(target) && !target.startsWith('#')) {
          const request = pattern ? target.split('*').join(replacement) : target;
          return { external: request, parent: pkg.filename };
        }
        throw invalidTarget(pkg, key, target);
      }
      if (invalidSegment(target.slice(2))) throw invalidTarget(pkg, key, target);
      if (pattern && invalidSegment(replacement)) {
        throw error('ERR_INVALID_MODULE_SPECIFIER', `Invalid subpath '${replacement}' for '${key}' in ${pkg.filename}`);
      }
      const expanded = pattern ? target.split('*').join(replacement) : target;
      const url = fromFileURL(fileURL(pkg.directory) + '/' + expanded.slice(2));
      const relative = path.relative(pkg.directory, url.filename);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw invalidTarget(pkg, key, target);
      return { filename: url.filename, suffix: url.suffix };
    }
    if (Array.isArray(target)) {
      if (target.length === 0) return null;
      let last;
      for (const item of target) {
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
      for (const condition of keys) {
        if (/^(0|[1-9]\d*)$/.test(condition) && Number(condition) < 4294967295) {
          throw error('ERR_INVALID_PACKAGE_CONFIG', `Numeric condition key '${condition}' in ${pkg.filename}`);
        }
      }
      for (const condition of keys) {
        if (condition === 'default' || (activeConditions ? activeConditions.includes(condition) : condition === 'node' || condition === 'node-addons' || condition === mode || (condition === 'module-sync' && typeof host.requireModule === 'function') || (host.moduleConditions && host.moduleConditions.includes(condition)))) {
          const result = packageTarget(pkg, target[condition], replacement, key, pattern, internal, parent, mode, seen);
          if (result !== undefined) return result;
        }
      }
      return undefined;
    }
    if (target === null) return null;
    throw invalidTarget(pkg, key, target);
  }

  function packageMap(pkg, mapping, request, internal, parent, mode, seen, isMain) {
    if (!internal) {
      if (typeof mapping === 'string' || Array.isArray(mapping) || mapping === null) mapping = { '.': mapping };
      else if (mapping && typeof mapping === 'object') {
        const keys = Object.keys(mapping);
        const subpaths = keys.filter((key) => key.startsWith('.')).length;
        if (subpaths && subpaths !== keys.length) throw error('ERR_INVALID_PACKAGE_CONFIG', `Mixed condition and subpath keys in ${pkg.filename}`);
        if (!subpaths) mapping = { '.': mapping };
      } else throw invalidTarget(pkg, request, mapping);
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
        for (const key of Object.keys(mapping)) {
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
        return strictFile(targetResult.filename, request, parent, mode, targetResult.suffix, isMain);
      }
    }
    if (internal) throw error('ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${request}" is not defined in ${pkg.filename} imported from ${parent}`);
    throw error('ERR_PACKAGE_PATH_NOT_EXPORTED', request === '.' ? `No "exports" main defined in ${pkg.filename}` : `Package subpath '${request}' is not defined by "exports" in ${pkg.filename}`);
  }

  function packageName(specifier, parent) {
    const parts = specifier.split('/');
    const scoped = specifier.startsWith('@');
    if (!parts[0] || (scoped && (!parts[1] || parts[0].length === 1)) || specifier.includes('\\') || specifier.includes('%') || specifier.startsWith('.')) {
      throw error('ERR_INVALID_MODULE_SPECIFIER', `Invalid package name '${specifier}' imported from ${parent}`);
    }
    const count = scoped ? 2 : 1;
    return { name: parts.slice(0, count).join('/'), subpath: parts.length === count ? '.' : './' + parts.slice(count).join('/') };
  }

  function resolveInternal(specifier, parent, mode, options, seen, isMain) {
    if (typeof specifier !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'The "id" argument must be of type string');
    if (specifier.length === 0) throw error('ERR_INVALID_ARG_VALUE', 'The argument "id" must be a non-empty string');
    if (specifier.includes('\0')) throw error('ERR_INVALID_ARG_VALUE', 'Module specifiers must not contain null bytes');
    const builtin = builtinName(specifier);
    if (builtin !== null) return { filename: 'node:' + builtin, format: 'builtin' };
    if (options && own(options, 'paths') && options.paths !== undefined && !Array.isArray(options.paths)) {
      throw error('ERR_INVALID_ARG_VALUE', 'The property "options.paths" must be an array');
    }
    const parentModule = parent && typeof parent === 'object' ? parent : cache[parentName(parent)];
    parent = parentName(parent);
    const recursion = mode + '\0' + parent + '\0' + specifier;
    if (seen.has(recursion)) throw error('ERR_INVALID_PACKAGE_TARGET', `Circular package mapping for '${specifier}' in ${parent}`);
    seen.add(recursion);
    try {
      if (specifier.startsWith('#')) {
        if (specifier === '#' || specifier.startsWith('#/') || specifier.endsWith('/')) throw error('ERR_INVALID_MODULE_SPECIFIER', `Invalid package imports specifier '${specifier}'`);
        const pkg = packageScope(parent);
        if (!pkg) throw error('ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${specifier}" is not defined imported from ${parent}`);
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
          if (/%2f|%5c/i.test(requested)) throw error('ERR_INVALID_MODULE_SPECIFIER', `Invalid encoded separator in '${specifier}'`);
          try { requested = decodeURIComponent(requested); }
          catch (_) { throw error('ERR_INVALID_MODULE_SPECIFIER', `Invalid percent encoding in '${specifier}'`); }
        }
        const bases = options && Array.isArray(options.paths) ? options.paths : [path.dirname(parent)];
        for (const base of bases) {
          const candidate = path.resolve(base, requested);
          if (mode === 'import') return strictFile(candidate, specifier, parent, mode, suffix, isMain);
          const found = legacyFile(candidate, true, /[\\/]$/.test(specifier) || specifier === '.' || specifier === '..');
          if (found) return descriptor(found, mode, undefined, isMain);
        }
        throw missing(specifier, parent, mode);
      }
      if (mode === 'import' && /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier)) throw error('ERR_UNSUPPORTED_ESM_URL_SCHEME', `Only file: and node: URLs are supported; received '${specifier}'`);
      const parsed = packageName(specifier, parent);
      const scope = packageScope(parent);
      if (scope && scope.data.name === parsed.name && scope.data.exports !== undefined && scope.data.exports !== null) {
        return packageMap(scope, scope.data.exports, parsed.subpath, false, parent, mode, seen, isMain);
      }
      let search;
      if (options && options.paths !== undefined) {
        search = [];
        for (const base of options.paths) {
          const paths = modulePaths(base);
          if (mode === 'require') paths.push(...globalPaths);
          for (const entry of paths) if (!search.includes(entry)) search.push(entry);
        }
      } else {
        search = mode === 'require' && parentModule && Array.isArray(parentModule.paths) ? parentModule.paths : modulePaths(path.dirname(parent));
        if (mode === 'require') search = search.concat(globalPaths);
      }
      for (const directory of search) {
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
        if (mode === 'import' && isDirectory(root)) throw missing(specifier, parent, mode);
      }
      throw missing(specifier, parent, mode);
    } finally { seen.delete(recursion); }
  }

  function conditions(mode) {
    const values = mode === 'require' ? ['require', 'node', 'node-addons'] : ['node', 'import', 'node-addons'];
    if (typeof host.requireModule === 'function') values.push('module-sync');
    if (host.moduleConditions) values.push(...host.moduleConditions);
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
    if (context.conditions !== undefined && !Array.isArray(context.conditions)) throw error('ERR_INVALID_ARG_VALUE', 'The property "context.conditions" must be an array');
    const mode = context.conditions && context.conditions.includes('require') ? 'require' : 'import';
    if (specifier.startsWith('data:')) return { url: specifier, format: dataSource(specifier).format };
    const builtin = builtinName(specifier);
    if (builtin !== null) return { url: 'node:' + builtin, format: 'builtin' };
    if (context.parentURL && !context.parentURL.startsWith('file:') && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier) && !path.isAbsolute(specifier)) {
      throw error('ERR_UNSUPPORTED_RESOLVE_REQUEST', `Cannot resolve "${specifier}" from "${context.parentURL}": the parent URL is not a file URL`);
    }
    if (specifier.startsWith('file:') && mode === 'require') specifier = fromFileURL(specifier).filename;
    const previous = activeConditions;
    activeConditions = context.conditions;
    try {
      const result = resolveInternal(specifier, context.parentURL, mode, context.resolveOptions, new Set(), context.isMain);
      return { url: asURL(result.filename), format: result.format };
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
    const mock = moduleMocks.get(asURL(resolved.filename));
    if (!mock || mode !== 'import') return resolved;
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
      throw error('ERR_INVALID_ARG_VALUE', `Cannot mock module format '${resolved.format}'`);
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

  function dataSource(url) {
    const match = /^data:([^,]*),(.*)$/s.exec(url);
    if (!match) throw error('ERR_INVALID_URL', `Invalid URL: ${url}`);
    const mime = match[1].split(';')[0];
    let kind;
    if (mime === 'text/javascript' || mime === 'application/javascript') kind = 'module';
    else if (mime === 'application/json') kind = 'json';
    else throw error('ERR_UNKNOWN_MODULE_FORMAT', `Unknown module format: ${mime}`);
    return { format: kind, source: /;base64$/i.test(match[1])
      ? host.Buffer.from(match[2], 'base64').toString('utf8') : decodeURIComponent(match[2]) };
  }

  function defaultLoad(url, context) {
    const data = url.startsWith('data:') ? dataSource(url) : undefined;
    let kind = context.format || (data ? data.format : format(url, context.conditions && context.conditions.includes('require') ? 'require' : 'import'));
    if (!context.conditions || !context.conditions.includes('require')) validateAttributes(kind, url, context.importAttributes || {});
    if (data) return { ...data, format: kind };
    if (kind === 'builtin' || kind === 'addon') return { format: kind, source: null };
    // Node's async default loader leaves CJS execution to the legacy loader.
    // A hook that supplies source opts hook-thread CJS into hook-aware requires.
    if (kind === 'commonjs' && hooks.inWorker()) return { format: kind, source: null };
    if (!url.startsWith('file:')) throw error('ERR_UNSUPPORTED_ESM_URL_SCHEME', `Only file:, data:, and node: URLs are supported; received '${url}'`);
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
        else throw error('ERR_INVALID_RETURN_PROPERTY_VALUE', `Expected source from load hook for ${url}`);
      }
      const prepared = prepareSource(source, url, loaded.format);
      return { ...loaded, ...prepared, filename: resolved.filename, url, legacyCommonJS };
    } finally {
      sourceLoadActive = previousActive;
      strippedSource = previousSource;
    }
  }

  function findPackageJSON(specifier, base = 'data:') {
    if (arguments.length === 0) throw error('ERR_MISSING_ARGS', 'The "specifier" argument must be specified');
    try { specifier = `${specifier}`; }
    catch (_) { throw error('ERR_INVALID_ARG_TYPE', 'The "specifier" argument must be of type string'); }
    const { URL, fileURLToPath, pathToFileURL } = builtins.get('url');
    let parentURL = base;
    if (!(base instanceof URL)) {
      if (typeof base !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'The "base" argument must be of type string');
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
        throw error('ERR_UNSUPPORTED_RESOLVE_REQUEST', `Failed to resolve module specifier "${specifier}" from "${parentURL.href}": Invalid relative URL or base scheme is not hierarchical.`);
      }
    }
    if (/%2f|%5c/i.test(target.pathname) && target.protocol === 'file:') {
      throw error('ERR_INVALID_MODULE_SPECIFIER', `Invalid encoded separator in ${target.href}`);
    }
    let filename = fileURLToPath(target);
    if (!isDirectory(filename)) {
      if (!isFile(filename)) throw missing(specifier, parentURL.href, 'import');
      if (!host.preserveSymlinks) filename = host.realpath(filename);
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
      this.parent = parent;
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
      if (this.loaded) throw error('ERR_ASSERTION', 'Module is already loaded');
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
  Module._resolveFilename = (request, parent, isMain, options) => {
    const result = resolve(request, parent, 'require', undefined, options, !!isMain, !!parent && moduleAsyncModes.get(parent) === true);
    return result.format === 'builtin' && !request.startsWith('node:') ? result.filename.slice(5) : result.filename;
  };
  Module._load = (request, parent, isMain) => {
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
    if (typeof filename !== 'string' || (!filename.startsWith('file:') && !path.isAbsolute(filename))) throw error('ERR_INVALID_ARG_VALUE', 'The argument must be a file URL or absolute path');
    return requireFor(filename, undefined, false);
  };
  Module.isBuiltin = name => typeof name === 'string' && (includesBuiltin(builtins.names(), name) ||
    (builtinPrefix(name, 'node:') && includesBuiltin(builtins.names(), builtinSlice(name, 5))));
  Object.defineProperty(Module, 'builtinModules', { enumerable: true, get: () => builtins.names() });
  Module.runMain = () => runMain(process.argv[1]);
  function makeModule(filename, parent) {
    const module = new Module(filename, parent || null);
    module.filename = filename;
    return module;
  }

  extensions['.js'] = (module, filename) => module._compile(text(filename), filename);
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
    if (typeof host.loadAddon !== 'function') throw error('ERR_DLOPEN_FAILED', `Native addon loading is not available for '${filename}'`);
    host.loadAddon(filename, module);
  };

  function loadResolved(resolved, parent, isMain, allowAsync = false) {
    const mock = moduleMocks.get(asURL(resolved.filename));
    if (mock) return mockCommonJS(mock, filesystemName(resolved.filename), parent);
    if (resolved.format === 'builtin' && !hooks.active(allowAsync)) return loadBuiltin(resolved.filename);
    const filename = filesystemName(resolved.filename);
    if (host.reportDependency && path.isAbsolute(filename)) host.reportDependency(filename);
    if (own(cache, filename)) {
      if (resolved.format === 'module' && !cache[filename].loaded) {
        throw error('ERR_REQUIRE_CYCLE_MODULE', `Cannot require() ES Module ${filename} in a cycle`);
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
        if (typeof host.requireModule !== 'function') throw error('ERR_REQUIRE_ESM', `require() of ES Module ${filename} needs the native synchronous module evaluation hook`);
        if (loaded) pendingLoads.set(resolved.filename, loaded);
        const namespace = host.requireModule(filename);
        if (own(namespace, 'module.exports')) module.exports = namespace['module.exports'];
        else if (own(namespace, 'default') && !own(namespace, '__esModule')) {
          const facade = Object.create(null);
          for (const key of Object.keys(namespace)) Object.defineProperty(facade, key, { enumerable: true, get: () => namespace[key] });
          Object.defineProperty(facade, '__esModule', { enumerable: true, value: true });
          Object.defineProperty(facade, Symbol.toStringTag, { value: 'Module' });
          module.exports = Object.preventExtensions(facade);
        } else module.exports = namespace;
      } else if (loaded && resolved.format !== 'addon') {
        if (resolved.format === 'json') module.exports = JSON.parse(loaded.source.replace(/^\uFEFF/, ''));
        else if (resolved.format === 'commonjs') module._compile(loaded.source, filename);
        else throw error('ERR_UNKNOWN_MODULE_FORMAT', `Unknown module format: ${resolved.format}`);
      } else {
        const basename = path.basename(filename);
        let ext = '.js';
        for (let index = basename.indexOf('.', 1); index !== -1; index = basename.indexOf('.', index + 1)) {
          const candidate = basename.slice(index);
          if (own(extensions, candidate)) { ext = candidate; break; }
        }
        extensions[ext](module, filename);
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

  function makeRequire(filename, parent, allowAsync = false) {
    function require(specifier) {
      // Unlike the node: form, ordinary builtin names can be overridden through
      // require.cache, matching Node's documented builtin cache behavior.
      const resolved = resolve(specifier, parent || filename, 'require', undefined, undefined, false, allowAsync);
      if (!specifier.startsWith('node:') && own(cache, specifier) && resolved.filename === 'node:' + specifier && resolved.format === 'builtin' && !moduleMocks.has(resolved.filename)) return cache[specifier].exports;
      return loadResolved(resolved, parent || cache[filename], false, allowAsync);
    }
    require.resolve = (specifier, options) => {
      const result = resolve(specifier, parent || filename, 'require', undefined, options, false, allowAsync);
      return result.format === 'builtin' && !specifier.startsWith('node:') ? result.filename.slice(5) : result.filename;
    };
    require.resolve.paths = (specifier) => {
      if (typeof specifier !== 'string') throw error('ERR_INVALID_ARG_TYPE', 'The "request" argument must be of type string');
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

  function runMain(filename, inputTypeSet = false) {
    const resolved = resolveMain(filename);
    if (hooks.active() || resolved.format === undefined || resolved.format.endsWith('-typescript')) {
      const loaded = loadSource(resolved, undefined, hooks.hasAsync(), 'require');
      resolved.format = loaded.format;
      pendingLoads.set(resolved.filename, loaded);
    }
    if (resolved.format === 'module') {
      if (inputTypeSet) {
        pendingLoads.delete(resolved.filename);
        throw error('ERR_INPUT_TYPE_NOT_ALLOWED', '--input-type can only be used with string input via --eval, --print, or STDIN');
      }
      if (typeof host.evaluateModule !== 'function') throw error('ERR_REQUIRE_ESM', 'Native ES module evaluation is not available');
      const loaded = loadESM(resolved.filename);
      return host.evaluateModule(loaded.source, loaded.filename, true);
    }
    return loadResolved(resolved, null, true, hooks.hasAsync());
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
      const resolved = resolutions.get(filename) || (filename.startsWith('node:')
        ? { filename, format: 'builtin' } : { filename, format: format(filename, 'require') });
      return loadResolved(resolved, null, false, hooks.hasAsync());
    },
  });

  function bridgeSource(filename, names, cjs) {
    let source = 'const value = globalThis.__silkModuleBridge.get(' + JSON.stringify(filename) + ');\nexport default value;\n';
    if (cjs) source += 'export { value as "module.exports" };\n';
    let index = 0;
    const updates = [];
    for (const name of names) {
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
    for (const specifier of scanned.reexports) {
      let resolved;
      try { resolved = resolve(specifier, disk, 'require'); }
      catch (_) { continue; } // Resolution errors still surface during evaluation.
      let inherited = [];
      if (resolved.format === 'builtin') inherited = Object.keys(loadBuiltin(resolved.filename));
      else if (resolved.format === 'commonjs') inherited = commonJSNames(resolved.filename, visited);
      for (const name of inherited) if (name !== 'default' && name !== 'module.exports') names.add(name);
    }
    return Array.from(names);
  }

  function loadESM(filename, attributes) {
    if (host.reportDependency && (filename.startsWith('file:') || path.isAbsolute(filename))) host.reportDependency(filename);
    const mock = mockInstances.get(filename);
    if (mock) return mockESM(filename, mock);
    const resolved = resolutions.get(filename) || { filename,
      format: filename.startsWith('data:') ? dataSource(filename).format : format(filename, 'import') };
    attributes = resolved.importAttributes || attributes || {};
    const loaded = pendingLoads.get(filename) || loadSource(resolved, attributes);
    pendingLoads.delete(filename);
    resolved.format = loaded.format;
    return finishESM(resolved, loaded, attributes);
  }

  function validateAttributes(kind, url, attributes) {
    for (const key of Object.keys(attributes)) {
      if (key !== 'type') throw error('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "${key}" with value "${attributes[key]}" is not supported`);
    }
    if (kind === 'json') {
      if (!own(attributes, 'type')) throw error('ERR_IMPORT_ATTRIBUTE_MISSING', `Module "${url}" needs an import attribute of "type: json"`);
      if (attributes.type !== 'json') throw error('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "type" with value "${attributes.type}" is not supported`);
    } else if (own(attributes, 'type')) {
      if (attributes.type === 'json') throw error('ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', `Module "${url}" is not of type "json"`);
      throw error('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "type" with value "${attributes.type}" is not supported`);
    }
  }

  function finishESM(resolved, loaded, attributes) {
    let source;
    if (resolved.format === 'module') source = cleanSource(loaded.source);
    else if (resolved.format === 'builtin') {
      pendingLoads.set(resolved.filename, loaded);
      source = bridgeSource(resolved.filename, Object.keys(loadBuiltin(resolved.filename)), false);
    }
    else if (resolved.format === 'json' || resolved.format === 'commonjs') {
      pendingLoads.set(resolved.filename, loaded);
      resolutions.set(resolved.filename, resolved);
      source = bridgeSource(resolved.filename, resolved.format === 'commonjs' ? commonJSNames(resolved.filename, new Set(), loaded.source) : [], resolved.format === 'commonjs');
    }
    else throw error('ERR_UNKNOWN_FILE_EXTENSION', `Native addons cannot be imported directly: ${resolved.filename}`);
    return { source, format: resolved.format, filename: resolved.filename };
  }

  return { requireFor, runMain, resolve, resolveMain, loadESM, cleanSource, prepareSource, bridge, Module, mockModule };
}

module.exports = { createLoader };
