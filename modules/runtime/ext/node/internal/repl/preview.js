'use strict';

const { cursorTo, moveCursor, clearLine } = require('readline');
const { kIsMultiline } = require('internal/readline/interface');
const { getStringWidth } = require('internal/readline/width');
const { isValidSyntax } = require('internal/repl/syntax');

// The evaluator owns retained engine values. Only its inert, bounded text crosses
// into the renderer: neither the REPL writer nor user inspection hooks run here.
function setupPreview(repl, active, strict) {
  if (!active || !repl.terminal || process.env.TERM === 'dumb') return null;
  const evaluator = require('internal/repl/preview_evaluator');
  let timer;
  let retained = null;
  let source = null;
  let context;
  let drawn = null;
  let stopped = false;
  let editing = false;

  function erase() {
    if (drawn === null) return;
    const { rows, cols } = drawn;
    drawn = null;
    moveCursor(repl.output, 0, rows);
    clearLine(repl.output, 0);
    cursorTo(repl.output, cols);
    moveCursor(repl.output, 0, -rows);
  }

  function cancel() {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    erase();
    const previous = retained;
    retained = null;
    source = null;
    context = undefined;
    if (previous !== null) evaluator.release(previous.token);
  }

  function eligible() {
    return !stopped && !repl.closed && !repl._closeScheduled &&
      !repl._evaluating && !repl.editorMode && !repl._bufferedCommand &&
      !repl[kIsMultiline] && repl.isCompletionEnabled && !repl.paused &&
      repl.line.trim() !== '' && !/^\s*\.[a-zA-Z]/.test(repl.line);
  }

  function render(text) {
    if (drawn !== null || text === source.trim() ||
        (text === 'undefined' && (!repl.useColors || repl.ignoreUndefined))) return;
    // Never let a value inject terminal controls, even when it contains an ESC
    // or a C1 control. The native formatter has already quoted string values.
    text = text.replace(/[\r\n\v].*$/s, '').replace(/[\x00-\x1f\x7f-\x9f]/g, character =>
      '\\x' + character.charCodeAt(0).toString(16).padStart(2, '0'));
    const prefix = repl.useColors ? '' : '// ';
    const columns = Math.max(0, Math.min(repl.columns || 80, 250) - 1 - prefix.length);
    if (!columns) return;
    if (getStringWidth(text) > columns) {
      const suffix = '.'.repeat(Math.min(3, columns));
      let remaining = columns - suffix.length;
      let shortened = '';
      for (const character of text) {
        remaining -= getStringWidth(character);
        if (remaining < 0) break;
        shortened += character;
      }
      text = shortened + suffix;
    }
    const end = repl._getDisplayPos(repl.getPrompt() + repl.line);
    const cursor = repl.getCursorPos();
    const rows = end.rows - cursor.rows;
    moveCursor(repl.output, 0, rows);
    const display = repl.useColors ? `\x1b[90m${text}\x1b[39m` : prefix + text;
    repl.output.write(`\n${display}`);
    cursorTo(repl.output, cursor.cols);
    moveCursor(repl.output, 0, -rows - 1);
    drawn = { rows: rows + 1, cols: cursor.cols };
  }

  function show() {
    timer = undefined;
    if (!eligible()) { cancel(); return; }
    const line = repl.line;
    const realm = repl.useGlobal ? undefined : repl.context;
    if (source !== line || context !== realm) {
      cancel();
      source = line;
      context = realm;
      let expression = line.trim();
      if (expression[0] === '{' && !expression.endsWith(';') && isValidSyntax(expression)) {
        expression = `(${expression})`;
      }
      if (strict()) expression = `'use strict'; void 0;\n${expression}`;
      // Exactly one evaluation, including object-literal input. The native
      // deadline is necessary because a JS timer cannot interrupt evaluation.
      try { retained = evaluator.evaluate(expression, realm, 333); }
      catch { retained = null; }
    }
    if (retained !== null) render(retained.text);
  }

  function schedule() {
    if (editing) return;
    if (!eligible()) { cancel(); return; }
    if (source !== null && (source !== repl.line || context !== (repl.useGlobal ? undefined : repl.context))) cancel();
    if (timer === undefined) timer = setTimeout(show, 0);
  }

  const refresh = repl._refreshLine;
  repl._refreshLine = function refreshPreview(...args) {
    erase();
    const result = refresh.apply(this, args);
    schedule();
    return result;
  };
  const clear = repl.clearLine;
  repl.clearLine = function clearPreviewLine(...args) {
    cancel();
    return clear.apply(this, args);
  };
  const resume = repl.resume;
  repl.resume = function resumePreview(...args) {
    const result = resume.apply(this, args);
    schedule();
    return result;
  };
  repl.on('reset', cancel);
  repl.on('close', () => { stopped = true; cancel(); });

  return {
    cancel,
    beforeKey(key) {
      editing = true;
      erase();
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (key.name === 'escape' || key.name === 'return' || key.name === 'enter' ||
          (key.ctrl && (key.name === 'c' || key.name === 'd' || key.name === 'z'))) cancel();
    },
    afterKey(key) {
      editing = false;
      if (key.name !== 'escape' && !(key.ctrl && (key.name === 'c' || key.name === 'z'))) schedule();
    },
  };
}

module.exports = { setupPreview };
