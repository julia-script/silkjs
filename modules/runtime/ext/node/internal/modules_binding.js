'use strict';

// internalBinding('modules'): node_modules.cc's package.json reader over the
// loader's own reads, which keep every package.json read once and only the fields
// resolution reads. A package comes back serialized as the binding serializes it:
// [name, main, type, imports, exports, filePath], with imports and exports as JSON
// text (a string target as itself) and type 'none' when the file names none.
// Copyright Node.js contributors. All rights reserved. MIT license (see
// vendor/node-api/LICENSE).

const host = require('internal/host');
const path = require('path');

function serialize(pkg, withPath) {
  const { name, main, type, imports, exports } = pkg.data;
  const text = value => value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
  const result = [
    typeof name === 'string' ? name : undefined,
    typeof main === 'string' ? main : undefined,
    type === 'commonjs' || type === 'module' ? type : 'none',
    text(imports),
    text(exports),
  ];
  if (withPath) result.push(pkg.filename);
  return result;
}

// BindingData::TraverseParent starts at the path itself when it ends in a separator,
// at its directory otherwise.
function startDirectory(checkPath) {
  const last = checkPath[checkPath.length - 1];
  if (last === '/' || (process.platform === 'win32' && last === '\\')) return checkPath.slice(0, -1);
  return path.dirname(checkPath);
}

// BindingData::ReadPackageJSON: undefined for a file that is not there.
function readPackageJSON(jsonPath, isESM, base, specifier) {
  const importing = isESM && base !== undefined ? (specifier !== undefined ? `"${specifier}" from ${base}` : base) : undefined;
  const pkg = path.basename(jsonPath) === 'package.json' ? host.loader.readPackage(path.dirname(jsonPath), importing) : null;
  return pkg ? serialize(pkg, false) : undefined;
}

function getNearestParentPackageJSON(checkPath) {
  const pkg = host.loader.packageScopeAt(startDirectory(`${checkPath}`));
  return pkg ? serialize(pkg, true) : undefined;
}

function getNearestParentPackageJSONType(checkPath) {
  const pkg = host.loader.packageScopeAt(startDirectory(`${checkPath}`));
  return pkg ? serialize(pkg, false)[2] : 'none';
}

// BindingData::GetPackageScopeConfig: the nearest package.json at or above a URL, up to
// a node_modules directory, or the path of the last one looked for.
function getPackageScopeConfig(resolved) {
  const { URL, fileURLToPath } = require('internal/url');
  let packageJSONUrl = new URL('./package.json', resolved);
  let packageJSONPath;
  for (;;) {
    packageJSONPath = fileURLToPath(packageJSONUrl);
    if (packageJSONPath.endsWith(`node_modules${path.sep}package.json`)) break;
    const pkg = host.loader.readPackage(path.dirname(packageJSONPath), resolved);
    if (pkg) return serialize(pkg, true);
    const parent = new URL('../package.json', packageJSONUrl);
    if (fileURLToPath(parent) === packageJSONPath) break;
    packageJSONUrl = parent;
  }
  return packageJSONPath;
}

function getPackageType(url) {
  const result = getPackageScopeConfig(`${url}`);
  return Array.isArray(result) && result[2] !== 'none' ? result[2] : undefined;
}

module.exports = {
  readPackageJSON, getNearestParentPackageJSON, getNearestParentPackageJSONType,
  getPackageScopeConfig, getPackageType,
};
