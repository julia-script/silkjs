'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const keywords = 'await break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while with yield'.split(' ');
const identifier = /^[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*$/u;
function propertyNames(value) {
  const result = new Set();
  const seen = new Set();
  while (value != null) {
    value = Object(value);
    if (seen.has(value)) break;
    seen.add(value);
    for (const name of Object.getOwnPropertyNames(value)) if (identifier.test(name)) result.add(name);
    value = Object.getPrototypeOf(value);
  }
  return result;
}
function files(prefix, modules, repl) {
  const matches = new Set();
  const separator = prefix.lastIndexOf('/');
  const directory = separator < 0 ? '' : prefix.slice(0, separator + 1);
  const roots = !modules || prefix.startsWith('.') || path.isAbsolute(prefix) ? [process.cwd()] : repl.context.module.paths;
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(path.resolve(root, directory), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const name = directory + entry.name;
      if (!name.startsWith(prefix)) continue;
      if (entry.isDirectory()) {
        matches.add(name + '/');
        if (modules) {
          try { repl.context.require.resolve(name); matches.add(name); } catch {}
        }
      } else if (!modules) matches.add(name);
      else if (/\.(?:js|cjs|mjs|json|node)$/.test(name)) {
        matches.add(name);
        if (/\.(?:js|json|node)$/.test(name)) matches.add(name.replace(/\.(?:js|json|node)$/, ''));
      }
    }
  }
  if (modules) {
    for (const name of require('module').builtinModules) {
      for (const candidate of [name, name.startsWith('node:') ? name : 'node:' + name]) {
        if (candidate.startsWith(prefix)) matches.add(candidate);
      }
    }
  }
  return [[...matches].sort(), prefix];
}
function complete(line, callback) {
  let result;
  try {
    const command = /^\s*\.([^\s]*)$/.exec(line);
    const filename = /^\s*\.(?:load|save)\s+(.*)$/.exec(line);
    const request = /\brequire(?:\.resolve)?\s*\(\s*['"]([^'"\n]*)$/.exec(line);
    if (command) result = [Object.keys(this.commands).map(name => '.' + name).filter(name => name.startsWith('.' + command[1])).sort(), '.' + command[1]];
    else if (filename) result = files(filename[1], false, this);
    else if (request) result = files(request[1], true, this);
    else {
      const match = /(?:[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*\.)*[$\u200c\u200d_\p{ID_Continue}]*$/u.exec(line);
      const expression = match ? match[0] : '';
      const dot = expression.lastIndexOf('.');
      let candidates;
      if (dot >= 0) {
        const chain = expression.slice(0, dot).split('.');
        let value = this.useGlobal ? vm.runInThisContext(chain.shift()) : vm.runInContext(chain.shift(), this.context);
        for (const name of chain) {
          let object = value == null ? null : Object(value);
          let descriptor;
          while (object && !(descriptor = Object.getOwnPropertyDescriptor(object, name))) object = Object.getPrototypeOf(object);
          if (!descriptor || (!('value' in descriptor) && !this.allowBlockingCompletions)) { value = undefined; break; }
          value = 'value' in descriptor ? descriptor.value : descriptor.get?.call(value);
        }
        const prefix = expression.slice(0, dot + 1);
        candidates = [...propertyNames(value)].map(name => prefix + name);
      } else {
        candidates = [...new Set([...this._globalNames, ...propertyNames(this.context), ...this._bindings, ...keywords])];
      }
      result = [candidates.filter(name => name.startsWith(expression)).sort(), expression];
    }
  } catch { result = [[], line.match(/[^\s]*$/)[0]]; }
  callback(null, result);
}
module.exports = { complete };
