'use strict';

const { validateString } = require('internal/util_public/support');
const trim = value => value.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
// UTF-8 std::map ordering is Unicode scalar ordering, not UTF-16 ordering.
function compareKeys(a, b) {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i), y = b.codePointAt(j);
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}
function parseEnv(content) {
  validateString(content, 'content');
  // Node's native parser receives a UTF-8 string (including replacement of
  // unpaired surrogates), and removes every CR, including those in quotes.
  content = trim(content.toWellFormed().replace(/\r/g, ''));
  const store = new Map();
  while (content.length) {
    if (content[0] === '\n' || content[0] === '#') {
      const newline = content.indexOf('\n');
      content = newline < 0 ? '' : content.slice(newline + 1);
      continue;
    }
    const equalOrNewline = content.search(/[=\n]/);
    if (equalOrNewline < 0) break;
    if (content[equalOrNewline] === '\n') {
      content = trim(content.slice(equalOrNewline + 1));
      continue;
    }
    let key = trim(content.slice(0, equalOrNewline));
    content = content.slice(equalOrNewline + 1);
    if (!content.length || content[0] === '\n') {
      store.set(key, '');
      continue;
    }
    content = trim(content);
    if (!key.length) continue;
    if (key.startsWith('export ')) key = trim(key.slice(7));
    if (!content.length) { store.set(key, ''); break; }
    const quote = content[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      const closingQuote = content.indexOf(quote, 1);
      if (closingQuote >= 0) {
        let value = content.slice(1, closingQuote);
        if (quote === '"') value = value.replace(/\\n/g, '\n');
        store.set(key, value);
        const newline = content.indexOf('\n', closingQuote + 1);
        content = newline < 0 ? '' : content.slice(newline + 1);
        continue;
      }
      const newline = content.indexOf('\n');
      if (newline < 0) { store.set(key, content); break; }
      store.set(key, content.slice(0, newline));
      content = content.slice(newline + 1);
    } else {
      const newline = content.indexOf('\n');
      let value = newline < 0 ? content : content.slice(0, newline);
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash);
      store.set(key, trim(value));
      content = newline < 0 ? '' : content.slice(newline + 1);
    }
    content = trim(content);
  }
  const result = {};
  for (const key of Array.from(store.keys()).sort(compareKeys)) result[key] = store.get(key);
  return result;
}
module.exports = { parseEnv };
