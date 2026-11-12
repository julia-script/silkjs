// SourceMap decoding follows Node.js / V8's SourceMap V3 implementation.
// Copyright 2013 the V8 project authors. Copyright (C) 2012 Google Inc.
// All rights reserved.
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
// * Redistributions of source code must retain the above copyright notice,
//   this list of conditions and the following disclaimer.
// * Redistributions in binary form must reproduce the above copyright notice,
//   this list of conditions and the following disclaimer in the documentation
//   and/or other materials provided with the distribution.
// * Neither the name of Google Inc. nor the names of its contributors may be
//   used to endorse or promote products derived from this software without
//   specific prior written permission.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
'use strict';

const { validateObject, validateBoolean, validateString } = require('internal/path_events/support');
const emptyOptions = Object.freeze(Object.create(null));
const base64Digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64Values = Object.create(null);
for (let i = 0; i < base64Digits.length; i++) base64Values[base64Digits[i]] = i;

function clonePayload(payload) {
  validateObject(payload, 'payload');
  const copy = { ...payload };
  for (const key of Object.keys(copy)) {
    if (Array.isArray(copy[key])) copy[key] = copy[key].slice();
  }
  return copy;
}

// Node's SourceMap keeps its decoded mappings under this key; coverage reads them.
const kMappings = Symbol('kMappings');

class SourceMap {
  #payload;
  #mappings = [];
  #lineLengths;

  constructor(payload, { lineLengths } = emptyOptions) {
    this.#payload = clonePayload(payload);
    this.#parsePayload(this.#payload, 0, 0);
    this.#mappings.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // Node retains the supplied array, but returns a fresh slice on every get.
    if (Array.isArray(lineLengths) && lineLengths.length) this.#lineLengths = lineLengths;
  }

  get payload() { return clonePayload(this.#payload); }
  get [kMappings]() { return this.#mappings; }
  get lineLengths() { return this.#lineLengths?.slice(); }

  #parsePayload(payload, line, column) {
    if (payload.sections) {
      for (const section of payload.sections) {
        this.#parseMap(section.map, section.offset.line, section.offset.column);
      }
    } else {
      this.#parseMap(payload, line, column);
    }
  }

  #parseMap(map, line, column) {
    const sources = [];
    for (let i = 0; i < map.sources.length; i++) sources.push(map.sources[i]);
    const text = map.mappings;
    let cursor = 0;
    let sourceIndex = 0;
    let originalLine = 0;
    let originalColumn = 0;
    let nameIndex = 0;
    let source = sources[0];
    const peek = () => String.prototype.charAt.call(text, cursor);
    const decode = () => {
      let value = 0;
      let shift = 0;
      let digit;
      do {
        digit = base64Values[String.prototype.charAt.call(text, cursor++)];
        value += (digit & 31) << shift;
        shift += 5;
      } while (digit & 32);
      const negative = value & 1;
      value >>>= 1;
      return negative ? -value | (1 << 31) : value;
    };
    const separator = value => value === ',' || value === ';';
    for (;;) {
      if (peek() === ',') cursor++;
      else {
        while (peek() === ';') { line++; column = 0; cursor++; }
        if (!(cursor < text.length)) break;
      }
      column += decode();
      if (separator(peek())) {
        this.#mappings.push([line, column]);
        continue;
      }
      const sourceDelta = decode();
      if (sourceDelta) { sourceIndex += sourceDelta; source = sources[sourceIndex]; }
      originalLine += decode();
      originalColumn += decode();
      let name;
      // EOF is deliberately not a separator: this is observable in Node 24,
      // including its terminal four-field segment's names[0] behavior.
      if (!separator(peek())) { nameIndex += decode(); name = map.names?.[nameIndex]; }
      this.#mappings.push([line, column, source, originalLine, originalColumn, name]);
    }
  }

  findEntry(lineOffset, columnOffset) {
    let first = 0;
    let count = this.#mappings.length;
    while (count > 1) {
      const step = count >> 1;
      const middle = first + step;
      const entry = this.#mappings[middle];
      if (lineOffset < entry[0] || (lineOffset === entry[0] && columnOffset < entry[1])) count = step;
      else { first = middle; count -= step; }
    }
    const entry = this.#mappings[first];
    if (!entry || (!first && (lineOffset < entry[0] ||
        (lineOffset === entry[0] && columnOffset < entry[1])))) return {};
    return {
      generatedLine: entry[0], generatedColumn: entry[1],
      originalSource: entry[2], originalLine: entry[3], originalColumn: entry[4], name: entry[5],
    };
  }

  findOrigin(lineNumber, columnNumber) {
    const entry = this.findEntry(lineNumber - 1, columnNumber - 1);
    if (entry.originalSource === undefined || entry.originalLine === undefined ||
        entry.originalColumn === undefined || entry.generatedLine === undefined ||
        entry.generatedColumn === undefined) return {};
    return {
      name: entry.name, fileName: entry.originalSource,
      lineNumber: entry.originalLine + (lineNumber - entry.generatedLine),
      columnNumber: entry.originalColumn + (columnNumber - entry.generatedColumn),
    };
  }
}

let support = Object.freeze({ __proto__: null, enabled: false, nodeModules: false, generatedCode: false });
function getSourceMapsSupport() { return support; }
function setSourceMapsSupport(enabled, options = emptyOptions) {
  validateBoolean(enabled, 'enabled');
  validateObject(options, 'options');
  const { nodeModules = false, generatedCode = false } = options;
  validateBoolean(nodeModules, 'options.nodeModules');
  validateBoolean(generatedCode, 'options.generatedCode');
  support = Object.freeze({ __proto__: null, enabled, nodeModules, generatedCode });
}

const moduleEntries = new Map();
const generatedEntries = new Map();
const scriptEntries = new Map();
const ownerEntries = new WeakMap();
const registrations = new WeakMap();
const finalizer = new FinalizationRegistry(removeRecord);
const leadingProtocol = /^\w+:\/\//;
const nodeModules = /^(?:.*)[\\/]node_modules[\\/]/;

const generatedSourceURL = /\/[*/]#\s+sourceURL=([^\s]+)/g;
const generatedMapURL = /\/[*/]#\s+sourceMappingURL=([^\s]+)/g;
function generatedComment(source, pattern) {
  pattern.lastIndex = 0;
  let result, match;
  while ((match = pattern.exec(source))) result = match[1];
  return result;
}
function lookupURL(filename) {
  if (typeof filename !== 'string' || filename.startsWith('node:')) return undefined;
  return leadingProtocol.test(filename) ? filename : require('url').pathToFileURL(filename).href;
}

function referrerURL(filename) {
  if (typeof filename !== 'string' || filename.startsWith('node:')) return undefined;
  if (require('path').isAbsolute(filename)) return require('url').pathToFileURL(filename).href;
  try { new URL(filename); return filename; } catch { return undefined; }
}

function removeRecord(record) {
  const cache = record.generated ? generatedEntries : moduleEntries;
  for (const key of record.keys) if (cache.get(key) === record) cache.delete(key);
  if (record.scriptId !== undefined && scriptEntries.get(record.scriptId) === record) {
    scriptEntries.delete(record.scriptId);
  }
}

function dereference(record) {
  if (!record) return undefined;
  const entry = record.weak ? record.entry.deref() : record.entry;
  if (!entry) removeRecord(record);
  return entry;
}

// Registration never evaluates source. Call after successful compilation with
// the actual compiled text (after TypeScript transformation, before any CJS
// wrapper). Modules use lexer-confirmed native directives. Generated eval uses
// Node's textual extraction, including matches inside templates/block comments.
// filename must be absolute; generated eval uses its extracted sourceURL.
//
// metadata.owner weakly owns the map (CJS Module, ESM/VM script object). Without
// an owner, the caller owns the returned token's lifetime and must unregister
// when the native script is destroyed; generated eval can remain realm-owned,
// as in Node. scriptId indexes a real native identity, not a synthesized name.
function registerSource(filename, source, metadata = emptyOptions) {
  validateString(source, 'source');
  validateObject(metadata, 'metadata');
  const coverage = process.env.NODE_V8_COVERAGE;
  if (!support.enabled && !coverage) return undefined;
  const generated = metadata.generated === true;
  const mapURL = generated ? generatedComment(source, generatedMapURL) : metadata.sourceMapURL;
  if (typeof mapURL !== 'string') return undefined;
  let sourceURL = generated ? generatedComment(source, generatedSourceURL) : metadata.sourceURL;
  let url;
  try {
    // A relative sourceURL magic comment is relative to cwd, not the script.
    if (typeof sourceURL === 'string') sourceURL = lookupURL(sourceURL);
    else sourceURL = undefined;
    url = referrerURL(filename) || (generated ? sourceURL : undefined);
  } catch { return undefined; }
  if (!url || (!support.nodeModules && nodeModules.test(url))) return undefined;
  // Node 24 records generatedCode in its support object but does not gate its
  // generated-source cache with it; enabled controls capture for both kinds.
  const lengths = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 10 || c === 0x2028 || c === 0x2029) { lengths.push(i - start); start = i + 1; }
  }
  lengths.push(source.length - start);
  const entry = { filename: url, sourceMapURL: mapURL, lineLengths: lengths, data: undefined, sourceMap: undefined };
  if (coverage) {
    try { entry.data = loadData(entry); } catch { entry.data = null; }
  }
  const owner = metadata.owner;
  const weak = owner !== undefined && owner !== null;
  const keys = generated || !sourceURL || sourceURL === url ? [url] : [url, sourceURL];
  const scriptId = metadata.scriptId === undefined ? undefined : String(metadata.scriptId);
  const record = { keys, generated, scriptId, weak, entry: weak ? new WeakRef(entry) : entry };
  if (weak) {
    let entries = ownerEntries.get(owner);
    if (!entries) { entries = new Set(); ownerEntries.set(owner, entries); }
    entries.add(entry);
    finalizer.register(owner, record, record);
  }
  const cache = generated ? generatedEntries : moduleEntries;
  for (const key of keys) cache.set(key, record);
  if (scriptId !== undefined) scriptEntries.set(scriptId, record);
  const token = Object.create(null);
  registrations.set(token, { record, owner: weak ? new WeakRef(owner) : undefined });
  return token;
}

function unregisterSource(token) {
  const registration = registrations.get(token);
  if (!registration) return;
  registrations.delete(token);
  const { record, owner } = registration;
  const target = owner?.deref();
  if (target) ownerEntries.get(target)?.delete(dereference(record));
  finalizer.unregister(record);
  removeRecord(record);
}

function sourcesToAbsolute(baseURL, payload) {
  // Node's constructor supports indexed sections and preserves raw sources.
  // Its registry loader accepts flat maps only and resolves their sources.
  const { isAbsolute } = require('path');
  const { pathToFileURL } = require('url');
  payload.sources = payload.sources.map(source => {
    source = (payload.sourceRoot || '') + source;
    return isAbsolute(source) ? pathToFileURL(source).href : new URL(source, baseURL).href;
  });
  payload.sourceRoot = '';
  return payload;
}

function loadData(entry) {
  const { filename, sourceMapURL } = entry;
  let url;
  try { url = new URL(sourceMapURL); } catch {}
  if (url) {
    // Node 24 accepts data URLs here, not absolute file: or network URLs.
    if (url.protocol !== 'data:') return null;
    const [format, data] = url.pathname.split(',', 2);
    const parts = format.split(';');
    if (parts[0] !== 'application/json') return null;
    const text = parts[parts.length - 1] === 'base64'
      ? require('buffer').Buffer.from(data, 'base64').toString('utf8') : data;
    return sourcesToAbsolute(filename, JSON.parse(text));
  }
  url = new URL(sourceMapURL, filename);
  // Never fetch network maps or section sources; fileURLToPath enforces this.
  const path = require('url').fileURLToPath(url);
  return sourcesToAbsolute(url, JSON.parse(require('fs').readFileSync(path, 'utf8')));
}

function sourceMapForEntry(entry) {
  if (!entry) return undefined;
  try {
    if (entry.data === undefined) entry.data = loadData(entry);
    if (entry.data === null) return undefined;
    if (entry.sourceMap === undefined) entry.sourceMap = new SourceMap(entry.data, { lineLengths: entry.lineLengths });
    return entry.sourceMap;
  } catch {
    // Invalid/unreadable maps must never turn a successful module load or stack
    // capture into an exception. Like Node, cache the failed load, not fake data.
    entry.data = null;
    return undefined;
  }
}

function findSourceMap(filename) {
  if (typeof filename !== 'string' || filename.startsWith('node:') ||
      (!support.nodeModules && nodeModules.test(filename))) return undefined;
  try {
    const key = lookupURL(filename);
    return sourceMapForEntry(dereference(moduleEntries.get(key)) || dereference(generatedEntries.get(key)));
  } catch { return undefined; }
}

// Accepts structured, 1-based engine positions only. No stack text is parsed.
// kind='callsite' is the exact util.getCallSites reconstructed shape; kind='stack'
// preserves native flags/identity for the caller's stack serializer. Mapping is
// explicit: callers decide whether support.enabled or the util option enables it.
// Enclosing function and caller positions are optional *native* metadata used
// for Node's stack name recovery; the current segment's name is not a substitute.
function mapPosition(frame, options = emptyOptions) {
  let map;
  if (frame.scriptId !== undefined) {
    const entry = dereference(scriptEntries.get(String(frame.scriptId)));
    if (entry && (support.nodeModules || !nodeModules.test(entry.filename))) map = sourceMapForEntry(entry);
  }
  map ||= findSourceMap(frame.scriptName);
  if (!map) return frame;
  const entry = map.findEntry(frame.lineNumber - 1, frame.columnNumber - 1);
  if (!entry.originalSource || entry.originalLine === undefined || entry.originalColumn === undefined) return frame;
  if (options.kind === 'stack') {
    let name;
    if (frame.enclosingLineNumber !== undefined && frame.enclosingColumnNumber !== undefined) {
      name = map.findEntry(frame.enclosingLineNumber - 1, frame.enclosingColumnNumber - 1).name;
    }
    const caller = options.caller;
    if (!name && caller && frame.scriptName === caller.scriptName) {
      name = map.findEntry(caller.lineNumber - 1, caller.columnNumber - 1).name;
    }
    const scriptName = entry.originalSource.startsWith('file://')
      ? require('url').fileURLToPath(entry.originalSource) : entry.originalSource;
    return { ...frame, functionName: name || frame.functionName, scriptName,
      lineNumber: entry.originalLine + 1, column: entry.originalColumn + 1, columnNumber: entry.originalColumn + 1 };
  }
  return { __proto__: null, functionName: entry.name || frame.functionName,
    scriptName: entry.originalSource, lineNumber: entry.originalLine + 1,
    column: entry.originalColumn + 1, columnNumber: entry.originalColumn + 1 };
}

// sourceMapCacheToObject of Node's lib/internal/source_map/source_map_cache.js: the
// module maps a NODE_V8_COVERAGE file carries as its "source-map-cache".
function sourceMapCacheToObject() {
  if (moduleEntries.size === 0) return undefined;
  const obj = { __proto__: null };
  for (const [key, record] of moduleEntries) {
    const entry = dereference(record);
    if (!entry) continue;
    const data = entry.data ?? null;
    // The map URL is kept only when its data was not read.
    obj[key] = { __proto__: null, lineLengths: entry.lineLengths, data, url: data ? null : entry.sourceMapURL };
  }
  return obj;
}

// source_map_cache.js getOriginalSource: the map's sourcesContent, else the file.
function originalSourceText(payload, originalSourcePath) {
  const index = payload.sources.indexOf(originalSourcePath);
  if (payload.sourcesContent?.[index]) return payload.sourcesContent[index];
  if (!originalSourcePath.startsWith('file://')) return undefined;
  try { return require('fs').readFileSync(require('url').fileURLToPath(originalSourcePath), 'utf8'); } catch { return undefined; }
}

// prepare_stack_trace.js getSourceMapErrorSource and getErrorSource: the arrow of
// an exception at fileName:lineNumber (1-based) and columnNumber (0-based), in the
// original source, which node_errors.cc GetErrorSource uses under --enable-source-maps.
function errorSource(fileName, lineNumber, columnNumber) {
  const sm = findSourceMap(fileName);
  if (sm === undefined) return undefined;
  const { originalLine, originalColumn, originalSource } = sm.findEntry(lineNumber - 1, columnNumber);
  if (typeof originalSource !== 'string') return undefined;
  const source = originalSourceText(sm.payload, originalSource);
  if (typeof source !== 'string') return undefined;
  const line = source.split(/\r?\n/, originalLine + 1)[originalLine];
  if (!line) return undefined;
  const path = originalSource.startsWith('file://') ? require('url').fileURLToPath(originalSource) : originalSource;
  const { getStringWidth } = require('internal/util/inspect');
  let prefix = '';
  for (const character of line.slice(0, originalColumn + 1)) {
    prefix += character === '\t' ? '\t' : ' '.repeat(getStringWidth(character));
  }
  prefix = prefix.slice(0, -1);
  return `${path}:${originalLine + 1}\n${line}\n${prefix}^\n`;
}

module.exports = {
  kMappings, sourceMapCacheToObject, errorSource,
  SourceMap, findSourceMap, getSourceMapsSupport, setSourceMapsSupport,
  registerSource, unregisterSource, mapPosition,
};
