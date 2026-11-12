'use strict';

// A conservative lexical scanner: it never evaluates a CommonJS module while
// constructing its ESM namespace. Dynamic/computed export names are not inferred.
function tokens(source) {
  const result = [];
  let i = 0;
  let previous = '';
  const simpleEscapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
  const regexPrefix = new Set(['', '=', '(', '[', '{', ',', ':', ';', '!', '?', '&&', '||', 'return', 'throw', 'case', '=>']);
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let value = '';
      let valid = true;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          i++;
          const escaped = source[i++];
          if (escaped === undefined) valid = false;
          else if (Object.hasOwn(simpleEscapes, escaped)) value += simpleEscapes[escaped];
          else if (escaped === 'x' || escaped === 'u') {
            // \xHH, \uHHHH and \u{H...}, as the string literal itself means them.
            let digits;
            if (escaped === 'u' && source[i] === '{') {
              const close = source.indexOf('}', i);
              digits = close < 0 ? '' : source.slice(i + 1, close);
              i = close < 0 ? source.length : close + 1;
            } else {
              digits = source.slice(i, i + (escaped === 'x' ? 2 : 4));
              i += digits.length;
              if (digits.length !== (escaped === 'x' ? 2 : 4)) digits = '';
            }
            const code = /^[0-9a-fA-F]+$/.test(digits) ? parseInt(digits, 16) : NaN;
            if (code <= 0x10ffff) value += String.fromCodePoint(code); else valid = false;
          } else if (escaped === '0' && !/[0-9]/.test(source[i] || '')) value += '\0';
          else if (/[0-9]/.test(escaped)) valid = false;
          else if (escaped === '\r') { if (source[i] === '\n') i++; }
          else if (escaped !== '\n' && escaped !== '\u2028' && escaped !== '\u2029') value += escaped;
        } else value += source[i++];
      }
      i++;
      // Like cjs-module-lexer, a name that is not well-formed UTF-16 is no export.
      result.push({ text: '<string>', value: valid && value.isWellFormed() ? value : undefined });
      previous = '<string>';
      continue;
    }
    if (c === '`') {
      // Template expressions are deliberately not scanned for export assignments.
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === '`') break;
      }
      result.push({ text: '<template>' });
      previous = '<template>';
      continue;
    }
    if (c === '/' && regexPrefix.has(previous)) {
      i++;
      let characterClass = false;
      while (i < source.length) {
        const ch = source[i++];
        if (ch === '\\') { i++; continue; }
        if (ch === '[') characterClass = true;
        else if (ch === ']') characterClass = false;
        else if (ch === '/' && !characterClass) break;
        else if (ch === '\n') break;
      }
      while (i < source.length && /[a-z]/i.test(source[i])) i++;
      previous = '<regex>';
      result.push({ text: previous });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      previous = source.slice(start, i);
    } else {
      const pair = source.slice(i, i + 2);
      if (['=>', '==', '!=', '+=', '-=', '&&', '||', '??', '?.'].includes(pair)) {
        previous = pair;
        i += 2;
      } else { previous = c; i++; }
    }
    result.push({ text: previous });
  }
  return result;
}

// What compilers emit for `export * from 'x'`, which Node also counts as re-exports:
// TypeScript's `__exportStar(require('x'), exports)` and `__export(require('x'))`, and
// the Babel/TypeScript loop over `var _x = require('x')`:
//   Object.keys(_x).forEach(function (key) { ...; exports[key] = _x[key]; })
// (or the same loop defining exports[key] with Object.defineProperty).
function starReexports(list, text, name, reexports) {
  const literal = i => (text(i) === '<string>' ? list[i].value : undefined);
  const required = new Map();
  for (let i = 0; i < list.length; i++) {
    if ((text(i) === 'var' || text(i) === 'let' || text(i) === 'const') && name(i + 1) !== undefined &&
        text(i + 2) === '=' && text(i + 3) === 'require' && text(i + 4) === '(' && literal(i + 5) !== undefined &&
        text(i + 6) === ')') required.set(text(i + 1), literal(i + 5));
  }
  for (let i = 0; i < list.length; i++) {
    if ((text(i) === '__exportStar' || text(i) === '__export') && text(i + 1) === '(' && text(i + 2) === 'require' &&
        text(i + 3) === '(' && literal(i + 4) !== undefined && text(i + 5) === ')') {
      reexports.add(literal(i + 4));
      continue;
    }
    if (text(i) !== 'Object' || text(i + 1) !== '.' || text(i + 2) !== 'keys' || text(i + 3) !== '(' ||
        !required.has(text(i + 4)) || text(i + 5) !== ')' || text(i + 6) !== '.' || text(i + 7) !== 'forEach' ||
        text(i + 8) !== '(' || text(i + 9) !== 'function' || text(i + 10) !== '(' || name(i + 11) === undefined ||
        text(i + 12) !== ')' || text(i + 13) !== '{') continue;
    const binding = text(i + 4);
    const key = text(i + 11);
    let depth = 0;
    let copies = false;
    for (let j = i + 13; j < list.length; j++) {
      const t = text(j);
      if (t === '{') depth++;
      else if (t === '}' && --depth === 0) break;
      if (t === 'exports' && text(j - 1) !== '.' && text(j + 1) === '[' && text(j + 2) === key && text(j + 3) === ']' &&
          text(j + 4) === '=' && text(j + 5) === binding && text(j + 6) === '[' && text(j + 7) === key) copies = true;
      if (t === 'Object' && text(j + 1) === '.' && text(j + 2) === 'defineProperty' && text(j + 3) === '(' &&
          text(j + 4) === 'exports' && text(j + 5) === ',' && text(j + 6) === key) copies = true;
    }
    if (copies) reexports.add(required.get(binding));
  }
}

function analyzeExports(source) {
  const list = tokens(source);
  const names = new Set();
  const reexports = new Set();
  const text = (i) => list[i] && list[i].text;
  const name = (i) => list[i] && (list[i].value === undefined ? (/^[A-Za-z_$][\w$]*$/.test(list[i].text) ? list[i].text : undefined) : list[i].value);
  function exportEnd(i) {
    if (text(i - 1) === '.' || text(i - 1) === '?.') return -1;
    if (text(i) === 'exports') return i + 1;
    if (text(i) === 'module' && text(i + 1) === '.' && text(i + 2) === 'exports') return i + 3;
    return -1;
  }
  const identifier = (i) => list[i] !== undefined && list[i].value === undefined && /^[A-Za-z_$][\w$]*$/.test(list[i].text);
  // cjs-module-lexer's object literal rule: keys whose values are plain identifiers,
  // shorthand keys and `...require('x')` spreads. Anything else ends the scan, keeping
  // the names found before it.
  function objectLiteral(j) {
    for (;;) {
      if (identifier(j) || text(j) === '<string>') {
        const key = j++;
        const valued = text(j) === ':';
        if (valued) {
          if (!identifier(j + 1)) return;
          j += 2;
        }
        if ((valued || identifier(key)) && name(key) !== undefined) names.add(name(key));
      } else if (text(j) === '.' && text(j + 1) === '.' && text(j + 2) === '.') {
        j += 3;
        if (text(j) === 'require' && text(j + 1) === '(' && text(j + 2) === '<string>' && text(j + 3) === ')') {
          if (name(j + 2) !== undefined) reexports.add(name(j + 2));
          j += 4;
        } else if (identifier(j)) j++;
        else return;
      } else return;
      if (text(j) !== ',') return;
      j++;
    }
  }
  for (let i = 0; i < list.length; i++) {
    let end = exportEnd(i);
    if (end !== -1) {
      if (text(end) === '.' && text(end + 2) === '=' && name(end + 1) !== undefined) names.add(name(end + 1));
      if (text(end) === '[' && text(end + 1) === '<string>' && text(end + 2) === ']' && text(end + 3) === '=' && name(end + 1) !== undefined) names.add(name(end + 1));
      if (text(i) === 'module' && text(end) === '=' && text(end + 1) === 'require' && text(end + 2) === '(' && text(end + 3) === '<string>' && text(end + 4) === ')' && name(end + 3) !== undefined) reexports.add(name(end + 3));
      if (text(i) === 'module' && text(end) === '=' && text(end + 1) === '{') objectLiteral(end + 2);
    }
    if (text(i) === 'Object' && text(i + 1) === '.' && text(i + 2) === 'defineProperty' && text(i + 3) === '(') {
      end = exportEnd(i + 4);
      if (end !== -1 && text(end) === ',' && text(end + 1) === '<string>' && name(end + 1) !== undefined) names.add(name(end + 1));
    }
  }
  starReexports(list, text, name, reexports);
  names.delete('default');
  names.delete('module.exports');
  return { names: Array.from(names), reexports: Array.from(reexports) };
}

module.exports = { analyzeExports };
